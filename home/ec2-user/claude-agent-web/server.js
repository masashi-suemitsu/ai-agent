const express = require('express');
const http = require('http');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const Database = require('better-sqlite3');

const { google } = require('googleapis');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const HOME = process.env.HOME || '/home/ec2-user';
const DB_PATH = path.join(HOME, 'claude-agent-web', 'audit.db');
const ALLOWED_DOMAIN = 'acrovision.co.jp';
const KANRI_SA_KEY = process.env.KANRI_DRIVE_SA_KEY || path.join(HOME, 'kanri-drive-sa.json');

// ── ロール管理 ──
// 環境変数 ROLE_MAP: "email:role,email:role,..." で定義
// roles: admin / gyoumu / eigyo / recruit / user
function getUserRole(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  if (adminEmails.includes(email)) return 'admin';
  const map = {};
  (process.env.ROLE_MAP || '').split(',').forEach(pair => {
    const [e, r] = pair.trim().split(':');
    if (e && r) map[e.trim()] = r.trim();
  });
  return map[email] || 'user';
}

// ロール別 fetch_corp_api 許可アクション
const CORP_API_ALLOWED = {
  admin:   ['employees','cases','contracts','geppo','candidates','attendance','follow_signals','query'],
  gyoumu:  ['employees','contracts','attendance','geppo','follow_signals','query'],
  eigyo:   ['employees','cases','geppo'],
  recruit: ['candidates','employees'],
  user:    []
};

// ロール別利用可能ツール名セット
const TOOLS_FOR_ROLE = {
  admin:   null, // null = 全ツール
  gyoumu:  new Set(['query_corp_db','list_kintone_records','call_oss_ai','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','get_kot_daily','get_kot_monthly','list_drive_files','read_drive_file','fetch_corp_api','fetch_corp_page']),
  eigyo:   new Set(['list_kintone_records','search_hotprofile','list_wp_posts','create_wp_post','call_oss_ai','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','list_drive_files','read_drive_file','fetch_corp_api','fetch_corp_page']),
  recruit: new Set(['list_kintone_records','search_hotprofile','call_oss_ai','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','list_drive_files','read_drive_file','fetch_corp_api','fetch_corp_page']),
  user:    new Set(['call_oss_ai','list_chatwork_rooms','get_chatwork_messages','list_drive_files','read_drive_file'])
};

app.set('trust proxy', 1);

// ── DB 初期化 ──
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now','localtime')),
    email TEXT NOT NULL,
    name TEXT,
    action TEXT NOT NULL,
    details TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON audit_logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_email ON audit_logs(email);

  CREATE TABLE IF NOT EXISTS user_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    steps TEXT,
    shared INTEGER DEFAULT 0,
    run_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(owner_email, name)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    title TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    skill_title TEXT,
    status TEXT DEFAULT 'running',
    result TEXT,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_conv_email ON conversations(user_email, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_run_email ON task_runs(user_email, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_skill_owner ON user_skills(owner_email);

  CREATE TABLE IF NOT EXISTS user_drive_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_kintone_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_chatwork_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

function audit(email, name, action, details = {}) {
  try {
    db.prepare('INSERT INTO audit_logs (email,name,action,details) VALUES (?,?,?,?)')
      .run(email || 'unknown', name || '', action, JSON.stringify(details));
  } catch(e) { console.error('audit err:', e.message); }
}

// ── Session ──
const SESSION_DB_PATH = path.join(HOME, 'claude-agent-web', 'sessions.db');
const sessionDb = new Database(SESSION_DB_PATH);
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

app.use(session({
  store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 3600000 } }),
  secret: process.env.SESSION_SECRET || 'claude-agent-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: THIRTY_DAYS }
}));

app.use(passport.initialize());
app.use(passport.session());

// ── Google OAuth ──
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    state: true
  }, (at, rt, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
      return done(null, false, { message: 'アクロビジョンのメールアドレスのみ利用できます' });
    }
    if (at) {
      try {
        db.prepare(`
          INSERT INTO user_drive_tokens (email, access_token, refresh_token, updated_at)
          VALUES (?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(email) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, refresh_token),
            updated_at = excluded.updated_at
        `).run(email, at, rt || null);
      } catch(e) { console.error('drive token save err:', e.message); }
    }
    const role = getUserRole(email);
    return done(null, { email, name: profile.displayName, picture: profile.photos?.[0]?.value, role });
  }));
}

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path === '/auth/kintone/callback') return next();
  if (req.path === '/auth/chatwork/callback') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'ログインが必要です' });
  res.redirect('/login');
}

// ── 認証不要ルート ──
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/google', (req, res, next) => {
  console.log('[auth/google] sessionID:', req.sessionID, 'session keys:', Object.keys(req.session || {}));
  next();
}, passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
  accessType: 'offline',
  prompt: 'consent',
  hd: ALLOWED_DOMAIN
}));

app.get('/auth/google/callback',
  (req, res, next) => {
    console.log('[callback] code:', !!req.query.code, 'state:', req.query.state, 'error:', req.query.error);
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login?error=1' }),
  (req, res) => { audit(req.user.email, req.user.name, 'login'); res.redirect('/'); }
);

app.get('/logout', (req, res) => {
  if (req.user) audit(req.user.email, req.user.name, 'logout');
  req.logout(() => res.redirect('/login'));
});

app.get('/api/me', (req, res) => {
  if (req.isAuthenticated()) {
    const role = req.user.role || getUserRole(req.user.email);
    return res.json({ ...req.user, role });
  }
  res.json(null);
});

// ── 認証必須ルート ──
app.use(requireAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 監査ログ閲覧 ──
app.get('/api/admin/logs', (req, res) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  const isAdmin = adminEmails.includes(req.user.email);
  const rows = isAdmin
    ? db.prepare('SELECT * FROM audit_logs ORDER BY ts DESC LIMIT 1000').all()
    : db.prepare('SELECT * FROM audit_logs WHERE email=? ORDER BY ts DESC LIMIT 200').all(req.user.email);
  res.json(rows);
});

// ── Chat API ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getSystemPrompt(role) {
  const base = `あなたは「仕事を任せるAIエージェント」です。ユーザーが依頼した業務を実際に実行します。

## 基本姿勢
- ユーザーが何かを聞いたら、まずツールでデータを取得してから回答する
- 「調べてみましょう」ではなく、即座にツールを呼び出して結果を返す
- ユーザーに「ボタンを押してください」「フォルダIDを入力してください」と案内しない。自分でツールを使う
- 不明点は1〜2個だけ端的に聞く

## 重要ルール
- Chatwork送信・WP公開は必ずユーザーに内容確認してから実行
- DBはSELECTのみ。更新系は不可
- ツールがエラーになっても代替手段があれば黙って試す。すべての手段が尽きてから初めてユーザーに報告する

## スキルの作成
手順が固まったら以下の形式で出力してください（必ずこの形式を守る）：

<skill>
{"name":"英数字ハイフンのみ","title":"タイトル（日本語OK）","description":"何をするか1行","steps":"実行手順を自然言語で詳しく記述"}
</skill>

スキル作成後は「保存しておけば次回からすぐ実行できます」と案内してください。`;

  const roleContext = {
    admin: `

## あなたの権限: 管理者（全機能）
利用可能ツール: 全ツール（DB照会・勤怠・契約・採用・Chatwork・Drive・WP・メール等）
- 勤怠API（KoT）は 8:30〜10:00 / 17:30〜18:30 JST は利用不可 → エラー時は king_of_time_attendance テーブルを自動照会
- overtime_minutes は常に0。work_minutes を使い SUM(GREATEST(work_minutes - 480, 0)) で残業計算`,

    gyoumu: `

## あなたの権限: 業務管理部
担当業務: 契約管理・勤怠管理・社員情報・月報分析・フォローシグナル確認

利用可能データ（fetch_corp_api）: employees / contracts / attendance / geppo / follow_signals / query
- 採用候補者データ（candidates）・案件データ（cases）へのアクセスは権限外
- fetch_corp_page でcorp.acrovision.jp の管理画面ページをテキストで読める

勤怠API（KoT）は 8:30〜10:00 / 17:30〜18:30 JST は利用不可
→ エラー時は自動的に fetch_corp_api(action=attendance) または query_corp_db で king_of_time_attendance を照会
→ overtime_minutes は常に0。SUM(GREATEST(work_minutes - 480, 0)) で残業を計算`,

    eigyo: `

## あなたの権限: 営業部
担当業務: 案件管理・社員情報確認・月報閲覧・名刺/人脈検索・提案書作成

利用可能データ（fetch_corp_api）: employees / cases / geppo
- 採用候補者データ（candidates）・契約詳細（contracts）・勤怠データへのアクセスは権限外
- fetch_corp_page でcorp.acrovision.jp の管理画面ページをテキストで読める

案件情報は fetch_corp_api(action=cases) で取得できる。ステータスフィルタも使える。`,

    recruit: `

## あなたの権限: 採用部
担当業務: 採用候補者管理・選考進捗確認・社員情報参照

利用可能データ（fetch_corp_api）: candidates / employees
- 案件データ（cases）・契約データ（contracts）・勤怠データへのアクセスは権限外
- fetch_corp_page でcorp.acrovision.jp の管理画面ページをテキストで読める

採用候補者は fetch_corp_api(action=candidates) で取得。stage（選考ステージ）でフィルタも可能。`,

    user: `

## あなたの権限: 一般ユーザー
利用可能ツール: Chatwork閲覧・DriveファイルIO・OSS AI呼び出し`
  };

  return base + (roleContext[role] || roleContext.user);
}

// ── Tool Definitions ──
const TOOLS = [
  {
    name: 'query_corp_db',
    description: '社内MySQL DB（corp_acro_jp）をSELECTで照会する。テーブル例: kintone_employees, kintone_contract, geppo_data, recruit_ats_candidates, king_of_time_attendance, follow_signal_pool, kintone_customers など。',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT文。プレースホルダは ? を使う' },
        params: { type: 'array', description: '?に対応するパラメータ配列', items: {} }
      },
      required: ['sql']
    }
  },
  {
    name: 'list_kintone_records',
    description: 'KintoneアプリからレコードをAPIで取得する。',
    input_schema: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'KintoneアプリID' },
        query: { type: 'string', description: 'Kintoneクエリ文字列（例: "status = \\"稼働中\\" limit 20"）' }
      },
      required: ['app_id']
    }
  },
  {
    name: 'search_hotprofile',
    description: 'HotProfileで名刺・人脈データを検索する。',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'フリーワード' },
        company: { type: 'string', description: '会社名' },
        name: { type: 'string', description: '氏名' }
      }
    }
  },
  {
    name: 'list_wp_posts',
    description: 'WordPressの投稿一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: '取得件数（デフォルト10）' },
        search: { type: 'string', description: '検索キーワード' },
        status: { type: 'string', description: 'publish / draft' }
      }
    }
  },
  {
    name: 'create_wp_post',
    description: 'WordPressに投稿を作成する（必ずユーザー確認後に実行）。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'HTML可' },
        status: { type: 'string', description: 'draft または publish' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'send_email',
    description: 'SES経由でメールを送信する（管理者のみ・ユーザー確認必須）。',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        text: { type: 'string' },
        html: { type: 'string' }
      },
      required: ['to', 'subject', 'text']
    }
  },
  {
    name: 'call_oss_ai',
    description: 'OpenRouter / DeepInfra のOSSモデル（Qwen等）を呼び出す。',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'openrouter または deepinfra' },
        model: { type: 'string', description: 'モデルID（省略時はQwen3-235B）' },
        prompt: { type: 'string' },
        max_tokens: { type: 'number' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_chatwork_rooms',
    description: 'Chatworkのルーム一覧を取得する。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_chatwork_messages',
    description: 'Chatworkの指定ルームのメッセージ履歴（最新50件）を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        force: { type: 'boolean', description: '最新を強制取得（デフォルト: true）' }
      },
      required: ['room_id']
    }
  },
  {
    name: 'send_chatwork_message',
    description: 'Chatworkのルームにメッセージを送信する（必ずユーザー確認後）。',
    input_schema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['room_id', 'body']
    }
  },
  {
    name: 'get_kot_daily',
    description: 'King of Timeの日次勤怠データを取得する。',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' }
      }
    }
  },
  {
    name: 'get_kot_monthly',
    description: 'King of Timeの月次勤怠データを取得する。',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'YYYY（省略時は今年）' },
        month: { type: 'string', description: 'MM（省略時は今月）' }
      }
    }
  },
  {
    name: 'list_drive_files',
    description: 'Google DriveのフォルダIDを指定してファイル一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' }
      },
      required: ['folder_id']
    }
  },
  {
    name: 'read_drive_file',
    description: 'Google DriveのファイルID指定でDocs/Sheets/テキストの内容を読む。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'fetch_corp_api',
    description: 'corp.acrovision.jp の社員専用データAPIにアクセスする。action: employees（社員一覧）/ cases（案件）/ contracts（契約）/ geppo（月報）/ candidates（採用候補者）/ attendance（勤怠サマリ）/ follow_signals（フォローシグナル）/ query（任意SELECT）。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'employees / cases / contracts / geppo / candidates / attendance / follow_signals / query' },
        month: { type: 'string', description: 'YYYY-MM（geppo/attendance用）' },
        status: { type: 'string', description: 'ステータスフィルタ（cases/contracts/candidates用）' },
        employee: { type: 'string', description: '社員名フィルタ（contracts用）' },
        limit: { type: 'number', description: '最大件数（デフォルト100、最大500）' },
        sql: { type: 'string', description: 'SELECT文（action=queryの時のみ）' },
        params: { type: 'array', description: 'SQLパラメータ（action=queryの時のみ）', items: {} }
      },
      required: ['action']
    }
  },
  {
    name: 'fetch_corp_page',
    description: 'corp.acrovision.jp の認証済みHTMLページをテキストで取得する。/kanri/ や /monitoring/ 等の社内管理画面の内容をAIが読む。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '/kanri/attendance.php のようなパス（先頭の/は任意）' }
      },
      required: ['path']
    }
  }
];

// ── Tool Executor ──
async function executeTool(name, input, user) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  const isAdmin = adminEmails.includes(user.email);

  switch (name) {
    case 'query_corp_db': {
      const pool = getCorpDb();
      if (!pool) throw new Error('Corp DB未設定');
      const dbRole = user.role || getUserRole(user.email);
      if (!['admin','gyoumu'].includes(dbRole)) throw new Error('DBの直接照会は業務管理部・管理者のみ許可されています');
      const { sql, params = [] } = input;
      if (DB_BLOCKED_KEYWORDS.test(sql)) throw new Error('SELECTのみ許可されています');
      audit(user.email, user.name, 'tool.db', { preview: sql.slice(0, 100) });
      const [rows] = await pool.execute(sql, params);
      return { rows: rows.slice(0, 200), count: rows.length };
    }
    case 'list_kintone_records': {
      if (!process.env.KINTONE_DOMAIN) throw new Error('Kintone未設定');
      audit(user.email, user.name, 'tool.kintone', { appId: input.app_id });
      const qs = new URLSearchParams({ app: input.app_id, query: input.query || 'limit 20' });
      return await kintoneRequest(`/records.json?${qs}`, {}, user.email);
    }
    case 'search_hotprofile': {
      if (!process.env.HOTPROFILE_API_KEY) throw new Error('HotProfile未設定');
      audit(user.email, user.name, 'tool.hotprofile', { q: input.keyword });
      const qs = new URLSearchParams();
      if (input.keyword) qs.set('keyword', input.keyword);
      if (input.company) qs.set('company_name', input.company);
      if (input.name) qs.set('name', input.name);
      return await hotprofileFetch(`contacts?${qs}`);
    }
    case 'list_wp_posts': {
      if (!process.env.WP_URL) throw new Error('WordPress未設定');
      audit(user.email, user.name, 'tool.wp_posts');
      const qs = new URLSearchParams({ per_page: String(input.per_page || 10), page: '1', status: input.status || 'publish' });
      if (input.search) qs.set('search', input.search);
      return await wpFetch(`/posts?${qs}`);
    }
    case 'create_wp_post': {
      if (!process.env.WP_URL) throw new Error('WordPress未設定');
      audit(user.email, user.name, 'tool.wp_create', { title: input.title?.slice(0, 50) });
      return await wpFetch('/posts', { method: 'POST', body: JSON.stringify({ title: input.title, content: input.content, status: input.status || 'draft' }) });
    }
    case 'send_email': {
      if (!process.env.SES_USER) throw new Error('SES未設定');
      if (!isAdmin) throw new Error('管理者のみメール送信可能です');
      audit(user.email, user.name, 'tool.email', { to: input.to, subject: input.subject?.slice(0, 50) });
      const info = await getSesTransport().sendMail({ from: process.env.SES_FROM || 'info@acrovision.co.jp', to: input.to, subject: input.subject, text: input.text, html: input.html });
      return { ok: true, messageId: info.messageId };
    }
    case 'call_oss_ai': {
      const provider = input.provider || 'openrouter';
      const apiKey = provider === 'deepinfra' ? process.env.DEEPINFRA_API_KEY : process.env.OPENROUTER_API_KEY;
      const baseUrl = provider === 'deepinfra' ? 'https://api.deepinfra.com/v1/openai' : 'https://openrouter.ai/api/v1';
      const defaultModel = provider === 'deepinfra' ? 'Qwen/Qwen3-235B-A22B' : 'qwen/qwen3-235b-a22b';
      if (!apiKey) throw new Error(`${provider}未設定`);
      audit(user.email, user.name, 'tool.oss_ai', { provider });
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.model || defaultModel, messages: [{ role: 'user', content: input.prompt }], max_tokens: input.max_tokens || 1024, stream: false })
      });
      if (!r.ok) throw new Error(`${provider} error: ${r.status}`);
      const data = await r.json();
      return { content: data.choices?.[0]?.message?.content || '', usage: data.usage };
    }
    case 'list_chatwork_rooms': {
      audit(user.email, user.name, 'tool.cw_rooms');
      return await cwFetch('/rooms', {}, user.email);
    }
    case 'get_chatwork_messages': {
      audit(user.email, user.name, 'tool.cw_msgs', { roomId: input.room_id });
      const force = input.force !== false ? '?force=1' : '';
      const msgs = await cwFetch(`/rooms/${input.room_id}/messages${force}`, {}, user.email);
      return (Array.isArray(msgs) ? msgs : []).slice(-50);
    }
    case 'send_chatwork_message': {
      audit(user.email, user.name, 'tool.cw_send', { roomId: input.room_id, preview: input.body?.slice(0, 50) });
      const params = new URLSearchParams({ body: input.body });
      return await cwFetch(`/rooms/${input.room_id}/messages`, { method: 'POST', body: params.toString() }, user.email);
    }
    case 'get_kot_daily': {
      if (!KOT_TOKEN) throw new Error('KoT未設定');
      const date = input.date || new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
      audit(user.email, user.name, 'tool.kot_daily', { date });
      return await kotFetch(`/daily-attendances?date=${date}`);
    }
    case 'get_kot_monthly': {
      if (!KOT_TOKEN) throw new Error('KoT未設定');
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const year = input.year || now.getFullYear();
      const month = String(input.month || now.getMonth() + 1).padStart(2, '0');
      audit(user.email, user.name, 'tool.kot_monthly', { year, month });
      return await kotFetch(`/monthly-attendances?year=${year}&month=${month}`);
    }
    case 'list_drive_files': {
      audit(user.email, user.name, 'tool.drive_list', { folderId: input.folder_id });
      const drive = getDriveClientForUser(user);
      const r = await drive.files.list({ q: `'${input.folder_id}' in parents and trashed=false`, fields: 'files(id,name,mimeType,modifiedTime,size)', orderBy: 'folder,name', pageSize: 100 });
      return r.data.files || [];
    }
    case 'read_drive_file': {
      audit(user.email, user.name, 'tool.drive_read', { fileId: input.file_id });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const { mimeType, name } = meta.data;
      let content = '';
      if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation') {
        const r = await drive.files.export({ fileId: input.file_id, mimeType: 'text/plain' }, { responseType: 'text' });
        content = String(r.data);
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const r = await drive.files.export({ fileId: input.file_id, mimeType: 'text/csv' }, { responseType: 'text' });
        content = String(r.data);
      } else if (mimeType && (mimeType.startsWith('text/') || mimeType === 'application/json')) {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'text' });
        content = String(r.data);
      } else {
        throw new Error(`${mimeType} は読み取り非対応です`);
      }
      return { id: input.file_id, name, mimeType, content: content.slice(0, 60000) };
    }
    case 'fetch_corp_api': {
      const corpToken = process.env.CORP_AGENT_TOKEN;
      if (!corpToken) throw new Error('CORP_AGENT_TOKEN未設定');
      const role = user.role || getUserRole(user.email);
      const allowed = CORP_API_ALLOWED[role] || [];
      if (!allowed.includes(input.action)) throw new Error(`このアクション(${input.action})へのアクセス権限がありません`);
      audit(user.email, user.name, 'tool.corp_api', { action: input.action });
      const qs = new URLSearchParams({ action: input.action });
      if (input.month)    qs.set('month', input.month);
      if (input.status)   qs.set('status', input.status);
      if (input.employee) qs.set('employee', input.employee);
      if (input.limit)    qs.set('limit', String(input.limit));
      // Node.js native fetch overrides Host header — use http module directly
      const isQuery = (input.action === 'query' && input.sql);
      const postBody = isQuery ? `action=query&sql=${encodeURIComponent(input.sql)}&params=${encodeURIComponent(JSON.stringify(input.params || []))}` : null;
      const data = await new Promise((resolve, reject) => {
        const reqOpts = {
          hostname: '172.31.9.243',
          port: 80,
          path: `/api/agent.php?${qs}`,
          method: isQuery ? 'POST' : 'GET',
          headers: {
            'Host': 'corp.acrovision.jp',
            'X-Agent-Token': corpToken,
            ...(isQuery ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postBody) } : {})
          }
        };
        const req = http.request(reqOpts, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            if (res.statusCode >= 400) return reject(new Error(`Corp API error: HTTP ${res.statusCode}`));
            try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Corp API: invalid JSON: ' + body.slice(0, 100))); }
          });
        });
        req.on('error', reject);
        if (postBody) req.write(postBody);
        req.end();
      });
      return data;
    }
    case 'fetch_corp_page': {
      const corpToken = process.env.CORP_AGENT_TOKEN;
      if (!corpToken) throw new Error('CORP_AGENT_TOKEN未設定');
      const pagePath = (input.path || '').replace(/^\/+/, '/').replace(/^([^/])/, '/$1');
      audit(user.email, user.name, 'tool.corp_page', { path: pagePath });
      const qs = new URLSearchParams({ action: 'page', path: pagePath });
      const data = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '172.31.9.243',
          port: 80,
          path: `/api/agent.php?${qs}`,
          method: 'GET',
          headers: { 'Host': 'corp.acrovision.jp', 'X-Agent-Token': corpToken }
        }, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            if (res.statusCode >= 400) return reject(new Error(`Corp page error: HTTP ${res.statusCode}`));
            try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Corp page: invalid JSON: ' + body.slice(0, 100))); }
          });
        });
        req.on('error', reject);
        req.end();
      });
      return data;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { message, conversationId } = req.body;
  const user = req.user;

  if (!message || !message.trim()) return res.status(400).json({ error: '空メッセージ' });

  audit(user.email, user.name, 'chat', { preview: message.slice(0, 100), conversationId });

  // 会話取得 or 作成
  let convId = conversationId;
  if (!convId) {
    // 新規会話作成（タイトルは最初のメッセージ先頭30文字）
    const title = message.slice(0, 30) + (message.length > 30 ? '…' : '');
    const r = db.prepare('INSERT INTO conversations (user_email, title) VALUES (?,?)').run(user.email, title);
    convId = r.lastInsertRowid;
  } else {
    // 所有確認
    const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND user_email=?').get(convId, user.email);
    if (!conv) return res.status(403).json({ error: '会話が見つかりません' });
    db.prepare("UPDATE conversations SET updated_at=datetime('now','localtime') WHERE id=?").run(convId);
  }

  // ユーザーメッセージ保存
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(convId, 'user', message);

  // 履歴取得（直近50メッセージ）
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 50').all(convId).reverse();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Conversation-Id', convId);
  res.flushHeaders();

  // 新規会話の場合 conversationId を先に送る
  if (!conversationId) {
    res.write(`data: ${JSON.stringify({ conversationId: convId })}\n\n`);
  }

  try {
    const role = user.role || getUserRole(user.email);
    const allowedToolNames = TOOLS_FOR_ROLE[role];
    const activeTools = allowedToolNames ? TOOLS.filter(t => allowedToolNames.has(t.name)) : TOOLS;
    const systemPrompt = getSystemPrompt(role);

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    let fullAssistantText = '';
    let toolRound = 0;

    while (toolRound < 10) {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        tools: activeTools,
        messages
      });

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          fullAssistantText += ev.delta.text;
          res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
        }
      }

      const finalMsg = await stream.finalMessage();
      if (finalMsg.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: finalMsg.content });

      const toolResults = [];
      for (const block of finalMsg.content) {
        if (block.type !== 'tool_use') continue;
        res.write(`data: ${JSON.stringify({ tool: block.name, status: 'running' })}\n\n`);
        try {
          const result = await executeTool(block.name, block.input, user);
          const resultStr = JSON.stringify(result).slice(0, 80000);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultStr });
          res.write(`data: ${JSON.stringify({ tool: block.name, status: 'done' })}\n\n`);
        } catch(e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
          res.write(`data: ${JSON.stringify({ tool: block.name, status: 'error', error: e.message })}\n\n`);
        }
      }
      messages.push({ role: 'user', content: toolResults });
      toolRound++;
    }

    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(convId, 'assistant', fullAssistantText);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// ── Conversations API ──

// GET /api/conversations
app.get('/api/conversations', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE user_email=? ORDER BY updated_at DESC LIMIT 50'
  ).all(req.user.email);
  res.json(rows);
});

// POST /api/conversations
app.post('/api/conversations', (req, res) => {
  const { title } = req.body;
  const r = db.prepare('INSERT INTO conversations (user_email, title) VALUES (?,?)').run(req.user.email, title || '新しい依頼');
  res.json({ id: r.lastInsertRowid });
});

// GET /api/conversations/:id/messages
app.get('/api/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND user_email=?').get(req.params.id, req.user.email);
  if (!conv) return res.status(403).json({ error: '見つかりません' });
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY id').all(req.params.id);
  res.json(msgs);
});

// DELETE /api/conversations/:id
app.delete('/api/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND user_email=?').get(req.params.id, req.user.email);
  if (!conv) return res.status(403).json({ error: '見つかりません' });
  db.prepare('DELETE FROM messages WHERE conversation_id=?').run(req.params.id);
  db.prepare('DELETE FROM conversations WHERE id=?').run(req.params.id);
  audit(req.user.email, req.user.name, 'conv.delete', { id: req.params.id });
  res.json({ ok: true });
});

// ── Skills API ──

// GET /api/skills
app.get('/api/skills', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM user_skills WHERE owner_email=? OR shared=1 ORDER BY updated_at DESC'
  ).all(req.user.email);
  res.json(rows);
});

// POST /api/skills
app.post('/api/skills', (req, res) => {
  const { name, title, description, steps, shared } = req.body;
  if (!name || !/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: 'name は英小文字・数字・ハイフンのみ' });
  if (!title) return res.status(400).json({ error: 'title は必須' });

  audit(req.user.email, req.user.name, 'skill.save', { name, title });

  try {
    db.prepare(`
      INSERT INTO user_skills (owner_email, name, title, description, steps, shared)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(owner_email, name) DO UPDATE SET
        title=excluded.title,
        description=excluded.description,
        steps=excluded.steps,
        shared=excluded.shared,
        updated_at=datetime('now','localtime')
    `).run(req.user.email, name, title, description || '', steps || '', shared ? 1 : 0);

    const skill = db.prepare('SELECT * FROM user_skills WHERE owner_email=? AND name=?').get(req.user.email, name);
    res.json({ ok: true, skill });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/skills/:id
app.delete('/api/skills/:id', (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!skill) return res.status(403).json({ error: '見つかりません' });
  db.prepare('DELETE FROM user_skills WHERE id=?').run(req.params.id);
  audit(req.user.email, req.user.name, 'skill.delete', { id: req.params.id, name: skill.name });
  res.json({ ok: true });
});

// POST /api/skills/:id/run
app.post('/api/skills/:id/run', async (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND (owner_email=? OR shared=1)').get(req.params.id, req.user.email);
  if (!skill) return res.status(404).json({ error: 'Not found' });

  audit(req.user.email, req.user.name, 'skill.run', { id: skill.id, name: skill.name });

  // task_runs に記録
  const runInsert = db.prepare('INSERT INTO task_runs (user_email, skill_name, skill_title, status) VALUES (?,?,?,?)');
  const runRow = runInsert.run(req.user.email, skill.name, skill.title, 'running');
  const runId = runRow.lastInsertRowid;

  // run_count 更新
  db.prepare("UPDATE user_skills SET run_count=run_count+1, updated_at=datetime('now','localtime') WHERE id=?").run(skill.id);

  const prompt = `# ${skill.title}\n\n${skill.description}\n\n## 実行手順\n\n${skill.steps}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  let resultBuffer = '';
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    for await (const msg of query({
      prompt,
      options: {
        allowedTools: ['Bash', 'Read'],
        permissionMode: 'bypassPermissions'
      }
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            resultBuffer += block.text;
            res.write(`data: ${JSON.stringify({ text: block.text })}\n\n`);
          } else if (block.type === 'tool_use') {
            res.write(`data: ${JSON.stringify({ tool: block.name, status: 'running' })}\n\n`);
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          if (msg.result && !resultBuffer) {
            resultBuffer = msg.result;
            res.write(`data: ${JSON.stringify({ text: msg.result })}\n\n`);
          }
        } else {
          const errMsg = (msg.errors || []).join(', ') || msg.subtype;
          res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        }
      }
    }
    db.prepare('UPDATE task_runs SET status=?, result=?, finished_at=datetime("now","localtime") WHERE id=?')
      .run('done', resultBuffer.slice(0, 2000), runId);
    res.write(`data: ${JSON.stringify({ done: true, code: 0, runId })}\n\n`);
  } catch(e) {
    db.prepare('UPDATE task_runs SET status=?, result=?, finished_at=datetime("now","localtime") WHERE id=?')
      .run('error', e.message.slice(0, 2000), runId);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, code: 1, runId })}\n\n`);
  }
  res.end();
});

// ── Task Runs API ──

// GET /api/task-runs
app.get('/api/task-runs', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM task_runs WHERE user_email=? ORDER BY started_at DESC LIMIT 100'
  ).all(req.user.email);
  res.json(rows);
});

// ── Chatwork API ──
const CW_TOKEN = process.env.CHATWORK_API_TOKEN;
const CW_BASE = 'https://api.chatwork.com/v2';
const CW_OAUTH_BASE = process.env.CHATWORK_OAUTH_BASE || 'https://kcw.kddi.ne.jp';
const CW_OAUTH_TOKEN_URL = process.env.CHATWORK_OAUTH_TOKEN_URL || 'https://oauth.chatwork.com/token';

async function refreshChatworkToken(refreshToken, email) {
  const clientId = process.env.CHATWORK_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CHATWORK_OAUTH_CLIENT_SECRET;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch(CW_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Chatwork token refresh failed: ${r.status} ${text}`);
  const data = JSON.parse(text);
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  db.prepare(`UPDATE user_chatwork_tokens SET access_token=?, expires_at=?, updated_at=datetime('now','localtime') WHERE email=?`)
    .run(data.access_token, expiresAt, email);
  return data.access_token;
}

async function cwFetch(path, options = {}, userEmail = null) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.headers || {}) };
  if (userEmail) {
    const tokenRow = db.prepare('SELECT * FROM user_chatwork_tokens WHERE email=?').get(userEmail);
    if (tokenRow?.access_token) {
      let token = tokenRow.access_token;
      if (tokenRow.expires_at && new Date(tokenRow.expires_at) <= new Date()) {
        if (tokenRow.refresh_token) {
          token = await refreshChatworkToken(tokenRow.refresh_token, userEmail);
        } else {
          throw new Error('Chatworkの認証が切れています。再連携してください。');
        }
      }
      headers['Authorization'] = `Bearer ${token}`;
    } else if (CW_TOKEN) {
      headers['X-ChatWorkToken'] = CW_TOKEN;
    } else {
      throw new Error('Chatwork未連携です。Chatworkボタンから個人連携してください。');
    }
  } else if (CW_TOKEN) {
    headers['X-ChatWorkToken'] = CW_TOKEN;
  } else {
    throw new Error('Chatwork未設定');
  }
  const res = await fetch(`${CW_BASE}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`Chatwork API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// GET /api/chatwork/rooms
app.get('/api/chatwork/rooms', async (req, res) => {
  audit(req.user.email, req.user.name, 'cw.rooms');
  try { res.json(await cwFetch('/rooms', {}, req.user.email)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chatwork/rooms/:id/messages?force=1
app.get('/api/chatwork/rooms/:id/messages', async (req, res) => {
  audit(req.user.email, req.user.name, 'cw.messages', { roomId: req.params.id });
  try {
    const force = req.query.force === '1' ? '?force=1' : '';
    res.json(await cwFetch(`/rooms/${req.params.id}/messages${force}`, {}, req.user.email));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chatwork/rooms/:id (room info)
app.get('/api/chatwork/rooms/:id', async (req, res) => {
  try { res.json(await cwFetch(`/rooms/${req.params.id}`, {}, req.user.email)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chatwork/rooms/:id/messages  body: { body }
app.post('/api/chatwork/rooms/:id/messages', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'bodyは必須' });
  audit(req.user.email, req.user.name, 'cw.send', { roomId: req.params.id, preview: body.slice(0, 50) });
  try {
    const params = new URLSearchParams({ body });
    res.json(await cwFetch(`/rooms/${req.params.id}/messages`, { method: 'POST', body: params.toString() }, req.user.email));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chatwork/me
app.get('/api/chatwork/me', async (req, res) => {
  try { res.json(await cwFetch('/me', {}, req.user.email)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Chatwork OAuth ──
app.get('/auth/chatwork', (req, res) => {
  const clientId = process.env.CHATWORK_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(503).send('CHATWORK_OAUTH_CLIENT_IDが未設定です。環境変数を確認してください。');
  const callbackUrl = process.env.CHATWORK_CALLBACK_URL;
  const state = Buffer.from(req.user.email).toString('base64url');
  const scopes = 'offline_access rooms.all:read rooms.messages:write users.profile.me:read';
  const authUrl = `${CW_OAUTH_BASE}/packages/oauth2/login.php`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(callbackUrl)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&state=${state}`;
  console.log('[auth/chatwork] redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/chatwork/callback', async (req, res) => {
  const { code, error, state } = req.query;
  console.log('[chatwork/callback] called', { code: !!code, error, state: !!state, auth: req.isAuthenticated() });
  if (error || !code) return res.redirect('/?chatwork_error=1');
  let userEmail = req.user?.email;
  if (!userEmail && state) {
    try { userEmail = Buffer.from(state, 'base64url').toString('utf8'); } catch(e) {}
  }
  if (!userEmail || !userEmail.endsWith('@acrovision.co.jp')) return res.redirect('/login');
  const callbackUrl = process.env.CHATWORK_CALLBACK_URL;
  try {
    const clientId = process.env.CHATWORK_OAUTH_CLIENT_ID;
    const clientSecret = process.env.CHATWORK_OAUTH_CLIENT_SECRET;
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(CW_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl })
    });
    const resText = await r.text();
    if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${resText}`);
    const data = JSON.parse(resText);
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    db.prepare(`INSERT INTO user_chatwork_tokens (email, access_token, refresh_token, expires_at) VALUES (?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at, updated_at=datetime('now','localtime')`)
      .run(userEmail, data.access_token, data.refresh_token || '', expiresAt);
    audit(userEmail, '', 'chatwork.oauth.connect');
    res.redirect('/?chatwork_connected=1');
  } catch(e) {
    console.error('[chatwork/callback] error:', e.message);
    res.redirect('/?chatwork_error=1');
  }
});

// GET /api/chatwork/status
app.get('/api/chatwork/status', (req, res) => {
  const row = db.prepare('SELECT expires_at, updated_at FROM user_chatwork_tokens WHERE email=?').get(req.user.email);
  if (!row) return res.json({ connected: false });
  const expired = row.expires_at ? new Date(row.expires_at) <= new Date() : false;
  res.json({ connected: true, expired, updatedAt: row.updated_at });
});

// DELETE /api/chatwork/disconnect
app.delete('/api/chatwork/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_chatwork_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'chatwork.oauth.disconnect');
  res.json({ ok: true });
});

// ── King of Time API ──
const KOT_TOKEN = process.env.KOT_API_TOKEN;
const KOT_BASE = 'https://api.kingtime.jp/v1.0';
const KOT_BLOCKED = [[8,30,10,0],[17,30,18,30]]; // JST禁止帯

function kotIsBlocked() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const h = now.getHours(), m = now.getMinutes(), total = h * 60 + m;
  return KOT_BLOCKED.some(([sh,sm,eh,em]) => total >= sh*60+sm && total < eh*60+em);
}

async function kotFetch(path) {
  if (kotIsBlocked()) throw new Error('KingOfTime APIは現在利用禁止時間帯です（8:30〜10:00 / 17:30〜18:30 JST）');
  const res = await fetch(`${KOT_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${KOT_TOKEN}`, 'Content-Type': 'application/json' }
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message || `KoT error ${res.status}`);
  return json;
}

// GET /api/kot/employees
app.get('/api/kot/employees', async (req, res) => {
  if (!KOT_TOKEN) return res.status(503).json({ error: 'KoT未設定' });
  audit(req.user.email, req.user.name, 'kot.employees');
  try { res.json(await kotFetch('/employees?limit=500')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/kot/attendances?date=YYYY-MM-DD  日次勤怠
app.get('/api/kot/attendances', async (req, res) => {
  if (!KOT_TOKEN) return res.status(503).json({ error: 'KoT未設定' });
  const date = req.query.date || new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
  audit(req.user.email, req.user.name, 'kot.attendances', { date });
  try { res.json(await kotFetch(`/daily-attendances?date=${date}`)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/kot/monthly?year=YYYY&month=MM  月次勤怠
app.get('/api/kot/monthly', async (req, res) => {
  if (!KOT_TOKEN) return res.status(503).json({ error: 'KoT未設定' });
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const year = req.query.year || now.getFullYear();
  const month = String(req.query.month || now.getMonth() + 1).padStart(2, '0');
  audit(req.user.email, req.user.name, 'kot.monthly', { year, month });
  try { res.json(await kotFetch(`/monthly-attendances?year=${year}&month=${month}`)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Corp DB (MySQL read-only) ──
let corpDbPool = null;
function getCorpDb() {
  if (!corpDbPool && process.env.CORP_DB_HOST) {
    corpDbPool = mysql.createPool({
      host: process.env.CORP_DB_HOST,
      user: process.env.CORP_DB_USER,
      password: process.env.CORP_DB_PASS,
      database: process.env.CORP_DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      ssl: { rejectUnauthorized: false }
    });
  }
  return corpDbPool;
}

// POST /api/db/query  body: { sql, params }
const DB_BLOCKED_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
app.post('/api/db/query', async (req, res) => {
  const pool = getCorpDb();
  if (!pool) return res.status(503).json({ error: 'Corp DB未設定' });
  const { sql, params = [] } = req.body;
  if (!sql) return res.status(400).json({ error: 'sql is required' });
  if (DB_BLOCKED_KEYWORDS.test(sql)) return res.status(403).json({ error: '読み取り専用です（SELECT のみ許可）' });
  audit(req.user.email, req.user.name, 'db.query', { preview: sql.slice(0, 100) });
  try {
    const [rows] = await pool.execute(sql, params);
    res.json({ rows, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/db/tables
app.get('/api/db/tables', async (req, res) => {
  const pool = getCorpDb();
  if (!pool) return res.status(503).json({ error: 'Corp DB未設定' });
  try {
    const [rows] = await pool.execute('SHOW TABLES');
    res.json(rows.map(r => Object.values(r)[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Kintone API ──
async function refreshKintoneToken(refreshToken, email) {
  const domain = process.env.KINTONE_DOMAIN;
  const r = await fetch(`https://${domain}.cybozu.com/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.KINTONE_OAUTH_CLIENT_ID,
      client_secret: process.env.KINTONE_OAUTH_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error('Kintoneトークンの更新に失敗しました。再連携してください。');
  const data = await r.json();
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  db.prepare(`UPDATE user_kintone_tokens SET access_token=?, refresh_token=?, expires_at=?, updated_at=datetime('now','localtime') WHERE email=?`)
    .run(data.access_token, data.refresh_token || refreshToken, expiresAt, email);
  return data.access_token;
}

async function kintoneRequest(path, options = {}, userEmail = null) {
  const domain = process.env.KINTONE_DOMAIN;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  if (userEmail) {
    const tokenRow = db.prepare('SELECT * FROM user_kintone_tokens WHERE email=?').get(userEmail);
    if (tokenRow?.access_token) {
      if (tokenRow.expires_at && new Date(tokenRow.expires_at) <= new Date()) {
        if (tokenRow.refresh_token) {
          const newToken = await refreshKintoneToken(tokenRow.refresh_token, userEmail);
          headers['Authorization'] = `Bearer ${newToken}`;
        } else {
          throw new Error('Kintoneの認証が切れています。再連携してください。');
        }
      } else {
        headers['Authorization'] = `Bearer ${tokenRow.access_token}`;
      }
    }
  }

  if (!headers['Authorization']) {
    if (!process.env.KINTONE_USER) throw new Error('Kintone未連携 — 画面右上のKintoneボタンから連携してください');
    const token = Buffer.from(`${process.env.KINTONE_USER}:${process.env.KINTONE_PASS}`).toString('base64');
    headers['X-Cybozu-Authorization'] = token;
  }

  const r = await fetch(`https://${domain}.cybozu.com/k/v1${path}`, { ...options, headers });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `Kintone error ${r.status}`);
  return data;
}

// ── Kintone OAuth ──
app.get('/auth/kintone', (req, res) => {
  const domain = process.env.KINTONE_DOMAIN;
  const clientId = process.env.KINTONE_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(503).send('KINTONE_OAUTH_CLIENT_IDが未設定です。環境変数を確認してください。');
  const callbackUrl = process.env.KINTONE_CALLBACK_URL;
  const state = Buffer.from(req.user.email).toString('base64url');
  // スコープは%20区切りで明示的にエンコード
  const authUrl = `https://${domain}.cybozu.com/oauth2/authorization`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(callbackUrl)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent('k:app_record:read')}`
    + `&state=${state}`;
  console.log('[auth/kintone] redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/kintone/callback', async (req, res) => {
  const { code, error, state } = req.query;
  console.log('[kintone/callback] called', { code: !!code, error, state: !!state, auth: req.isAuthenticated() });
  if (error || !code) {
    console.log('[kintone/callback] no code, error:', error);
    return res.redirect('/?kintone_error=1');
  }
  // stateからメールアドレスを復元
  let userEmail = req.user?.email;
  if (!userEmail && state) {
    try { userEmail = Buffer.from(state, 'base64url').toString('utf8'); } catch(e) {}
  }
  if (!userEmail || !userEmail.endsWith('@acrovision.co.jp')) {
    console.log('[kintone/callback] invalid user email:', userEmail);
    return res.redirect('/login');
  }
  const domain = process.env.KINTONE_DOMAIN;
  const callbackUrl = process.env.KINTONE_CALLBACK_URL;
  console.log('[kintone/callback] exchanging code for', userEmail);
  try {
    const clientId = process.env.KINTONE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.KINTONE_OAUTH_CLIENT_SECRET;
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(`https://${domain}.cybozu.com/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl
      })
    });
    const resText = await r.text();
    console.log('[kintone/callback] token response:', r.status, resText.slice(0, 200));
    if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${resText}`);
    const data = JSON.parse(resText);
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    db.prepare(`
      INSERT INTO user_kintone_tokens (email, access_token, refresh_token, expires_at)
      VALUES (?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET
        access_token=excluded.access_token,
        refresh_token=excluded.refresh_token,
        expires_at=excluded.expires_at,
        updated_at=datetime('now','localtime')
    `).run(userEmail, data.access_token, data.refresh_token || '', expiresAt);
    audit(userEmail, '', 'kintone.oauth.connect');
    res.redirect('/?kintone_connected=1');
  } catch(e) {
    console.error('[kintone/callback] error:', e.message);
    res.redirect('/?kintone_error=1');
  }
});

// GET /api/kintone/status
app.get('/api/kintone/status', (req, res) => {
  const row = db.prepare('SELECT expires_at, updated_at FROM user_kintone_tokens WHERE email=?').get(req.user.email);
  if (!row) return res.json({ connected: false });
  const expired = row.expires_at ? new Date(row.expires_at) <= new Date() : false;
  res.json({ connected: true, expired, updatedAt: row.updated_at });
});

// DELETE /api/kintone/disconnect
app.delete('/api/kintone/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_kintone_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'kintone.oauth.disconnect');
  res.json({ ok: true });
});

// GET /api/kintone/apps
app.get('/api/kintone/apps', async (req, res) => {
  if (!process.env.KINTONE_DOMAIN) return res.status(503).json({ error: 'Kintone未設定' });
  audit(req.user.email, req.user.name, 'kintone.apps');
  try { res.json(await kintoneRequest('/apps.json', {}, req.user.email)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/kintone/apps/:id/records?query=xxx&fields=xxx
app.get('/api/kintone/apps/:id/records', async (req, res) => {
  if (!process.env.KINTONE_DOMAIN) return res.status(503).json({ error: 'Kintone未設定' });
  const { query = '', fields = '' } = req.query;
  const appId = req.params.id;
  audit(req.user.email, req.user.name, 'kintone.records', { appId, query: query.slice(0, 50) });
  try {
    const qs = new URLSearchParams({ app: appId, query: query || 'limit 20' });
    if (fields) qs.set('fields', fields);
    res.json(await kintoneRequest(`/records.json?${qs}`, {}, req.user.email));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HotProfile API ──
async function hotprofileFetch(path, options = {}) {
  const base = process.env.HOTPROFILE_BASE_URL || 'https://hammock.hotprofile.biz/rest_api/v1/';
  const r = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'X-HP-API-KEY': process.env.HOTPROFILE_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`HotProfile error: ${r.status} ${await r.text()}`);
  return r.json();
}

// GET /api/hotprofile/search?q=xxx
app.get('/api/hotprofile/search', async (req, res) => {
  if (!process.env.HOTPROFILE_API_KEY) return res.status(503).json({ error: 'HotProfile未設定' });
  const { q, company, name } = req.query;
  audit(req.user.email, req.user.name, 'hotprofile.search', { q });
  try {
    const qs = new URLSearchParams();
    if (q) qs.set('keyword', q);
    if (company) qs.set('company_name', company);
    if (name) qs.set('name', name);
    res.json(await hotprofileFetch(`contacts?${qs}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hotprofile/contacts/:id
app.get('/api/hotprofile/contacts/:id', async (req, res) => {
  if (!process.env.HOTPROFILE_API_KEY) return res.status(503).json({ error: 'HotProfile未設定' });
  audit(req.user.email, req.user.name, 'hotprofile.contact', { id: req.params.id });
  try { res.json(await hotprofileFetch(`contacts/${req.params.id}`)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WordPress REST API ──
async function wpFetch(path, options = {}) {
  const base = process.env.WP_URL;
  const cred = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
  const r = await fetch(`${base}/wp-json/wp/v2${path}`, {
    ...options,
    headers: {
      'Authorization': `Basic ${cred}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`WP error: ${r.status} ${await r.text()}`);
  return r.json();
}

// GET /api/wp/posts?per_page=10&page=1&status=publish
app.get('/api/wp/posts', async (req, res) => {
  if (!process.env.WP_URL) return res.status(503).json({ error: 'WordPress未設定' });
  const { per_page = 10, page = 1, status = 'publish', search = '' } = req.query;
  audit(req.user.email, req.user.name, 'wp.posts', { per_page, page });
  try {
    const qs = new URLSearchParams({ per_page, page, status });
    if (search) qs.set('search', search);
    res.json(await wpFetch(`/posts?${qs}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wp/posts/:id
app.get('/api/wp/posts/:id', async (req, res) => {
  if (!process.env.WP_URL) return res.status(503).json({ error: 'WordPress未設定' });
  audit(req.user.email, req.user.name, 'wp.post', { id: req.params.id });
  try { res.json(await wpFetch(`/posts/${req.params.id}`)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/wp/posts  body: { title, content, status }
app.post('/api/wp/posts', async (req, res) => {
  if (!process.env.WP_URL) return res.status(503).json({ error: 'WordPress未設定' });
  const { title, content, status = 'draft' } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title と content は必須' });
  audit(req.user.email, req.user.name, 'wp.create_post', { title: title.slice(0, 50), status });
  try {
    res.json(await wpFetch('/posts', { method: 'POST', body: JSON.stringify({ title, content, status }) }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AWS SES (nodemailer) ──
function getSesTransport() {
  return nodemailer.createTransport({
    host: process.env.SES_HOST || 'email-smtp.us-west-2.amazonaws.com',
    port: parseInt(process.env.SES_PORT || '587'),
    secure: false,
    auth: { user: process.env.SES_USER, pass: process.env.SES_SECRET }
  });
}

// POST /api/email/send  body: { to, subject, text, html }
app.post('/api/email/send', async (req, res) => {
  if (!process.env.SES_USER) return res.status(503).json({ error: 'SES未設定' });
  const { to, subject, text, html } = req.body;
  if (!to || !subject || (!text && !html)) return res.status(400).json({ error: 'to/subject/text は必須' });
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  if (!adminEmails.includes(req.user.email)) return res.status(403).json({ error: '管理者のみメール送信可能' });
  audit(req.user.email, req.user.name, 'email.send', { to, subject: subject.slice(0, 50) });
  try {
    const info = await getSesTransport().sendMail({
      from: process.env.SES_FROM || 'info@acrovision.co.jp',
      to, subject, text, html
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OpenRouter / DeepInfra (OpenAI-compatible) ──
// POST /api/ai/chat  body: { provider, model, messages, max_tokens }
app.post('/api/ai/chat', async (req, res) => {
  const { provider = 'openrouter', model, messages, max_tokens = 1024 } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages は必須' });

  let apiKey, baseUrl, defaultModel;
  if (provider === 'deepinfra') {
    apiKey = process.env.DEEPINFRA_API_KEY;
    baseUrl = 'https://api.deepinfra.com/v1/openai';
    defaultModel = 'Qwen/Qwen3-235B-A22B';
  } else {
    apiKey = process.env.OPENROUTER_API_KEY;
    baseUrl = 'https://openrouter.ai/api/v1';
    defaultModel = 'qwen/qwen3-235b-a22b';
  }
  if (!apiKey) return res.status(503).json({ error: `${provider}未設定` });

  audit(req.user.email, req.user.name, 'ai.chat', { provider, model: model || defaultModel });
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || defaultModel, messages, max_tokens, stream: false })
    });
    if (!r.ok) throw new Error(`${provider} error: ${r.status} ${await r.text()}`);
    const data = await r.json();
    res.json({ content: data.choices?.[0]?.message?.content || '', usage: data.usage });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Google Drive API ──
function getDriveClientForUser(user) {
  const tokenRow = db.prepare('SELECT access_token, refresh_token FROM user_drive_tokens WHERE email=?').get(user.email);
  if (!tokenRow?.refresh_token) {
    throw new Error('Googleドライブが未連携です。一度ログアウトして再ログインしてください（Drive権限の許可が必要です）');
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ access_token: tokenRow.access_token, refresh_token: tokenRow.refresh_token });
  oauth2.on('tokens', tokens => {
    if (tokens.access_token) {
      db.prepare("UPDATE user_drive_tokens SET access_token=?, updated_at=datetime('now','localtime') WHERE email=?")
        .run(tokens.access_token, user.email);
    }
  });
  return google.drive({ version: 'v3', auth: oauth2 });
}

const DRIVE_MIME_LABELS = {
  'application/vnd.google-apps.document': 'Docs',
  'application/vnd.google-apps.spreadsheet': 'Sheets',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/vnd.google-apps.folder': 'フォルダ',
  'application/pdf': 'PDF',
  'text/plain': 'テキスト',
  'text/csv': 'CSV',
};

// GET /api/drive/status — Drive連携確認
app.get('/api/drive/status', (req, res) => {
  const row = db.prepare('SELECT updated_at FROM user_drive_tokens WHERE email=? AND refresh_token IS NOT NULL').get(req.user.email);
  res.json({ connected: !!row, updated_at: row?.updated_at || null });
});

// GET /api/drive/list?folderId=xxx
app.get('/api/drive/list', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  audit(req.user.email, req.user.name, 'drive.list', { folderId });
  try {
    const drive = getDriveClientForUser(req.user);
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,modifiedTime,size)',
      orderBy: 'folder,name',
      pageSize: 100
    });
    res.json(r.data.files || []);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/drive/read/:id
app.get('/api/drive/read/:id', async (req, res) => {
  audit(req.user.email, req.user.name, 'drive.read', { fileId: req.params.id });
  try {
    const drive = getDriveClientForUser(req.user);
    const meta = await drive.files.get({ fileId: req.params.id, fields: 'name,mimeType' });
    const { mimeType, name } = meta.data;
    let content = '';

    if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation') {
      const r = await drive.files.export({ fileId: req.params.id, mimeType: 'text/plain' }, { responseType: 'text' });
      content = String(r.data);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const r = await drive.files.export({ fileId: req.params.id, mimeType: 'text/csv' }, { responseType: 'text' });
      content = String(r.data);
    } else if (mimeType && (mimeType.startsWith('text/') || mimeType === 'application/json')) {
      const r = await drive.files.get({ fileId: req.params.id, alt: 'media' }, { responseType: 'text' });
      content = String(r.data);
    } else {
      return res.status(415).json({ error: `${mimeType} は読み取り非対応です` });
    }

    res.json({ id: req.params.id, name, mimeType, content: content.slice(0, 60000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Claude Agent Web: http://0.0.0.0:${PORT}`));
