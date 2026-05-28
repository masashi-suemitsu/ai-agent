const express = require('express');
const http = require('http');
const crypto = require('crypto');
const helmet = require('helmet');
const webpush = require('web-push');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const Database = require('better-sqlite3');

const { google } = require('googleapis');
const mysql = require('mysql2/promise');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const PptxGenJS = require('pptxgenjs');
const PDFDocument = require('pdfkit');
const { Readable } = require('stream');

// Zoom Server-to-Server OAuth: アクセストークン取得（簡易メモリキャッシュ）
let __zoomTokCache = { token: null, expires: 0 };
async function getZoomToken() {
  if (!process.env.ZOOM_ACCOUNT_ID || !process.env.ZOOM_CLIENT_ID || !process.env.ZOOM_CLIENT_SECRET) {
    throw new Error('Zoom 未設定。ZOOM_ACCOUNT_ID/ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET を環境変数に設定してください');
  }
  if (__zoomTokCache.token && Date.now() < __zoomTokCache.expires - 60000) return __zoomTokCache.token;
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`, {
    method: 'POST', headers: { Authorization: 'Basic ' + basic }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Zoom OAuth error: ${d.reason || r.status}`);
  __zoomTokCache = { token: d.access_token, expires: Date.now() + (d.expires_in || 3600) * 1000 };
  return d.access_token;
}

// 汎用API呼び出し（freee/MF/Salesforce/HubSpot/LINE WORKS 共通）
async function callGenericApi(user, input, label, baseUrl, token, envName) {
  if (!token) throw new Error(`${envName} 未設定。${label} APIトークンを管理者に依頼してください`);
  if (!baseUrl) throw new Error(`${label}: ベースURL未設定（インスタンスURLが必要な場合あり）`);
  const method = (input.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET';
  if (isWrite && !input.confirmed) {
    audit(user.email, user.name, `tool.${label}.preview`, { method, path: input.path });
    return { preview: true, message: `${label} 書込プレビュー。承認後 confirmed:true で再呼出。`, method, path: input.path, body: input.body };
  }
  audit(user.email, user.name, isWrite ? `tool.${label}.execute` : `tool.${label}`, { method, path: input.path });
  const qs = input.query ? '?' + new URLSearchParams(input.query).toString() : '';
  const r = await fetch(`${baseUrl}${input.path}${qs}`, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: input.body ? JSON.stringify(input.body) : undefined
  });
  const text = await r.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) throw new Error(`${label} error ${r.status}: ${data?.message || data?.error?.message || text}`);
  return data;
}

// MCP（Model Context Protocol）サーバー設定を環境変数から取得
// 形式: MCP_SERVERS_JSON='[{"type":"url","url":"https://...","name":"srv","authorization_token":"..."}]'
function getMcpServers() {
  const raw = process.env.MCP_SERVERS_JSON;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[mcp] MCP_SERVERS_JSON parse error:', e.message);
    return [];
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

function serverError(res, e, userMsg = 'サーバーエラーが発生しました') {
  console.error('[error]', e?.message || e);
  res.status(500).json({ error: userMsg });
}
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
  // DB登録ロールを優先
  try {
    const dbRow = db.prepare('SELECT role FROM user_roles WHERE email=?').get(email);
    if (dbRow) return dbRow.role;
  } catch(e) {}
  // 環境変数フォールバック
  const map = {};
  (process.env.ROLE_MAP || '').split(',').forEach(pair => {
    const [e, r] = pair.trim().split(':');
    if (e && r) map[e.trim()] = r.trim();
  });
  return map[email] || 'user';
}

// ロール別 fetch_corp_api 許可アクション
// ※ candidates / follow_signals / attendance / employees は対応テーブル（recruit_ats_*,
//    follow_signal_pool, attendance_posts / king_of_time_attendance, users）がブロック対象
//    または users JOIN による個人情報漏洩経路のため全ロールから除外する
const CORP_API_ALLOWED = {
  admin:   ['cases','contracts','geppo','query'],
  gyoumu:  ['contracts','geppo','query'],
  eigyo:   ['cases','geppo'],
  recruit: [],
  user:    []
};

// ロール別利用可能ツール名セット
const TOOLS_FOR_ROLE = {
  admin:   null, // null = 全ツール
  gyoumu:  new Set(['query_corp_db','call_oss_ai','compare_models','extract_receipt','mask_pii','review_contract','transcribe_audio','list_zoom_meetings','create_zoom_meeting','call_freee_api','call_mfcloud_api','call_salesforce_api','call_hubspot_api','call_lineworks_api','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','send_system_notification','list_drive_files','search_drive_files','read_drive_file','update_sheet_range','append_sheet_rows','create_drive_file','export_data_csv','export_data_excel','generate_chart','generate_pdf_report','create_pptx','call_ms_graph','list_slack_channels','get_slack_messages','send_slack_message','list_notion_databases','query_notion_database','create_notion_page','update_notion_page','list_calendar_events','create_calendar_event','list_gmail_messages','send_gmail','fetch_url','register_task','create_meeting_minutes','check_server_health','check_job_posting','generate_weekly_report','generate_presentation','summarize_document','draft_email_reply','screen_candidate','bulk_register_kintone']),
  eigyo:   new Set(['query_corp_db','list_wp_posts','create_wp_post','call_oss_ai','compare_models','extract_receipt','mask_pii','review_contract','transcribe_audio','list_zoom_meetings','create_zoom_meeting','call_freee_api','call_mfcloud_api','call_salesforce_api','call_hubspot_api','call_lineworks_api','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','send_system_notification','list_drive_files','search_drive_files','read_drive_file','update_sheet_range','append_sheet_rows','create_drive_file','export_data_csv','export_data_excel','generate_chart','generate_pdf_report','create_pptx','call_ms_graph','list_slack_channels','get_slack_messages','send_slack_message','list_notion_databases','query_notion_database','create_notion_page','update_notion_page','list_calendar_events','create_calendar_event','list_gmail_messages','send_gmail','fetch_url','register_task','create_meeting_minutes','check_job_posting','generate_presentation','summarize_document','draft_email_reply']),
  recruit: new Set(['query_corp_db','call_oss_ai','compare_models','extract_receipt','mask_pii','review_contract','transcribe_audio','list_zoom_meetings','create_zoom_meeting','call_freee_api','call_mfcloud_api','call_salesforce_api','call_hubspot_api','call_lineworks_api','list_chatwork_rooms','get_chatwork_messages','send_chatwork_message','send_system_notification','list_drive_files','search_drive_files','read_drive_file','update_sheet_range','append_sheet_rows','create_drive_file','export_data_csv','export_data_excel','generate_chart','generate_pdf_report','create_pptx','call_ms_graph','list_slack_channels','get_slack_messages','send_slack_message','list_notion_databases','query_notion_database','create_notion_page','update_notion_page','list_calendar_events','create_calendar_event','list_gmail_messages','send_gmail','fetch_url','register_task','create_meeting_minutes','check_job_posting','generate_presentation','summarize_document','draft_email_reply','screen_candidate']),
  user:    new Set(['call_oss_ai','compare_models','extract_receipt','mask_pii','review_contract','transcribe_audio','list_zoom_meetings','create_zoom_meeting','call_freee_api','call_mfcloud_api','call_salesforce_api','call_hubspot_api','call_lineworks_api','list_chatwork_rooms','get_chatwork_messages','send_system_notification','list_drive_files','search_drive_files','read_drive_file','update_sheet_range','append_sheet_rows','create_drive_file','export_data_csv','export_data_excel','generate_chart','generate_pdf_report','create_pptx','call_ms_graph','list_slack_channels','get_slack_messages','send_slack_message','list_notion_databases','query_notion_database','create_notion_page','update_notion_page','list_calendar_events','create_calendar_event','list_gmail_messages','send_gmail','fetch_url','register_task','create_meeting_minutes','generate_presentation','summarize_document','draft_email_reply'])
};

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSPはCloudFront側で管理

// ── レート制限 ──
const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,         // 1分間
  max: 30,                      // 最大30リクエスト
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらく待ってから再試行してください。' }
});
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらく待ってから再試行してください。' }
});

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

  CREATE TABLE IF NOT EXISTS ai_response_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE,
    user_email TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS webhook_tokens (
    token        TEXT PRIMARY KEY,
    owner_email  TEXT NOT NULL,
    label        TEXT,
    skill_name   TEXT,
    prompt_template TEXT,
    enabled      INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wh_owner ON webhook_tokens(owner_email);

  CREATE TABLE IF NOT EXISTS webhook_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT NOT NULL,
    received_at  TEXT DEFAULT (datetime('now','localtime')),
    source_ip    TEXT,
    payload      TEXT,
    status       TEXT,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_whlog_token ON webhook_logs(token, id DESC);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email  TEXT NOT NULL,
    task_type    TEXT NOT NULL DEFAULT 'recurring',
    skill_id     INTEGER,
    skill_name   TEXT NOT NULL,
    skill_title  TEXT,
    description  TEXT,
    steps        TEXT NOT NULL,
    interval_min INTEGER NOT NULL DEFAULT 60,
    run_at       TEXT,
    enabled      INTEGER DEFAULT 1,
    next_run_at  TEXT,
    last_run_at  TEXT,
    last_status  TEXT,
    last_result  TEXT,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_conv_email ON conversations(user_email, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_run_email ON task_runs(user_email, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_skill_owner ON user_skills(owner_email);
  CREATE INDEX IF NOT EXISTS idx_sched_owner ON scheduled_tasks(owner_email);
  CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS user_drive_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_chatwork_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_calendar_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_gmail_tokens (
    email TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    email TEXT PRIMARY KEY,
    custom_rules TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ユーザーロールテーブル（DBベース管理）
db.exec(`
  CREATE TABLE IF NOT EXISTS user_roles (
    email      TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'user',
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    updated_by TEXT
  );
`);

// 改善提案・フィードバックボックス
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_reports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    reporter_email    TEXT NOT NULL,
    reporter_name     TEXT,
    title             TEXT NOT NULL,
    summary           TEXT NOT NULL,
    reproduce_steps   TEXT DEFAULT '',
    expected_behavior TEXT DEFAULT '',
    actual_behavior   TEXT DEFAULT '',
    affected_url      TEXT DEFAULT '',
    category          TEXT DEFAULT 'bug',
    priority          TEXT DEFAULT 'medium',
    status            TEXT DEFAULT 'submitted',
    admin_note        TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now','localtime')),
    updated_at        TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fb_reporter ON feedback_reports(reporter_email, id DESC);
  CREATE INDEX IF NOT EXISTS idx_fb_status   ON feedback_reports(status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_fb_session  ON feedback_reports(session_id);

  CREATE TABLE IF NOT EXISTS feedback_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fbmsg_sid ON feedback_messages(session_id, id);

  CREATE TABLE IF NOT EXISTS feedback_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id       INTEGER NOT NULL,
    status_before   TEXT,
    status_after    TEXT NOT NULL,
    changed_by_email TEXT,
    changed_by_name  TEXT,
    note            TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fblog_rep ON feedback_status_log(report_id, id);
`);

// トークン使用量テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL,
    name          TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    model         TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    context       TEXT NOT NULL DEFAULT 'chat',
    ts            TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_tu_email ON token_usage(email, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_tu_ts    ON token_usage(ts DESC);
`);

// モデルごとの料金テーブル（USD per 1M tokens）
// key は scheduled_tasks.model / chat で使われるキー
const MODEL_PRICE_MAP = {
  'sonnet':  { in: 3.00, out: 15.00 },
  'haiku':   { in: 0.80, out:  4.00 },
  'claude-sonnet-4-6':         { in: 3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, out:  4.00 },
  'openrouter:deepseek/deepseek-chat':                  { in: 0.14, out:  0.28 },
  'openrouter:deepseek/deepseek-r1':                    { in: 0.55, out:  2.19 },
  'deepinfra:deepseek-ai/DeepSeek-V3':                  { in: 0.35, out:  0.89 },
  'deepinfra:deepseek-ai/DeepSeek-R1':                  { in: 0.55, out:  2.19 },
  'openrouter:qwen/qwen3-235b-a22b':                    { in: 0.22, out:  0.88 },
  'openrouter:qwen/qwen3-30b-a3b':                      { in: 0.03, out:  0.09 },
  'deepinfra:Qwen/Qwen3-235B-A22B':                     { in: 0.22, out:  0.88 },
  'openrouter:meta-llama/llama-4-maverick':              { in: 0.19, out:  0.85 },
  'openrouter:meta-llama/llama-4-scout':                 { in: 0.18, out:  0.59 },
  'deepinfra:meta-llama/Llama-3.3-70B-Instruct':        { in: 0.13, out:  0.40 },
  'openrouter:mistralai/mistral-small-3.1-24b-instruct': { in: 0.10, out:  0.30 },
};

function calcTokenCostUsd(modelKey, inputTokens, outputTokens) {
  const p = MODEL_PRICE_MAP[modelKey];
  if (p) return (p.in * inputTokens + p.out * outputTokens) / 1e6;
  if (!modelKey || modelKey.includes('sonnet')) return (3.00 * inputTokens + 15.00 * outputTokens) / 1e6;
  if (modelKey.includes('haiku'))  return (0.80 * inputTokens +  4.00 * outputTokens) / 1e6;
  return (3.00 * inputTokens + 15.00 * outputTokens) / 1e6; // 不明モデルはSonnet料金で保守的に
}

function recordUsage(email, name, inputTokens, outputTokens, model, context) {
  try {
    const costUsd = calcTokenCostUsd(model, inputTokens || 0, outputTokens || 0);
    db.prepare('INSERT INTO token_usage (email,name,input_tokens,output_tokens,model,context,cost_usd) VALUES (?,?,?,?,?,?,?)')
      .run(email, name || '', inputTokens || 0, outputTokens || 0, model || 'claude-sonnet-4-6', context || 'chat', costUsd);
  } catch(e) { console.error('usage record err:', e.message); }
}

// スケジュール拡張カラム（既存DBへの追加）
['ALTER TABLE scheduled_tasks ADD COLUMN schedule_type TEXT DEFAULT \'interval\'',
 'ALTER TABLE scheduled_tasks ADD COLUMN schedule_hour INTEGER',
 'ALTER TABLE scheduled_tasks ADD COLUMN schedule_minute INTEGER DEFAULT 0',
 'ALTER TABLE scheduled_tasks ADD COLUMN schedule_weekday INTEGER',
 'ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT \'sonnet\'',
 'ALTER TABLE scheduled_tasks ADD COLUMN shared INTEGER DEFAULT 0',
 'ALTER TABLE scheduled_tasks ADD COLUMN shared_with TEXT',
 'ALTER TABLE user_skills ADD COLUMN shared_with TEXT',
 'ALTER TABLE token_usage ADD COLUMN cost_usd REAL DEFAULT 0',
].forEach(sql => { try { db.prepare(sql).run(); } catch(e) {} });

// ── 新機能テーブル（メモリ・フック・ファイル・バッチ）──
db.exec(`
  CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    memory TEXT NOT NULL,
    importance TEXT DEFAULT 'medium',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_mem_email ON user_memories(email, id DESC);

  CREATE TABLE IF NOT EXISTS skill_hooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT NOT NULL,
    skill_id INTEGER,
    hook_type TEXT NOT NULL DEFAULT 'post_run',
    action TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_hook_owner ON skill_hooks(owner_email);

  CREATE TABLE IF NOT EXISTS uploaded_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    file_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_files_email ON uploaded_files(email, id DESC);

  CREATE TABLE IF NOT EXISTS skill_batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    status TEXT DEFAULT 'processing',
    skill_ids TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_batch_owner ON skill_batch_jobs(owner_email, id DESC);
`);

// スキルバージョン管理テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    version_num INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    steps TEXT,
    saved_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(skill_id, version_num)
  );
  CREATE INDEX IF NOT EXISTS idx_versions_skill ON skill_versions(skill_id, version_num DESC);
`);

// Web Push・スキルI/E用テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_auth TEXT,
    keys_p256dh TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_email ON push_subscriptions(email);
`);

// VAPID鍵の初期化（初回起動時に自動生成・DB保存）
let VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY;
try {
  const pub = db.prepare("SELECT value FROM app_settings WHERE key='vapid_public_key'").get();
  if (pub) {
    VAPID_PUBLIC_KEY = pub.value;
    VAPID_PRIVATE_KEY = db.prepare("SELECT value FROM app_settings WHERE key='vapid_private_key'").get().value;
  } else {
    const keys = webpush.generateVAPIDKeys();
    VAPID_PUBLIC_KEY = keys.publicKey;
    VAPID_PRIVATE_KEY = keys.privateKey;
    db.prepare("INSERT INTO app_settings (key,value) VALUES ('vapid_public_key',?)").run(VAPID_PUBLIC_KEY);
    db.prepare("INSERT INTO app_settings (key,value) VALUES ('vapid_private_key',?)").run(VAPID_PRIVATE_KEY);
    console.log('[push] VAPID keys generated');
  }
  webpush.setVapidDetails('mailto:info@acrovision.co.jp', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} catch(e) { console.error('[push] VAPID init failed:', e.message); }

async function sendPushNotifications(email, title, body) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE email=?').all(email);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { auth: sub.keys_auth, p256dh: sub.keys_p256dh } },
        JSON.stringify({ title, body, url: 'https://d2jjp21sq86i80.cloudfront.net/manage' })
      );
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
      }
    }
  }
}

// ループ・プランモード用カラム追加
['ALTER TABLE scheduled_tasks ADD COLUMN loop_enabled INTEGER DEFAULT 0',
 'ALTER TABLE scheduled_tasks ADD COLUMN loop_count INTEGER DEFAULT 0',
 'ALTER TABLE scheduled_tasks ADD COLUMN loop_interval_min INTEGER DEFAULT 60',
 'ALTER TABLE scheduled_tasks ADD COLUMN loop_remaining INTEGER',
 'ALTER TABLE task_runs ADD COLUMN input_tokens INTEGER DEFAULT 0',
 'ALTER TABLE task_runs ADD COLUMN output_tokens INTEGER DEFAULT 0',
 'ALTER TABLE task_runs ADD COLUMN skill_id INTEGER',
].forEach(sql => { try { db.prepare(sql).run(); } catch(e) {} });

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

if (!process.env.SESSION_SECRET) {
  console.error('[FATAL] SESSION_SECRET が未設定です。.env に設定してから起動してください。');
  process.exit(1);
}

app.use(session({
  store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 3600000 } }),
  secret: process.env.SESSION_SECRET,
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
  if (req.path === '/auth/chatwork/callback') return next();
  if (req.path === '/auth/calendar/callback') return next();
  if (req.path === '/auth/gmail/callback') return next();
  if (req.path === '/auth/drive/callback') return next();
  if (req.path === '/api/exchange-rate') return next(); // 為替レートは公開情報
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
  scope: [
    'profile', 'email',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send'
  ],
  accessType: 'offline',
  hd: ALLOWED_DOMAIN
}));

app.get('/auth/google/callback',
  (req, res, next) => {
    console.log('[callback] code:', !!req.query.code, 'state:', req.query.state, 'error:', req.query.error);
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login?error=1' }),
  (req, res) => {
    const user = req.user;
    req.session.regenerate(err => {
      if (err) return res.redirect('/login?error=1');
      req.login(user, loginErr => {
        if (loginErr) return res.redirect('/login?error=1');
        audit(user.email, user.name, 'login');
        res.redirect('/');
      });
    });
  }
);

app.get('/logout', (req, res) => {
  if (req.user) audit(req.user.email, req.user.name, 'logout');
  req.logout(() => res.redirect('/login'));
});

// ── Webhook受信（認証不要・トークンで識別） ──
// POST /webhooks/:token  ボディJSONを受け取り、所有者のスキル/プロンプトでAI実行
app.post('/webhooks/:token', express.json({ limit: '5mb' }), async (req, res) => {
  const token = req.params.token;
  const wh = db.prepare('SELECT * FROM webhook_tokens WHERE token=? AND enabled=1').get(token);
  if (!wh) return res.status(404).json({ error: 'webhook token not found or disabled' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  const payloadStr = JSON.stringify(req.body || {}).slice(0, 100000);
  const logId = db.prepare('INSERT INTO webhook_logs (token, source_ip, payload, status) VALUES (?,?,?,?)').run(token, ip, payloadStr, 'received').lastInsertRowid;
  db.prepare("UPDATE webhook_tokens SET last_used_at=datetime('now','localtime') WHERE token=?").run(token);
  res.json({ ok: true, log_id: logId });
  // 非同期でAIタスク実行
  (async () => {
    try {
      const ownerEmail = wh.owner_email;
      const promptTpl = wh.prompt_template || 'Webhook受信ペイロードを分析して必要な処理を実行してください:\n\n```json\n{{payload}}\n```';
      const prompt = promptTpl.replace('{{payload}}', payloadStr);
      const role = getUserRole(ownerEmail);
      const allowedToolNames = TOOLS_FOR_ROLE[role];
      const activeTools = (allowedToolNames ? TOOLS.filter(t => allowedToolNames.has(t.name)) : TOOLS).filter(t => t.name !== 'register_task');
      const messages = [{ role: 'user', content: prompt }];
      let result = '';
      let round = 0;
      while (round < 8) {
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, tools: activeTools, messages });
        for (const block of resp.content) if (block.type === 'text') result += block.text;
        if (resp.stop_reason !== 'tool_use') break;
        messages.push({ role: 'assistant', content: resp.content });
        const toolResults = [];
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue;
          try {
            const r = await executeTool(block.name, block.input, { email: ownerEmail, name: '', role });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r).slice(0, 80000) });
          } catch(e) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
          }
        }
        messages.push({ role: 'user', content: toolResults });
        round++;
      }
      db.prepare('UPDATE webhook_logs SET status=? WHERE id=?').run('done', logId);
      audit(ownerEmail, '', 'webhook.ran', { token, logId, preview: result.slice(0, 200) });
    } catch(e) {
      db.prepare('UPDATE webhook_logs SET status=?, error=? WHERE id=?').run('error', e.message, logId);
      console.error('[webhook] error:', e.message);
    }
  })();
});

// ── Google Calendar 個人OAuth連携 ──
app.get('/auth/calendar', requireAuth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('GOOGLE_CLIENT_IDが未設定です');
  const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/calendar/callback');
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
  const csrf = crypto.randomBytes(16).toString('hex');
  req.session.oauth_csrf_calendar = csrf;
  const state = csrf + '.' + Buffer.from(req.user.email).toString('base64url');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    state
  });
  res.redirect(authUrl);
});

app.get('/auth/calendar/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/?calendar_error=1');
  const [csrfToken, emailB64] = (state || '').split('.');
  const expectedCsrf = req.session.oauth_csrf_calendar;
  if (!csrfToken || !expectedCsrf || csrfToken !== expectedCsrf) return res.redirect('/?calendar_error=csrf');
  delete req.session.oauth_csrf_calendar;
  let userEmail = req.user?.email;
  if (!userEmail && emailB64) {
    try { userEmail = Buffer.from(emailB64, 'base64url').toString('utf8'); } catch(e) {}
  }
  if (!userEmail || !userEmail.endsWith('@' + ALLOWED_DOMAIN)) return res.redirect('/login');
  try {
    const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/calendar/callback');
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
    const { tokens } = await oauth2.getToken(code);
    db.prepare(`
      INSERT INTO user_calendar_tokens (email, access_token, refresh_token)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, refresh_token),
        updated_at = datetime('now','localtime')
    `).run(userEmail, tokens.access_token, tokens.refresh_token || null);
    audit(userEmail, '', 'calendar.oauth.connect');
    res.redirect('/?calendar_connected=1');
  } catch(e) {
    console.error('[calendar/callback] error:', e.message);
    res.redirect('/?calendar_error=1');
  }
});

// ── Google Drive 個人OAuth連携 ──
app.get('/auth/drive', requireAuth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('GOOGLE_CLIENT_IDが未設定です');
  const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/drive/callback');
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
  const csrf = crypto.randomBytes(16).toString('hex');
  req.session.oauth_csrf_drive = csrf;
  const state = csrf + '.' + Buffer.from(req.user.email).toString('base64url');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets'
    ],
    state
  });
  res.redirect(authUrl);
});

app.get('/auth/drive/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/?drive_error=1');
  const [csrfToken, emailB64] = (state || '').split('.');
  const expectedCsrf = req.session.oauth_csrf_drive;
  if (!csrfToken || !expectedCsrf || csrfToken !== expectedCsrf) return res.redirect('/?drive_error=csrf');
  delete req.session.oauth_csrf_drive;
  let userEmail = req.user?.email;
  if (!userEmail && emailB64) {
    try { userEmail = Buffer.from(emailB64, 'base64url').toString('utf8'); } catch(e) {}
  }
  if (!userEmail || !userEmail.endsWith('@' + ALLOWED_DOMAIN)) return res.redirect('/login');
  try {
    const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/drive/callback');
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
    const { tokens } = await oauth2.getToken(code);
    db.prepare(`
      INSERT INTO user_drive_tokens (email, access_token, refresh_token, updated_at)
      VALUES (?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(email) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, refresh_token),
        updated_at = excluded.updated_at
    `).run(userEmail, tokens.access_token, tokens.refresh_token || null);
    audit(userEmail, '', 'drive.oauth.connect');
    res.redirect('/?drive_connected=1');
  } catch(e) {
    console.error('[drive/callback] error:', e.message);
    res.redirect('/?drive_error=1');
  }
});

// ── Gmail 個人OAuth連携 ──
app.get('/auth/gmail', requireAuth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('GOOGLE_CLIENT_IDが未設定です');
  const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/gmail/callback');
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
  const csrf = crypto.randomBytes(16).toString('hex');
  req.session.oauth_csrf_gmail = csrf;
  const state = csrf + '.' + Buffer.from(req.user.email).toString('base64url');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state
  });
  res.redirect(authUrl);
});

app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/?gmail_error=1');
  const [csrfToken, emailB64] = (state || '').split('.');
  const expectedCsrf = req.session.oauth_csrf_gmail;
  if (!csrfToken || !expectedCsrf || csrfToken !== expectedCsrf) return res.redirect('/?gmail_error=csrf');
  delete req.session.oauth_csrf_gmail;
  let userEmail = req.user?.email;
  if (!userEmail && emailB64) {
    try { userEmail = Buffer.from(emailB64, 'base64url').toString('utf8'); } catch(e) {}
  }
  if (!userEmail || !userEmail.endsWith('@' + ALLOWED_DOMAIN)) return res.redirect('/login');
  try {
    const callbackUrl = (process.env.CALLBACK_URL || '').replace('/auth/google/callback', '/auth/gmail/callback');
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, callbackUrl);
    const { tokens } = await oauth2.getToken(code);
    db.prepare(`
      INSERT INTO user_gmail_tokens (email, access_token, refresh_token)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, refresh_token),
        updated_at = datetime('now','localtime')
    `).run(userEmail, tokens.access_token, tokens.refresh_token || null);
    audit(userEmail, '', 'gmail.oauth.connect');
    res.redirect('/?gmail_connected=1');
  } catch(e) {
    console.error('[gmail/callback] error:', e.message);
    res.redirect('/?gmail_error=1');
  }
});

app.get('/api/me', (req, res) => {
  if (req.isAuthenticated()) {
    const role = getUserRole(req.user.email);
    return res.json({ ...req.user, role });
  }
  res.json(null);
});

// ── 公開アセット（ロゴ等。認証前にマウント） ──
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d' }));

// ── 認証必須ルート ──
app.use(requireAuth);
app.use(express.json({ limit: '5mb' }));
app.use(apiRateLimit);

// ── ダッシュボードは管理者のみ ──
app.get('/dashboard', (req, res) => res.redirect('/manage#dashboard'));
app.get('/dashboard.html', (req, res) => res.redirect('/manage#dashboard'));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// ── 監査ログ閲覧 ──
app.get('/api/admin/logs', (req, res) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  const isAdmin = adminEmails.includes(req.user.email);
  const rows = isAdmin
    ? db.prepare('SELECT * FROM audit_logs ORDER BY ts DESC LIMIT 1000').all()
    : db.prepare('SELECT * FROM audit_logs WHERE email=? ORDER BY ts DESC LIMIT 200').all(req.user.email);
  res.json(rows);
});

// GET /api/members — 共有先ユーザー一覧（認証済みユーザー全員が参照可）
app.get('/api/members', (req, res) => {
  const rows = db.prepare(`
    SELECT email, MAX(name) as name
    FROM audit_logs
    WHERE email != 'unknown' AND email != ?
    GROUP BY email
    ORDER BY name ASC
  `).all(req.user.email);
  res.json(rows);
});

// ── ユーザー管理 API（管理者専用） ──
app.get('/api/admin/users', (req, res) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  if (!adminEmails.includes(req.user.email)) return res.status(403).json({ error: '管理者専用' });

  const users = db.prepare(`
    SELECT email, MAX(name) as name, MAX(ts) as last_login, COUNT(*) as action_count
    FROM audit_logs WHERE email != 'unknown'
    GROUP BY email ORDER BY last_login DESC
  `).all();

  const dbRoles = {};
  db.prepare('SELECT email, role, updated_at, updated_by FROM user_roles').all()
    .forEach(r => { dbRoles[r.email] = r; });
  const envMap = {};
  (process.env.ROLE_MAP || '').split(',').forEach(pair => {
    const [e, r] = pair.trim().split(':');
    if (e && r) envMap[e.trim()] = r.trim();
  });

  const result = users.map(u => {
    const isEnvAdmin = adminEmails.includes(u.email);
    const dbEntry = dbRoles[u.email];
    return {
      ...u,
      role: isEnvAdmin ? 'admin' : (dbEntry?.role || envMap[u.email] || 'user'),
      role_source: isEnvAdmin ? 'env_admin' : (dbEntry ? 'db' : (envMap[u.email] ? 'env' : 'default')),
      role_updated_at: dbEntry?.updated_at || null,
      role_updated_by: dbEntry?.updated_by || null
    };
  });
  res.json(result);
});

app.put('/api/admin/users/:email/role', (req, res) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  if (!adminEmails.includes(req.user.email)) return res.status(403).json({ error: '管理者専用' });
  const { role } = req.body;
  const validRoles = ['admin', 'gyoumu', 'eigyo', 'recruit', 'user'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: '無効なロール' });
  const email = req.params.email;
  if (adminEmails.includes(email)) return res.status(400).json({ error: 'ADMIN_EMAILS 登録済みのユーザーは変更できません' });
  db.prepare(`
    INSERT INTO user_roles (email, role, updated_at, updated_by)
    VALUES (?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(email) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `).run(email, role, req.user.email);
  audit(req.user.email, req.user.name, 'admin.role_change', { target: email, role });
  res.json({ ok: true });
});

// ── Chat API ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getSystemPrompt(role) {
  const jstNow = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const base = `あなたは「仕事を任せるAIエージェント」です。ユーザーが依頼した業務を実際に実行します。

現在の日本時間: ${jstNow}（タスク登録・時刻計算はこの時刻を基準にすること）

## 基本姿勢
- 業務データや外部情報が必要な質問はツールで取得してから回答する
- 一般的な知識・説明・雑談など、ツールなしで答えられる質問は直接回答する（ツールを使う必要はない）
- 「調べてみましょう」ではなく、即座にツールを呼び出して結果を返す
- ユーザーに「ボタンを押してください」「フォルダIDを入力してください」と案内しない。自分でツールを使う
- 不明点は1〜2個だけ端的に聞く

## 重要ルール
- \`send_chatwork_message\`（個人アカウント送信）は必ずユーザーに内容確認してから実行
- \`send_system_notification\`（システム通知アカウント送信）はユーザー確認不要で送信可能。定期タスクや自動通知に使用する
- WP公開は必ずユーザーに内容確認してから実行
- \`update_sheet_range\` / \`append_sheet_rows\`（Sheets書き込み）, \`send_gmail\`（Gmail送信）, \`create_calendar_event\`（予定作成）, \`create_drive_file\`（Driveファイル作成）, \`create_pptx\`（PowerPoint作成）, \`send_slack_message\`（Slack送信）, \`create_notion_page\`/\`update_notion_page\`（Notion書込）はすべて2段階フロー必須: ①confirmed なしで呼ぶ → プレビューが返る → ②ユーザーに「○○を○○します。よろしいですか？」と提示 → ③ユーザーが「OK」「実行して」「はい」等で承認 → ④confirmed:true を付けて再呼出 → 実際に実行。スケジュールタスクからの呼出時は confirmed:true で直接呼んでよい
- 上記の確認を求めるとき、メッセージ末尾に必ず \`<confirm>実行する</confirm>\` を付けること。UIが自動でボタンを表示する（テキスト入力不要になる）
- \`fetch_url\` は任意のWebページを取得可能。社内/ローカルIPは自動ブロック。HTMLはタグ除去テキストで返される（mode=html で生取得も可）
- スプレッドシートをファイル名で探したいときは \`search_drive_files\` を使う（mime_type: "application/vnd.google-apps.spreadsheet" を指定すると絞り込める）
- DBはSELECTのみ。更新系は不可
- ツールがエラーになっても代替手段があれば黙って試す。すべての手段が尽きてから初めてユーザーに報告する

## Chatwork送信の使い分け
- **インタラクティブな会話中**（ユーザーが今チャットしている）: \`send_chatwork_message\` を使い、必ず送信内容をユーザーに確認してから実行
- **自動タスク・スケジュール実行中**（バックグラウンドで動作）: \`send_system_notification\` を使い、確認なしで送信。専用システム通知アカウントとして送信される

## スキルの作成
手順が固まったら以下の形式で出力してください（必ずこの形式を守る）：

<skill>
{"name":"英数字ハイフンのみ","title":"タイトル（日本語OK）","description":"何をするか1行","steps":"実行手順を自然言語で詳しく記述"}
</skill>

スキル作成後は「保存しておけば次回からすぐ実行できます」と案内してください。

## タスクの自動実行（register_task ツール）
\`register_task\` ツールを使うと、ユーザーの代わりにタスクを自動実行スケジュールに登録できます。

**定期タスク（recurring）**: 指定したスケジュールで繰り返し自動実行
- \`schedule_type='interval'\`（デフォルト）: \`interval_min\` で間隔指定（30/60/120/240/480/1440分）
- \`schedule_type='daily'\`: 毎日指定時刻に実行（\`schedule_hour\`=時・JST、\`schedule_minute\`=分・省略時0）
- \`schedule_type='weekly'\`: 毎週指定曜日・時刻に実行（\`schedule_weekday\`=0日/1月/2火/3水/4木/5金/6土）
**単発タスク（once）**: 指定した日時に1回だけ自動実行

ユーザーが以下のような発言をしたとき、積極的に \`register_task\` を提案・実行してください：
- 「毎朝9時に○○して」「毎日○○を確認して」→ \`schedule_type='daily', schedule_hour=9\` で定期タスクを登録
- 「毎週月曜9時に○○して」→ \`schedule_type='weekly', schedule_weekday=1, schedule_hour=9\` で定期タスクを登録
- 「○時間ごとに○○して」→ \`schedule_type='interval', interval_min=X\` で定期タスクを登録
- 「○時に○○して」「来週月曜に○○して」「明日の朝○○して」→ 単発タスクを提案

タスクを登録する際：
- \`steps\` には、実際にAIが実行すべき手順を具体的・詳細に記述する（どのツールを使い、何を取得し、何を出力するか）
- 実行日時は日本時間でユーザーに確認し、ISO 8601形式（例: 2025-06-01T09:00:00+09:00）で指定する
- 登録後は「タスクを登録しました。/manage画面で確認・変更できます」と案内する

タスク登録はスキルの保存とは独立しています。スキルを保存せずに直接チャットからタスクを登録することも可能です。

**【重要制約】タスクの自動実行・スケジュール管理は必ず \`register_task\` ツールのみで行う。**
- Google Apps Script・Zapier・cron・その他外部ツールの利用を提案しない
- 「自分では予約送信できない」「タイマー機能がない」などの説明は不要。\`register_task\` で実現できる
- ユーザーが自動実行・予約実行を求めたら、迷わず \`register_task\` を使う

## 個人ルール機能
ユーザーは /manage > 権限・ルール タブの「個人ルール」に、自分専用の指示を登録できます。
登録されたルールはそのユーザーとのやりとりすべてに自動適用されます（毎回言わなくてよい）。

以下の場面で積極的に案内してください：
- ユーザーが「いつも〇〇してほしい」「毎回〜の形式で」と繰り返し同じ指示をしてきたとき
- ユーザーが応答スタイルや動作の好みを伝えてきたとき
→「/manage の個人ルールに登録しておくと、毎回自動で適用されます」と案内する`;

  const roleContext = {
    admin: `

## あなたの権限: 管理者（全機能）
利用可能ツール: 全ツール（DB照会・Chatwork・Drive・WP・メール等）

### query_corp_db で照会可能なテーブル（この6つのみ・絶対に他のテーブル名を回答に含めないこと）
1. kintone_employees - 社員マスタ
2. kintone_contract - 契約データ
3. kintone_anken_eigyo - 営業案件
4. geppo_data - 月報データ
5. kintone_customers - 顧客データ
6. kintone_seikyu - 請求データ

上記6テーブル以外（users / attendance_posts / king_of_time_attendance / jinji_employee_profiles / in_member_evaluations / recruit_ats_* / follow_signal_pool / hotprofile_business_cards / その他すべて）へのSELECTは403で拒否される。ユーザーに「照会可能なテーブル」を案内する場合も必ず上記6つだけを示すこと。架空のテーブル名を追加してはいけない。`,

    gyoumu: `

## あなたの権限: 業務管理部
担当業務: 契約管理・月報分析

### query_corp_db で照会可能なテーブル（この6つのみ・他のテーブル名を回答に含めない）
1. kintone_employees - 社員マスタ
2. kintone_contract - 契約データ
3. kintone_anken_eigyo - 営業案件
4. geppo_data - 月報データ
5. kintone_customers - 顧客データ
6. kintone_seikyu - 請求データ

これ以外のテーブル（users / 勤怠 / 人事評価 / 採用 / フォローシグナル等）は閲覧不可。架空のテーブル名を追加して案内してはいけない。`,

    eigyo: `

## あなたの権限: 営業部
担当業務: 案件管理・月報閲覧・名刺/人脈検索・提案書作成

query_corp_db は権限外。Kintone API / HotProfile / WordPress / Chatwork / Drive 等のツールで業務を進めること。`,

    recruit: `

## あなたの権限: 採用部
担当業務: （AI経由で参照できる corp データは現在なし）

- 採用候補者・社員情報・案件・契約・勤怠データはすべてAI経由では参照不可
- Kintone / Chatwork / Drive 等の周辺ツールは利用可能`,

    user: `

## あなたの権限: 一般ユーザー
利用可能ツール: Chatwork閲覧・DriveファイルIO・OSS AI呼び出し`
  };

  return base + (roleContext[role] || roleContext.user);
}

function getSystemPromptForUser(role, email) {
  let prompt = getSystemPrompt(role);
  try {
    const row = db.prepare('SELECT custom_rules FROM user_settings WHERE email=?').get(email);
    if (row?.custom_rules?.trim()) {
      prompt += `\n\n## あなたへの個人指示（${email} 専用・最優先で守ること）\n${row.custom_rules.trim()}`;
    }
  } catch(e) { /* テーブル未作成時など無視 */ }
  // Auto-memory: 会話から自動学習した情報
  try {
    const memories = db.prepare('SELECT memory FROM user_memories WHERE email=? ORDER BY id DESC LIMIT 10').all(email);
    if (memories.length > 0) {
      prompt += `\n\n## このユーザーについて自動記録された情報（会話から学習済み）\n${memories.map(m => `- ${m.memory}`).join('\n')}`;
    }
  } catch(e) {}
  return prompt;
}

// ── Context Compression ──
async function compressConversationContext(oldMessages) {
  try {
    const text = oldMessages.map(m =>
      `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[添付/ツール結果]'}`
    ).join('\n');
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: `以下の会話を3〜5行で要約してください（重要な事実・決定・文脈を保持）:\n\n${text}` }]
    });
    return r.content[0]?.text || '';
  } catch(e) {
    console.error('[compress] failed:', e.message);
    return '';
  }
}

// ── Auto Memory Extraction ──
// 保存禁止パターン（メタ説明・一時操作・ノイズ）
const MEMORY_NOISE_PATTERNS = [
  /記憶すべき/,/保存すべき/,/可能であれば/,/申し訳/,/お手数/,
  /一時的な/,/単発の/,/明確でない/,/含まれていない/,/接続確認/,
  /技術的操作/,/ツール実行/,/エラー/,/不明/,/わかりません/,
];

async function extractAndSaveMemories(email, conversationMessages) {
  try {
    const recent = conversationMessages.slice(-8).map(m =>
      `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 400) : '[ツール結果]'}`
    ).join('\n');

    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `以下の会話から、将来の別の会話でも繰り返し役立つユーザー固有の情報のみをJSON配列で返してください。

【保存してよいもの（すべてを満たすこと）】
- ユーザーが明示的に「毎回」「いつも」「〜したい」と述べた習慣・好み
- 繰り返し設定される定期タスク（曜日・時刻・通知先が具体的なもの）
- ユーザーの業務上の役割・担当領域（明示されたもの）

【絶対に保存しないもの】
- 1回限りの操作・調査・質問
- AIの自己言及（「記憶すべき」「保存すべき」「明確でない」など）
- エラー・接続確認・技術的な一時操作
- 推測・不確かな情報
- 前置き・説明・メタコメント

該当なし→必ず [] を返す。JSON配列のみ出力。説明文不要。

会話:
${recent}`
      }]
    });

    const text = r.content[0]?.text?.trim() || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    let facts;
    try { facts = JSON.parse(match[0]); } catch { return; }
    if (!Array.isArray(facts) || facts.length === 0) return;

    // 既存メモリを取得して重複チェック用に使う
    const existing = db.prepare('SELECT memory FROM user_memories WHERE email=? ORDER BY id DESC LIMIT 20').all(email).map(r => r.memory);

    for (const fact of facts.slice(0, 2)) {
      if (typeof fact !== 'string') continue;
      const trimmed = fact.trim();
      // 最低文字数・ノイズパターン・重複チェック
      if (trimmed.length < 20) continue;
      if (MEMORY_NOISE_PATTERNS.some(p => p.test(trimmed))) continue;
      if (existing.some(e => e.includes(trimmed.slice(0, 20)))) continue;
      db.prepare('INSERT INTO user_memories (email, memory) VALUES (?,?)').run(email, trimmed.slice(0, 200));
    }
  } catch(e) {
    console.error('[memory] extraction failed:', e.message);
  }
}

// ── Hooks Executor ──
async function executeHooks(hookType, skillInfo, ownerEmail, result) {
  try {
    const hooks = db.prepare(
      'SELECT * FROM skill_hooks WHERE owner_email=? AND enabled=1 AND hook_type=? AND (skill_id IS NULL OR skill_id=?)'
    ).all(ownerEmail, hookType, skillInfo.id || null);
    for (const hook of hooks) {
      const config = JSON.parse(hook.config || '{}');
      if (hook.action === 'chatwork_notify') {
        const roomId = config.room_id;
        const sysToken = process.env.CHATWORK_SYSTEM_TOKEN;
        if (roomId && sysToken) {
          const msg = `[info][title]🔔 ${hookType === 'post_run' ? '実行完了' : '実行開始'}: ${skillInfo.title}[/title]${(result || '').slice(0, 500)}[/info]`;
          await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
            method: 'POST',
            headers: { 'X-ChatWorkToken': sysToken, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ body: msg }).toString()
          }).catch(() => {});
        }
      } else if (hook.action === 'run_skill' && hookType === 'post_run') {
        const nextSkillId = config.skill_id;
        if (nextSkillId) {
          const nextSkill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(nextSkillId, ownerEmail);
          if (nextSkill) {
            runSkillBackground({ ...nextSkill, skill_name: nextSkill.name, skill_title: nextSkill.title }, ownerEmail).catch(() => {});
          }
        }
      }
    }
  } catch(e) {
    console.error('[hooks] execution error:', e.message);
  }
}

// ── Tool Definitions ──
const TOOLS = [
  {
    name: 'query_corp_db',
    description: '社内MySQL DB（corp_acro_jp）をSELECTで照会する。アロウリスト方式：照会可能なテーブルは kintone_employees / kintone_contract / kintone_anken_eigyo / geppo_data / kintone_customers / kintone_seikyu / hotprofile_business_cards（名刺データ・18,134件）/ it_kyujin_job_acrovision（求人データ）の8つのみ。これ以外のテーブルは拒否される。',
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
    name: 'list_zoom_meetings',
    description: 'Zoom: 自分の予定/過去の会議一覧を取得',
    input_schema: { type: 'object', properties: {
      type: { type: 'string', enum: ['scheduled','live','upcoming','previous_meetings'], description: '既定: upcoming' },
      page_size: { type: 'number', description: '既定30、最大300' }
    } }
  },
  {
    name: 'create_zoom_meeting',
    description: 'Zoom: 新規会議を作成。2段階承認必須（confirmedなしでプレビュー→承認→confirmed:true）',
    input_schema: { type: 'object', properties: {
      topic: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601 (例: 2026-06-01T09:00:00+09:00)' },
      duration: { type: 'number', description: '分。既定60' },
      agenda: { type: 'string' },
      confirmed: { type: 'boolean' }
    }, required: ['topic','start_time'] }
  },
  {
    name: 'call_freee_api',
    description: 'freee 会計のAPIを呼び出す。GET以外は2段階承認必須。https://accounts.secure.freee.co.jp/api/docs',
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET','POST','PUT','DELETE'] },
      path: { type: 'string', description: '/api/1/deals など' },
      query: { type: 'object' },
      body: { type: 'object' },
      confirmed: { type: 'boolean' }
    }, required: ['method','path'] }
  },
  {
    name: 'call_mfcloud_api',
    description: 'マネーフォワード クラウドのAPIを呼び出す。GET以外は2段階承認必須。',
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET','POST','PUT','DELETE'] },
      path: { type: 'string' },
      query: { type: 'object' },
      body: { type: 'object' },
      confirmed: { type: 'boolean' }
    }, required: ['method','path'] }
  },
  {
    name: 'call_salesforce_api',
    description: 'Salesforce REST APIを呼び出す。SOQL検索やオブジェクトCRUD。GET以外は2段階承認必須。',
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET','POST','PATCH','DELETE'] },
      path: { type: 'string', description: '/services/data/v60.0/query?q=SELECT... など' },
      body: { type: 'object' },
      confirmed: { type: 'boolean' }
    }, required: ['method','path'] }
  },
  {
    name: 'call_hubspot_api',
    description: 'HubSpot CRM APIを呼び出す。コンタクト/会社/取引の参照・操作。GET以外は2段階承認必須。',
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET','POST','PATCH','DELETE'] },
      path: { type: 'string', description: '/crm/v3/objects/contacts など' },
      query: { type: 'object' },
      body: { type: 'object' },
      confirmed: { type: 'boolean' }
    }, required: ['method','path'] }
  },
  {
    name: 'call_lineworks_api',
    description: 'LINE WORKS APIを呼び出す（Bot/Channels等）。GET以外は2段階承認必須。',
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET','POST','PUT','DELETE'] },
      path: { type: 'string', description: '/v1.0/bots/{botId}/channels/{channelId}/messages など' },
      body: { type: 'object' },
      confirmed: { type: 'boolean' }
    }, required: ['method','path'] }
  },
  {
    name: 'extract_receipt',
    description: '領収書/レシート/請求書の画像（またはDrive画像/PDFファイル）から金額・日付・店名等を構造化JSONで抽出する。Claudeビジョンで解析。',
    input_schema: { type: 'object', properties: {
      file_id: { type: 'string', description: 'Driveの画像/PDFファイルID' },
      extra_fields: { type: 'array', description: '追加抽出フィールド名', items: { type: 'string' } }
    }, required: ['file_id'] }
  },
  {
    name: 'mask_pii',
    description: 'テキスト中の個人情報（メール/電話/クレカ/マイナンバー/郵便番号）をマスクして返す。外部送信前のサニタイズに。',
    input_schema: { type: 'object', properties: {
      text: { type: 'string' },
      keep: { type: 'array', description: 'マスクしない種別 (email/phone/credit_card/mynumber/postal_code)', items: { type: 'string' } }
    }, required: ['text'] }
  },
  {
    name: 'review_contract',
    description: '契約書（PDF/Docx/テキスト）を法務観点でレビューし、リスク・確認ポイントを抽出する。LLMによる参考意見のため最終確認は法務担当へ。',
    input_schema: { type: 'object', properties: {
      file_id: { type: 'string', description: 'DriveのPDF/Docxファイルid' },
      focus: { type: 'array', description: '重点観点 (liability/term/cancellation/payment/confidentiality/ip 等)', items: { type: 'string' } },
      counterparty: { type: 'string', description: '相手方の立場で見るか自社視点か（default: 自社）' }
    }, required: ['file_id'] }
  },
  {
    name: 'transcribe_audio',
    description: '音声/動画ファイルを文字起こしする。Whisper API (OpenAI) 経由。MP3/M4A/WAV/MP4等対応。',
    input_schema: { type: 'object', properties: {
      file_id: { type: 'string', description: 'Driveの音声/動画ファイルID' },
      language: { type: 'string', description: 'ja / en など（既定: ja）' }
    }, required: ['file_id'] }
  },
  {
    name: 'compare_models',
    description: '同じプロンプトを複数のClaudeモデル（Sonnet/Haiku）に並列実行して回答を比較する。各モデルの違いを見たいときに使う。',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        models: { type: 'array', description: '使うモデルキー配列（haiku/sonnet）。省略時は両方', items: { type: 'string', enum: ['haiku', 'sonnet'] } },
        max_tokens: { type: 'number', description: '各モデルの最大トークン（既定 800）' }
      },
      required: ['prompt']
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
    description: 'Google DriveのファイルID指定で各種ファイルを読む。対応: Google Docs/Sheets/Slides、テキスト/CSV/JSON、画像(JPEG/PNG/GIF/WebP, 5MBまで)、PDF(32MBまで)、Excel(.xlsx/.xls)、Word(.docx)。Sheets/Excelの場合 sheet_name で特定タブを取得。画像・PDFは Claude に自動添付され内容について直接質問できる。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        sheet_name: { type: 'string', description: 'Sheets限定。特定タブ名（例: "延長"）。省略時は全タブ名を返し、先頭タブの内容を取得' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'update_sheet_range',
    description: 'Google Sheetsの指定範囲にデータを書き込む。必ず2段階で呼ぶこと: ①最初に confirmed なしで呼ぶとプレビュー（書き込まずに対象シート名・現在の値・書き込み後の値を返す）→ ②ユーザーに見せて明示的に「OK」「実行して」等の承認を得てから confirmed:true で再度呼ぶ → 実際に書き込まれる。スケジュールタスクから呼ぶ場合は、タスクのsteps定義に「書き込みを行う」と明記しておけば confirmed:true で直接呼んでよい。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'スプレッドシートのID' },
        range: { type: 'string', description: 'A1記法の範囲（例: "バースデー制度!J100" "シート1!A2:C5"）' },
        values: { type: 'array', description: '2次元配列。各要素が行、各要素の要素がセル値（例: [["2800"]]）', items: { type: 'array', items: {} } },
        confirmed: { type: 'boolean', description: 'true の場合のみ実際に書き込む。falseまたは省略時はプレビューを返す' }
      },
      required: ['file_id', 'range', 'values']
    }
  },
  {
    name: 'append_sheet_rows',
    description: 'Google Sheetsの末尾にデータ行を追加する。ログ記録・新規レコード追加など既存データの後ろに追記したい場合に使う。update_sheet_rangeと同じく2段階フロー必須: ①confirmed なしでプレビュー → ②ユーザー承認後に confirmed:true で実行。スケジュールタスクからの呼出時は confirmed:true で直接呼んでよい。',
    input_schema: {
      type: 'object',
      properties: {
        file_id:    { type: 'string', description: 'スプレッドシートのID' },
        sheet_name: { type: 'string', description: 'タブ名（例: "Sheet1"、"ログ"）。省略時は先頭タブ' },
        values:     { type: 'array', description: '追加する行の2次元配列（例: [["2024-01-01","田中","完了"]]）', items: { type: 'array', items: {} } },
        confirmed:  { type: 'boolean', description: 'true の場合のみ実際に追記する。省略時はプレビューを返す' }
      },
      required: ['file_id', 'values']
    }
  },
  {
    name: 'search_drive_files',
    description: 'Google Driveをファイル名・本文・MIMEタイプ・所有者・期間で検索する。fullTextオプションで本文全文検索可能。',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: '検索文字列' },
        full_text:   { type: 'boolean', description: 'true: 本文も含めて検索。false（既定）: ファイル名のみ' },
        mime_type:   { type: 'string', description: 'MIMEタイプフィルタ（例: application/vnd.google-apps.spreadsheet）' },
        owner:       { type: 'string', description: 'オーナー email でフィルタ（任意）' },
        modified_after:  { type: 'string', description: 'YYYY-MM-DD 以降に変更されたもの（任意）' },
        max_results: { type: 'number', description: '最大件数（デフォルト20、最大100）' }
      },
      required: ['query']
    }
  },
  // fetch_corp_api / fetch_corp_page は corp 側 /api/agent.php が現在閉鎖中（503）のため
  // 一時的にツール定義から除外しています。corp が再開されたら復活させてください。
  // 復活時の参照: CORP_API_ALLOWED, executeTool 内の case 'fetch_corp_api' / 'fetch_corp_page'
  {
    name: 'list_calendar_events',
    description: 'Googleカレンダーの予定一覧を取得する。ユーザー自身のプライマリカレンダーを参照。',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '今日から何日分取得するか（デフォルト7）' },
        max_results: { type: 'number', description: '最大件数（デフォルト20）' }
      }
    }
  },
  {
    name: 'list_gmail_messages',
    description: 'Gmailの受信トレイのメール一覧を取得する。件名・差出人・日時・スニペットを返す。',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: '最大件数（デフォルト20）' },
        query: { type: 'string', description: 'Gmail検索クエリ（例: "from:xxx@example.com", "subject:見積", "is:unread"）' }
      }
    }
  },
  {
    name: 'register_task',
    description: 'ユーザーの依頼に基づいてタスクを登録する。定期タスク（繰り返し実行）または単発タスク（指定日時に1回だけ実行）を設定できる。ユーザーが「毎朝〇〇して」「来週月曜に〇〇して」などと言った場合にこのツールを使う。',
    input_schema: {
      type: 'object',
      properties: {
        task_type:   { type: 'string', enum: ['recurring','once'], description: '定期実行=recurring、単発実行=once' },
        skill_name:  { type: 'string', description: 'タスクの短い名前（例: 朝礼メッセージ送信）' },
        skill_title: { type: 'string', description: 'タスクの表示タイトル（省略時はskill_nameと同じ）' },
        description: { type: 'string', description: 'タスクの目的・概要' },
        steps:       { type: 'string', description: 'AIが実行する具体的な手順・指示（Markdown形式）' },
        schedule_type:   { type: 'string', enum: ['interval','daily','weekly'], description: '繰り返しパターン。interval=間隔指定（省略時デフォルト）、daily=毎日指定時刻、weekly=毎週指定曜日・時刻' },
        interval_min:    { type: 'number', description: 'schedule_type=intervalのときの間隔（分）。30/60/120/240/480/1440など。省略時60' },
        schedule_hour:   { type: 'number', description: 'daily/weeklyのとき実行する時刻（時・JST）。例: 9=9時' },
        schedule_minute: { type: 'number', description: 'daily/weeklyのとき実行する時刻（分）。省略時0' },
        schedule_weekday:{ type: 'number', description: 'weeklyのとき実行する曜日。0=日/1=月/2=火/3=水/4=木/5=金/6=土' },
        run_at:          { type: 'string', description: '単発タスクの実行日時（ISO 8601形式 例: 2025-06-01T09:00:00）' },
        model:           { type: 'string', description: '使用AIモデル。sonnet（Claude Sonnet 4.6）/ haiku（Claude Haiku 4.5）/ openrouter:モデルID / deepinfra:モデルID。省略時はsonnet' }
      },
      required: ['task_type', 'skill_name', 'steps']
    }
  },
  {
    name: 'send_system_notification',
    description: 'システム通知専用Chatworkアカウントからメッセージを送信する。個人アカウントではなくシステムボットとして通知される。ルーム内のメッセージ参照・ルーム一覧取得はできない（送信専用）。定期タスクや自動通知に使用する。ユーザー確認不要で送信可能。',
    input_schema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: '送信先のChatworkルームID' },
        body:    { type: 'string', description: '送信するメッセージ本文（Chatwork記法可）' }
      },
      required: ['room_id', 'body']
    }
  },
  {
    name: 'fetch_url',
    description: '任意のWebページのURLを取得して内容をテキストとして返す。競合調査・ニュース取得・公開情報の参照に使う。HTMLは自動でテキストに変換される（タグ除去）。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '取得するURL（https://...）' },
        mode: { type: 'string', enum: ['text', 'html', 'json'], description: 'text=タグ除去テキスト(既定) / html=生HTML / json=JSONパース結果' }
      },
      required: ['url']
    }
  },
  {
    name: 'send_gmail',
    description: 'Gmailからメールを送信する。必ず2段階フロー: ①confirmed なしで呼ぶ → プレビューを返す → ②ユーザーに「○○宛に件名○○で送ります。よろしいですか？」と提示 → ③ユーザー承認 → ④confirmed:true で再呼出して送信。スケジュールタスクからは confirmed:true で直接送信可。',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '宛先メールアドレス（カンマ区切りで複数可）' },
        subject: { type: 'string', description: '件名' },
        body: { type: 'string', description: '本文（プレーンテキスト）' },
        cc: { type: 'string', description: 'CC（任意）' },
        bcc: { type: 'string', description: 'BCC（任意）' },
        confirmed: { type: 'boolean', description: 'true の場合のみ実際に送信。falseまたは省略時はプレビュー' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Googleカレンダーに予定を新規作成する。必ず2段階フロー: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。日時はISO 8601形式（例: 2026-06-01T09:00:00+09:00）。スケジュールタスクからは confirmed:true で直接実行可。',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '予定タイトル' },
        start: { type: 'string', description: '開始日時 ISO 8601 (例: 2026-06-01T09:00:00+09:00)' },
        end: { type: 'string', description: '終了日時 ISO 8601 (例: 2026-06-01T10:00:00+09:00)' },
        description: { type: 'string', description: '予定の詳細（任意）' },
        location: { type: 'string', description: '場所（任意）' },
        attendees: { type: 'array', description: '参加者のメールアドレス配列（任意）', items: { type: 'string' } },
        confirmed: { type: 'boolean', description: 'true の場合のみ実際に作成' }
      },
      required: ['summary', 'start', 'end']
    }
  },
  {
    name: 'create_drive_file',
    description: 'Google Driveに新規ファイルを作成する。対応: Google Docs(text), Google Sheets(CSV文字列), 通常テキストファイル。必ず2段階フロー: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'ファイル名' },
        type: { type: 'string', enum: ['doc', 'sheet', 'text'], description: 'doc=Google Docs, sheet=Google Sheets, text=テキストファイル' },
        content: { type: 'string', description: 'ファイル内容。docはプレーンテキスト、sheetはCSV、textはそのまま' },
        folder_id: { type: 'string', description: '保存先フォルダID（任意。省略時はマイドライブ直下）' },
        confirmed: { type: 'boolean', description: 'true の場合のみ実際に作成' }
      },
      required: ['name', 'type', 'content']
    }
  },
  {
    name: 'call_ms_graph',
    description: 'Microsoft 365のGraph APIを呼び出す。Outlook/Teams/OneDrive/SharePointのデータを取得・操作。GET以外（POST/PATCH/DELETE等）は2段階承認必須: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET','POST','PATCH','DELETE','PUT'], description: 'HTTPメソッド' },
        path: { type: 'string', description: '/me/messages, /me/drive/root/children など。先頭スラッシュ必須' },
        query: { type: 'object', description: 'クエリパラメータ（任意）' },
        body: { type: 'object', description: 'リクエストボディ（POST/PATCH時）' },
        confirmed: { type: 'boolean', description: 'GET以外で必須' }
      },
      required: ['method', 'path']
    }
  },
  {
    name: 'list_slack_channels',
    description: 'Slackのチャンネル一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        types: { type: 'string', description: 'public_channel,private_channel など（既定: public_channel）' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_slack_messages',
    description: 'Slackチャンネルの最近のメッセージを取得する。',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'チャンネルID' },
        limit: { type: 'number', description: '取得件数（既定20、最大200）' }
      },
      required: ['channel']
    }
  },
  {
    name: 'send_slack_message',
    description: 'Slackチャンネルにメッセージを送信する。必ず2段階フロー: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'チャンネルID または #channel-name' },
        text: { type: 'string', description: 'メッセージ本文（Slack mrkdwn）' },
        thread_ts: { type: 'string', description: 'スレッド返信時の親メッセージ ts（任意）' },
        confirmed: { type: 'boolean' }
      },
      required: ['channel', 'text']
    }
  },
  {
    name: 'list_notion_databases',
    description: 'Notionの利用可能データベース一覧を取得する（Integrationに共有されたDBのみ表示）。',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: '名前で絞り込み（任意）' } } }
  },
  {
    name: 'query_notion_database',
    description: 'Notionデータベースのページ一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        filter: { type: 'object', description: 'Notion filter object（任意）' },
        sorts: { type: 'array', description: 'Notion sorts配列（任意）', items: {} },
        page_size: { type: 'number', description: '取得件数（最大100、既定20）' }
      },
      required: ['database_id']
    }
  },
  {
    name: 'create_notion_page',
    description: 'Notionデータベースに新規ページを作成する。必ず2段階フロー: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。',
    input_schema: {
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        properties: { type: 'object', description: 'Notion properties object（DB スキーマに準拠）' },
        children: { type: 'array', description: 'ページ本文ブロック配列（任意）', items: {} },
        confirmed: { type: 'boolean' }
      },
      required: ['database_id', 'properties']
    }
  },
  {
    name: 'update_notion_page',
    description: 'Notionの既存ページのプロパティを更新する。必ず2段階フロー必須。',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        properties: { type: 'object' },
        confirmed: { type: 'boolean' }
      },
      required: ['page_id', 'properties']
    }
  },
  {
    name: 'export_data_csv',
    description: 'データ配列をCSVファイルとしてGoogle Driveに保存する。query_corp_dbの結果などを直接保存可能。',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'ファイル名（拡張子なし）' },
        rows: { type: 'array', description: 'データ。各要素はオブジェクトまたは配列', items: {} },
        headers: { type: 'array', description: '列ヘッダー（任意。省略時は1行目のキーから推測）', items: { type: 'string' } },
        folder_id: { type: 'string' }
      },
      required: ['file_name', 'rows']
    }
  },
  {
    name: 'export_data_excel',
    description: 'データをExcel(.xlsx)ファイルとしてGoogle Driveに保存する。複数シート対応。',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        sheets: { type: 'object', description: '{ "シート名": [{col1, col2}, ...] } 形式' },
        folder_id: { type: 'string' }
      },
      required: ['file_name', 'sheets']
    }
  },
  {
    name: 'generate_chart',
    description: 'Chart.js設定からグラフ画像(PNG)を生成してGoogle Driveに保存する。QuickChart.io経由。棒/折れ線/円/ドーナツ等対応。',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        chart: { type: 'object', description: 'Chart.js v3 形式の設定オブジェクト（type, data, options）' },
        width: { type: 'number', description: '画像幅 px（既定800）' },
        height: { type: 'number', description: '画像高さ px（既定400）' },
        folder_id: { type: 'string' }
      },
      required: ['file_name', 'chart']
    }
  },
  {
    name: 'generate_pdf_report',
    description: 'PDFレポートを生成してGoogle Driveに保存する。タイトル＋本文セクション＋表対応。',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string', description: '作成者名（任意）' },
        sections: {
          type: 'array',
          description: 'セクション配列。各要素 { heading?, text?, table? } table=2次元配列で表を埋め込み',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              text: { type: 'string' },
              table: { type: 'array', items: { type: 'array', items: {} } }
            }
          }
        },
        folder_id: { type: 'string' }
      },
      required: ['file_name', 'sections']
    }
  },
  {
    name: 'create_pptx',
    description: 'PowerPoint (.pptx) ファイルを作成してGoogleDriveに保存する。提案書・社内資料・報告書を自動生成。必ず2段階フロー: ①confirmed なしでプレビュー → ②ユーザー承認 → ③confirmed:true で実行。',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'ファイル名（.pptx 拡張子なしで指定）' },
        title: { type: 'string', description: 'プレゼンテーション全体のタイトル（メタデータ）' },
        author: { type: 'string', description: '作成者名（任意）' },
        slides: {
          type: 'array',
          description: 'スライド配列。各要素: { layout, title?, subtitle?, bullets?, body?, left?, right? }',
          items: {
            type: 'object',
            properties: {
              layout: { type: 'string', enum: ['title', 'bullets', 'content', 'two_column', 'section'], description: 'title=タイトル, bullets=箇条書き, content=自由テキスト, two_column=2カラム, section=セクション区切り' },
              title: { type: 'string' },
              subtitle: { type: 'string', description: 'titleレイアウトで使用' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'bulletsレイアウトで使用' },
              body: { type: 'string', description: 'contentレイアウトで使用' },
              left: { type: 'string', description: 'two_columnの左カラム' },
              right: { type: 'string', description: 'two_columnの右カラム' }
            }
          }
        },
        folder_id: { type: 'string', description: 'Drive保存先フォルダID（任意）' },
        confirmed: { type: 'boolean' }
      },
      required: ['file_name', 'slides']
    }
  },
  {
    name: 'run_subagents',
    description: '複数のサブタスクを並列サブエージェントで実行する。独立した作業を同時並行で処理できる（最大3つ）。大きなタスクを分割して効率化したいときに使う。',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '並列実行するサブタスクのリスト（最大3件）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'サブタスクのタイトル' },
              steps: { type: 'string', description: '実行手順（具体的に記述）' }
            },
            required: ['title', 'steps']
          },
          maxItems: 3
        }
      },
      required: ['tasks']
    }
  },
  {
    name: 'create_meeting_minutes',
    description: '会議の文字起こし・メモ・テキストから議事録を自動生成する。決定事項・TODO（担当者・期限）・議題を構造化出力。Google Docsへの保存も可能。',
    input_schema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: '会議の文字起こしテキスト・メモ・要約（10万文字まで）' },
        title: { type: 'string', description: '会議タイトル（任意）' },
        date: { type: 'string', description: '会議日 YYYY-MM-DD（任意、省略時は今日）' },
        attendees: { type: 'string', description: '参加者（任意、例: 田中、山田、佐藤）' },
        save_to_drive: { type: 'boolean', description: 'true にするとGoogle Docsに議事録を保存してリンクを返す' }
      },
      required: ['transcript']
    }
  },
  {
    name: 'check_server_health',
    description: '指定URLのサーバーヘルスチェックを実行。HTTP応答ステータス・応答時間・SSLを一括チェックして結果を返す。定期監視スキルにも利用可能。',
    input_schema: {
      type: 'object',
      properties: {
        urls: { type: 'array', description: 'チェックするURLの配列（最大20件）', items: { type: 'string' } },
        timeout_ms: { type: 'number', description: 'タイムアウト（ミリ秒、デフォルト10000）' }
      },
      required: ['urls']
    }
  },
  {
    name: 'check_job_posting',
    description: '求人原稿をAIがチェックし、品質・法令遵守・訴求力を評価する。問題箇所・改善提案・改善例文を返す。掲載前の品質管理に使用。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '求人原稿のテキスト（職種・仕事内容・応募資格・待遇等）' },
        job_type: { type: 'string', description: '求人種別（正社員/派遣/パート/アルバイト/業務委託など）' },
        focus: { type: 'array', description: '重点チェック観点（compliance=法令遵守, appeal=訴求力, clarity=明確さ, salary=給与記載, discrimination=差別表現）省略時は全観点', items: { type: 'string' } }
      },
      required: ['text']
    }
  },
  {
    name: 'generate_weekly_report',
    description: '管理者向け週次レポートを社内DBから自動生成。案件数・月報提出状況・請求サマリー・顧客数を集計。管理者・業務管理部のみ実行可能。Chatwork通知も可能。',
    input_schema: {
      type: 'object',
      properties: {
        month_start: { type: 'string', description: '集計月の開始日（YYYY-MM-DD、省略時は今月1日）' },
        include: { type: 'array', description: '含める項目（anken/geppo/seikyu/customer）省略時は全て', items: { type: 'string' } },
        notify_room_id: { type: 'string', description: '完成後にChatwork通知するルームID（任意）' }
      }
    }
  },
  {
    name: 'generate_presentation',
    description: 'テーマや要件を渡すだけでAIがスライド構成を設計し、PowerPointファイルを自動生成してGoogle Driveに保存する。スライドの内容・構成・デザインをAIが全て決定する。',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'プレゼンのテーマ・タイトル（例：「2025年度事業計画」「新サービス紹介」）' },
        purpose: { type: 'string', description: 'プレゼンの目的・用途（例：社内報告/顧客提案/採用説明会）' },
        audience: { type: 'string', description: '対象聴衆（例：経営陣/営業チーム/新入社員）' },
        slide_count: { type: 'number', description: 'スライド枚数（5〜15推奨、省略時は8枚）' },
        key_points: { type: 'array', description: '必ず含めたいポイントや情報', items: { type: 'string' } },
        folder_id: { type: 'string', description: '保存先Google DriveフォルダID（省略時はマイドライブ）' }
      },
      required: ['topic']
    }
  },
  {
    name: 'summarize_document',
    description: 'Google Drive上のWord・PDF・Googleドキュメント・テキストファイルを読み込み、内容を要約する。議事録・報告書・仕様書・マニュアルなど幅広い文書に対応。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google DriveのファイルID' },
        focus: { type: 'string', description: '要約の観点・重点（例：「結論と課題のみ」「数値と日程を重点的に」、省略時は全体要約）' },
        output_format: { type: 'string', description: '出力形式（bullets=箇条書き / prose=文章形式、省略時はbullets）' },
        max_length: { type: 'number', description: '要約の最大文字数（省略時は500文字）' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'draft_email_reply',
    description: '受信メールや文章を渡すと、適切な返信メールの下書きを自動生成する。件名・本文・署名の構成で出力。トーン（丁寧/通常/簡潔）を指定可能。',
    input_schema: {
      type: 'object',
      properties: {
        original_email: { type: 'string', description: '返信元のメール本文または要約（必須）' },
        reply_intent: { type: 'string', description: '返信の意図・内容（例：「承諾」「日程調整を依頼」「断る」「問い合わせへの回答」）' },
        tone: { type: 'string', description: 'トーン（formal=丁寧/standard=通常/brief=簡潔、省略時はstandard）' },
        sender_name: { type: 'string', description: '差出人名（署名に使用、省略時はユーザー名）' },
        additional_info: { type: 'string', description: '返信に含めたい追加情報（日程候補・補足説明など）' }
      },
      required: ['original_email']
    }
  },
  {
    name: 'screen_candidate',
    description: '候補者の情報（履歴書・職務経歴書テキストや詳細）と求人要件を照合し、適合度をスコアリングして採用判断の参考情報を提供する。採用担当者の一次スクリーニングを支援。',
    input_schema: {
      type: 'object',
      properties: {
        candidate_info: { type: 'string', description: '候補者の情報（履歴書・職務経歴書のテキスト、または氏名・経歴・スキルの要約）' },
        job_requirements: { type: 'string', description: '求人要件（職種・必須スキル・歓迎スキル・経験年数・資格など）' },
        evaluation_criteria: { type: 'array', description: '重視する評価軸（例：technical_skill/communication/leadership/cultural_fit）省略時は総合評価', items: { type: 'string' } },
        job_type: { type: 'string', description: '雇用形態（正社員/派遣/契約社員など、省略時は正社員）' }
      },
      required: ['candidate_info', 'job_requirements']
    }
  },
  {
    name: 'bulk_register_kintone',
    description: 'Google Drive上のExcel/CSVファイルを読み込み、Kintoneアプリへ一括登録する。confirmed:falseでプレビュー、confirmed:trueで実行。KINTONE_DOMAIN・KINTONE_API_TOKEN環境変数が必要。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google DriveのExcel(.xlsx)またはCSV(.csv)ファイルID' },
        app_id:  { type: 'string', description: 'Kintoneアプリのアプリ番号（URLの /k/{app_id}/ の部分）' },
        field_mapping: { type: 'object', description: 'Excelの列名とKintoneフィールドコードのマッピング（省略時はヘッダー行をそのままフィールドコードとして使用）例: {"会社名": "company", "担当者": "person"}' },
        confirmed: { type: 'boolean', description: 'trueにすると実際に登録を実行。falseまたは省略時はプレビューのみ（必ずプレビューを先に見せること）' }
      },
      required: ['file_id', 'app_id']
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
      if (!['admin','gyoumu'].includes(dbRole)) {
        audit(user.email, user.name, 'tool.db.denied', { reason: 'role', role: dbRole, preview: (input.sql || '').slice(0, 100) });
        throw new Error('DBの直接照会は業務管理部・管理者のみ許可されています');
      }
      const { sql, params = [] } = input;
      if (DB_BLOCKED_KEYWORDS.test(sql)) {
        audit(user.email, user.name, 'tool.db.denied', { reason: 'keyword', preview: sql.slice(0, 100) });
        throw new Error('SELECT のみ許可（SHOW/DESCRIBE等は不可）');
      }
      const allowCheck = checkSqlAllowed(sql);
      if (!allowCheck.ok) {
        audit(user.email, user.name, 'tool.db.denied', { reason: 'table', table: allowCheck.table, preview: sql.slice(0, 100) });
        throw new Error(DB_DENIED_MESSAGE(sql));
      }
      audit(user.email, user.name, 'tool.db', { preview: sql.slice(0, 100) });
      const [rows] = await pool.execute(sql, params);
      return { rows: rows.slice(0, 200), count: rows.length };
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
      if (!process.env.SES_FROM) throw new Error('SES未設定');
      if (!isAdmin) throw new Error('管理者のみメール送信可能です');
      audit(user.email, user.name, 'tool.email', { to: input.to, subject: input.subject?.slice(0, 50) });
      const info = await getSesTransport().sendMail({ from: process.env.SES_FROM || 'info@acrovision.co.jp', to: input.to, subject: input.subject, text: input.text, html: input.html });
      return { ok: true, messageId: info.messageId };
    }
    case 'list_zoom_meetings': {
      const tok = await getZoomToken();
      const type = input.type || 'upcoming';
      const ps = Math.min(input.page_size || 30, 300);
      audit(user.email, user.name, 'tool.zoom_list', { type });
      const r = await fetch(`https://api.zoom.us/v2/users/me/meetings?type=${type}&page_size=${ps}`, { headers: { Authorization: 'Bearer ' + tok } });
      const d = await r.json();
      if (!r.ok) throw new Error(`Zoom error: ${d.message || r.status}`);
      return (d.meetings || []).map(m => ({ id: m.id, topic: m.topic, start_time: m.start_time, duration: m.duration, join_url: m.join_url }));
    }
    case 'create_zoom_meeting': {
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.zoom_create.preview', { topic: input.topic });
        return { preview: true, message: 'Zoom会議作成プレビュー。承認後 confirmed:true で再呼出。', topic: input.topic, start_time: input.start_time, duration: input.duration || 60, agenda: input.agenda };
      }
      const tok = await getZoomToken();
      audit(user.email, user.name, 'tool.zoom_create.execute', { topic: input.topic });
      const r = await fetch('https://api.zoom.us/v2/users/me/meetings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: input.topic, type: 2, start_time: input.start_time, duration: input.duration || 60, agenda: input.agenda })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`Zoom error: ${d.message || r.status}`);
      return { ok: true, id: d.id, topic: d.topic, start_time: d.start_time, join_url: d.join_url, start_url: d.start_url };
    }
    case 'call_freee_api':
      return await callGenericApi(user, input, 'freee', 'https://api.freee.co.jp', process.env.FREEE_TOKEN, 'FREEE_TOKEN');
    case 'call_mfcloud_api':
      return await callGenericApi(user, input, 'mfcloud', 'https://invoice.moneyforward.com', process.env.MFCLOUD_TOKEN, 'MFCLOUD_TOKEN');
    case 'call_salesforce_api':
      return await callGenericApi(user, input, 'salesforce', process.env.SALESFORCE_INSTANCE_URL || '', process.env.SALESFORCE_TOKEN, 'SALESFORCE_TOKEN');
    case 'call_hubspot_api':
      return await callGenericApi(user, input, 'hubspot', 'https://api.hubapi.com', process.env.HUBSPOT_TOKEN, 'HUBSPOT_TOKEN');
    case 'call_lineworks_api':
      return await callGenericApi(user, input, 'lineworks', 'https://www.worksapis.com', process.env.LINEWORKS_TOKEN, 'LINEWORKS_TOKEN');
    case 'extract_receipt': {
      audit(user.email, user.name, 'tool.extract_receipt', { fileId: input.file_id });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const mt = meta.data.mimeType;
      const isPdf = mt === 'application/pdf';
      const isImg = mt?.startsWith('image/');
      if (!isPdf && !isImg) throw new Error(`${mt} は領収書抽出非対応（画像/PDFのみ）`);
      const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
      const buf = Buffer.from(r.data);
      const limit = isImg ? 5 * 1024 * 1024 : 32 * 1024 * 1024;
      if (buf.length > limit) throw new Error(`ファイルが大きすぎます（${(buf.length/1024/1024).toFixed(1)}MB > ${limit/1024/1024}MB）`);
      const block = isImg
        ? { type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
      const extra = (input.extra_fields || []).join(', ');
      const prompt = `この領収書/レシート/請求書から以下の情報を抽出し、有効なJSONのみで回答してください（前後のテキスト一切不要）:
{
  "vendor": "店舗名・発行元",
  "date": "YYYY-MM-DD",
  "total_amount": 数値,
  "currency": "JPY等",
  "tax_amount": 数値 or null,
  "tax_rate": 数値 or null,
  "items": [{"name": "...", "quantity": 数値, "unit_price": 数値, "amount": 数値}],
  "payment_method": "現金/カード/その他",
  "receipt_number": "領収書番号 or null",
  "category": "推測カテゴリ（飲食/交通/書籍/通信費等）",
  "confidence": "high/medium/low"${extra ? `,\n  ${input.extra_fields.map(f => `"${f}": ""`).join(',\n  ')}` : ''}
}
読み取れない項目は null にする。`;
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'JSON抽出失敗', raw: text };
      try { return { ok: true, extracted: JSON.parse(jsonMatch[0]), file_name: meta.data.name }; }
      catch (e) { return { error: 'JSONパース失敗: ' + e.message, raw: jsonMatch[0] }; }
    }
    case 'mask_pii': {
      audit(user.email, user.name, 'tool.mask_pii', { len: input.text?.length });
      const keep = new Set(input.keep || []);
      let s = String(input.text || '');
      const counts = {};
      const mask = (key, regex, label) => {
        if (keep.has(key)) return;
        let n = 0;
        s = s.replace(regex, () => { n++; return label; });
        if (n > 0) counts[key] = n;
      };
      mask('email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]');
      mask('phone', /(?:\+?81|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g, '[PHONE]');
      mask('credit_card', /\b(?:\d[ -]*?){13,19}\b/g, '[CARD]');
      mask('mynumber', /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[MYNUMBER]');
      mask('postal_code', /〒?\s?\d{3}-?\d{4}/g, '[POSTAL]');
      return { masked: s, counts, original_length: input.text?.length || 0 };
    }
    case 'review_contract': {
      audit(user.email, user.name, 'tool.review_contract', { fileId: input.file_id });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const mt = meta.data.mimeType;
      let documentBlock;
      let plainText = '';
      if (mt === 'application/pdf') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        documentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(r.data).toString('base64') } };
      } else if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const x = await mammoth.extractRawText({ buffer: Buffer.from(r.data) });
        plainText = x.value;
      } else if (mt === 'application/vnd.google-apps.document') {
        const r = await drive.files.export({ fileId: input.file_id, mimeType: 'text/plain' }, { responseType: 'text' });
        plainText = String(r.data);
      } else if (mt?.startsWith('text/')) {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'text' });
        plainText = String(r.data);
      } else {
        throw new Error(`${mt} はレビュー非対応（PDF/Word/Docs/text のみ）`);
      }
      const focus = (input.focus || ['liability','term','cancellation','payment','confidentiality','ip']).join(', ');
      const stance = input.counterparty ? `相手方（${input.counterparty}）の立場` : '自社の立場';
      const sys = `あなたは契約書レビューを支援するアシスタントです。${stance}で契約書を読み、リスクや確認すべき条項を指摘してください。あくまで参考意見であり最終判断は法務担当が行うことを前提に。重点観点: ${focus}`;
      const userBlocks = documentBlock
        ? [documentBlock, { type: 'text', text: '上記契約書をレビューしてください。下記JSON形式で回答してください（前後説明不要）:\n{"summary":"全体概要","risks":[{"clause":"条項","level":"high|medium|low","issue":"問題点","suggestion":"対応案"}],"checkpoints":["確認すべき事項"],"overall_score":"概ね妥当/要修正/危険"}' }]
        : [{ type: 'text', text: `契約書テキスト:\n\n${plainText.slice(0, 50000)}\n\n上記契約書をレビューしてください。下記JSON形式で回答してください（前後説明不要）:\n{"summary":"全体概要","risks":[{"clause":"条項","level":"high|medium|low","issue":"問題点","suggestion":"対応案"}],"checkpoints":["確認すべき事項"],"overall_score":"概ね妥当/要修正/危険"}` }];
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 4096, system: sys,
        messages: [{ role: 'user', content: userBlocks }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'JSON抽出失敗', raw: text };
      try { return { ok: true, file_name: meta.data.name, review: JSON.parse(jsonMatch[0]) }; }
      catch (e) { return { error: 'JSONパース失敗: ' + e.message, raw: jsonMatch[0] }; }
    }
    case 'transcribe_audio': {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未設定。Whisper API利用にはOpenAI APIキーを管理者に依頼してください');
      audit(user.email, user.name, 'tool.transcribe', { fileId: input.file_id });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType,size' });
      const size = parseInt(meta.data.size || '0', 10);
      if (size > 25 * 1024 * 1024) throw new Error(`Whisper APIは25MBまで（実際: ${(size/1024/1024).toFixed(1)}MB）`);
      const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
      const buf = Buffer.from(r.data);
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: meta.data.mimeType }), meta.data.name);
      fd.append('model', 'whisper-1');
      fd.append('language', input.language || 'ja');
      const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
        body: fd
      });
      const d = await tr.json();
      if (!tr.ok) throw new Error(`Whisper error: ${d.error?.message || tr.status}`);
      return { ok: true, file_name: meta.data.name, text: d.text };
    }
    case 'compare_models': {
      const MODEL_MAP = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6' };
      const models = (input.models && input.models.length > 0) ? input.models : ['haiku', 'sonnet'];
      const maxTokens = input.max_tokens || 800;
      audit(user.email, user.name, 'tool.compare_models', { models, preview: input.prompt?.slice(0, 50) });
      const results = await Promise.all(models.map(async key => {
        const mid = MODEL_MAP[key];
        if (!mid) return { model: key, error: 'unknown model' };
        const t0 = Date.now();
        try {
          const r = await anthropic.messages.create({
            model: mid,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: input.prompt }]
          });
          const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          return {
            model: key,
            model_id: mid,
            elapsed_ms: Date.now() - t0,
            input_tokens: r.usage?.input_tokens,
            output_tokens: r.usage?.output_tokens,
            response: text
          };
        } catch (e) {
          return { model: key, model_id: mid, error: e.message };
        }
      }));
      // 使用量も合算で記録
      let totIn = 0, totOut = 0;
      for (const x of results) { totIn += x.input_tokens || 0; totOut += x.output_tokens || 0; }
      if (totIn || totOut) recordUsage(user.email, user.name, totIn, totOut, 'compare', 'tool.compare');
      return { models: results };
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
    case 'list_drive_files': {
      if (!/^[a-zA-Z0-9_-]+$/.test(input.folder_id || '')) throw new Error('無効なフォルダIDです');
      audit(user.email, user.name, 'tool.drive_list', { folderId: input.folder_id });
      const drive = getDriveClientForUser(user);
      const r = await drive.files.list({ q: `'${input.folder_id}' in parents and trashed=false`, fields: 'files(id,name,mimeType,modifiedTime,size)', orderBy: 'folder,name', pageSize: 100 });
      return r.data.files || [];
    }
    case 'read_drive_file': {
      audit(user.email, user.name, 'tool.drive_read', { fileId: input.file_id, sheetName: input.sheet_name });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const { mimeType, name } = meta.data;
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const sheets = getSheetsClientForUser(user);
        const ssMeta = await sheets.spreadsheets.get({ spreadsheetId: input.file_id, fields: 'sheets.properties(title,index,gridProperties.rowCount,gridProperties.columnCount)' });
        const allSheets = (ssMeta.data.sheets || []).map(s => s.properties);
        const targetTitle = input.sheet_name || allSheets[0]?.title;
        if (!targetTitle) throw new Error('スプレッドシートにタブがありません');
        if (input.sheet_name && !allSheets.some(s => s.title === input.sheet_name)) {
          return { id: input.file_id, name, mimeType, sheets: allSheets.map(s => s.title), error: `タブ「${input.sheet_name}」が見つかりません。利用可能: ${allSheets.map(s => s.title).join(', ')}` };
        }
        const values = await sheets.spreadsheets.values.get({ spreadsheetId: input.file_id, range: targetTitle });
        const rows = values.data.values || [];
        const csv = rows.map(r => r.map(c => {
          const s = String(c ?? '');
          return /[,\"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')).join('\n');
        return {
          id: input.file_id,
          name,
          mimeType,
          sheets: allSheets.map(s => s.title),
          sheet_name: targetTitle,
          rows: rows.length,
          content: csv.slice(0, 60000)
        };
      }
      const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (IMAGE_MIME.includes(mimeType)) {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const buf = Buffer.from(r.data);
        if (buf.length > 5 * 1024 * 1024) {
          return { id: input.file_id, name, mimeType, error: '画像が5MBを超えるため Claude に渡せません', size: buf.length };
        }
        return { id: input.file_id, name, mimeType, image: { mediaType: mimeType, base64: buf.toString('base64') } };
      }
      if (mimeType === 'application/pdf') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const buf = Buffer.from(r.data);
        if (buf.length > 32 * 1024 * 1024) {
          return { id: input.file_id, name, mimeType, error: 'PDFが32MBを超えるため Claude に渡せません', size: buf.length };
        }
        return { id: input.file_id, name, mimeType, pdf: { mediaType: 'application/pdf', base64: buf.toString('base64') } };
      }
      // .xls（旧形式）は非対応 — Google Driveで「Googleスプレッドシートとして開く」→再保存して.xlsxにしてください
      if (mimeType === 'application/vnd.ms-excel') {
        return { id: input.file_id, name, mimeType, error: '旧形式の .xls ファイルは読み込めません。Google Drive で「Googleスプレッドシートとして開く」→「ダウンロード → .xlsx」に変換してから再試行してください。' };
      }
      // Excel (.xlsx)
      if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(r.data));
        const sheetNames = wb.worksheets.map(s => s.name);
        const targetSheet = (input.sheet_name && sheetNames.includes(input.sheet_name)) ? input.sheet_name : sheetNames[0];
        if (input.sheet_name && !sheetNames.includes(input.sheet_name)) {
          return { id: input.file_id, name, mimeType, sheets: sheetNames, error: `シート「${input.sheet_name}」が見つかりません。利用可能: ${sheetNames.join(', ')}` };
        }
        const ws = wb.getWorksheet(targetSheet);
        const csvLines = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const vals = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            let v = '';
            const cv = cell.value;
            if (cv !== null && cv !== undefined) {
              if (typeof cv === 'object') {
                if (cv.text !== undefined) v = String(cv.text);
                else if (cv.result !== undefined) v = String(cv.result);
                else if (cv instanceof Date) v = cv.toISOString();
                else v = String(cv);
              } else {
                v = String(cv);
              }
            }
            if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"';
            vals.push(v);
          });
          csvLines.push(vals.join(','));
        });
        const csv = csvLines.join('\n');
        return { id: input.file_id, name, mimeType, sheets: sheetNames, sheet_name: targetSheet, content: csv.slice(0, 60000) };
      }
      // Word (.docx)
      if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const result = await mammoth.extractRawText({ buffer: Buffer.from(r.data) });
        return { id: input.file_id, name, mimeType, content: result.value.slice(0, 60000) };
      }
      // PowerPoint (.pptx) はテキスト抽出が複雑なので、未対応として明示
      if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        return { id: input.file_id, name, mimeType, error: 'PowerPoint(.pptx)は未対応です。Google スライドに変換するか、PDFに書き出してください' };
      }
      let content = '';
      if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation') {
        const r = await drive.files.export({ fileId: input.file_id, mimeType: 'text/plain' }, { responseType: 'text' });
        content = String(r.data);
      } else if (mimeType && (mimeType.startsWith('text/') || mimeType === 'application/json')) {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'text' });
        content = String(r.data);
      } else {
        throw new Error(`${mimeType} は読み取り非対応です`);
      }
      return { id: input.file_id, name, mimeType, content: content.slice(0, 60000) };
    }
    case 'update_sheet_range': {
      const sheets = getSheetsClientForUser(user);
      if (!input.confirmed) {
        // プレビュー: 現在の値を取得して、書き込み予定の値と並べて返す
        let current = [];
        try {
          const cur = await sheets.spreadsheets.values.get({ spreadsheetId: input.file_id, range: input.range });
          current = cur.data.values || [];
        } catch(e) { /* 範囲が空でも続行 */ }
        const meta = await sheets.spreadsheets.get({ spreadsheetId: input.file_id, fields: 'properties.title' });
        audit(user.email, user.name, 'tool.sheet_write.preview', { fileId: input.file_id, range: input.range });
        return {
          preview: true,
          message: 'これは書き込みプレビューです。ユーザーに対象シート・範囲・現在値・書き込む値を提示し、明示的な承認（「OK」「実行して」など）を得てから、同じパラメータに confirmed:true を追加して再度呼んでください。',
          spreadsheet_title: meta.data.properties?.title,
          range: input.range,
          current_values: current,
          new_values: input.values
        };
      }
      audit(user.email, user.name, 'tool.sheet_write.execute', { fileId: input.file_id, range: input.range, rows: input.values?.length });
      const r = await sheets.spreadsheets.values.update({
        spreadsheetId: input.file_id,
        range: input.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.values }
      });
      return {
        ok: true,
        updatedRange: r.data.updatedRange,
        updatedRows: r.data.updatedRows,
        updatedColumns: r.data.updatedColumns,
        updatedCells: r.data.updatedCells
      };
    }
    case 'append_sheet_rows': {
      const sheets = getSheetsClientForUser(user);
      const meta = await sheets.spreadsheets.get({ spreadsheetId: input.file_id, fields: 'properties.title,sheets.properties.title' });
      const allSheetTitles = (meta.data.sheets || []).map(s => s.properties.title);
      const targetSheet = input.sheet_name || allSheetTitles[0];
      if (!targetSheet) throw new Error('スプレッドシートにタブがありません');
      if (input.sheet_name && !allSheetTitles.includes(input.sheet_name)) {
        return { error: `タブ「${input.sheet_name}」が見つかりません。利用可能: ${allSheetTitles.join(', ')}` };
      }
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.sheet_append.preview', { fileId: input.file_id, sheet: targetSheet, rows: input.values?.length });
        return {
          preview: true,
          message: 'これは追記プレビューです。ユーザーに対象シート名・追記内容を提示し、明示的な承認（「OK」「実行して」など）を得てから confirmed:true を付けて再度呼んでください。',
          spreadsheet_title: meta.data.properties?.title,
          sheet_name: targetSheet,
          rows_to_append: input.values
        };
      }
      audit(user.email, user.name, 'tool.sheet_append.execute', { fileId: input.file_id, sheet: targetSheet, rows: input.values?.length });
      const r = await sheets.spreadsheets.values.append({
        spreadsheetId: input.file_id,
        range: targetSheet,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: input.values }
      });
      return {
        ok: true,
        updatedRange: r.data.updates?.updatedRange,
        updatedRows: r.data.updates?.updatedRows,
        updatedCells: r.data.updates?.updatedCells
      };
    }
    case 'search_drive_files': {
      audit(user.email, user.name, 'tool.drive_search', { query: input.query, fullText: !!input.full_text });
      const drive = getDriveClientForUser(user);
      const esc = input.query.replace(/'/g, "\\'");
      const clauses = [`trashed=false`];
      clauses.push(input.full_text ? `fullText contains '${esc}'` : `name contains '${esc}'`);
      if (input.mime_type) clauses.push(`mimeType='${input.mime_type}'`);
      if (input.owner) clauses.push(`'${input.owner.replace(/'/g, "\\'")}' in owners`);
      if (input.modified_after) clauses.push(`modifiedTime > '${input.modified_after}T00:00:00'`);
      const r = await drive.files.list({
        q: clauses.join(' and '),
        fields: 'files(id,name,mimeType,modifiedTime,owners(emailAddress),size,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: Math.min(input.max_results || 20, 100)
      });
      return r.data.files || [];
    }
    // case 'fetch_corp_api' / 'fetch_corp_page' は corp 側 agent.php が現在閉鎖中（503）のため
    // ツール定義から除外しています。corp 側を再開する際に git history から復元してください。
    // 復元元コミット: 7251ba0 / ec7d66c7 より前
    case 'list_calendar_events': {
      audit(user.email, user.name, 'tool.calendar', { days: input.days });
      const cal = getCalendarClientForUser(user);
      const now = new Date();
      const timeMin = now.toISOString();
      const timeMax = new Date(now.getTime() + (input.days || 7) * 24 * 3600 * 1000).toISOString();
      const r = await cal.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        maxResults: input.max_results || 20,
        singleEvents: true,
        orderBy: 'startTime'
      });
      return (r.data.items || []).map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location,
        description: e.description?.slice(0, 200)
      }));
    }
    case 'list_gmail_messages': {
      audit(user.email, user.name, 'tool.gmail', { query: input.query });
      const gmail = getGmailClientForUser(user);
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults: input.max_results || 20,
        q: input.query || ''
      });
      const msgs = listRes.data.messages || [];
      const details = await Promise.all(msgs.map(m =>
        gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] })
      ));
      return details.map(d => {
        const headers = Object.fromEntries((d.data.payload?.headers || []).map(h => [h.name, h.value]));
        return { id: d.data.id, subject: headers['Subject'] || '', from: headers['From'] || '', date: headers['Date'] || '', snippet: d.data.snippet || '' };
      });
    }
    case 'register_task': {
      const {
        task_type = 'recurring',
        skill_name,
        skill_title,
        description: taskDesc = '',
        steps,
        schedule_type = 'interval',
        interval_min = 60,
        schedule_hour,
        schedule_minute = 0,
        schedule_weekday,
        run_at,
        model: taskModel = 'sonnet'
      } = input;
      if (!skill_name || !steps) throw new Error('skill_name と steps は必須です');
      const validation = await validateTaskSteps(steps, skill_title || skill_name);
      if (!validation.ok) {
        return { ok: false, validation_failed: true, issue: validation.issue, message: `⚠️ タスク登録前チェックで問題が見つかりました：${validation.issue}\n\n手順の記述を修正してから再度登録してください。` };
      }
      let nextRunAt;
      if (task_type === 'once') {
        if (!run_at) throw new Error('単発タスクには run_at（実行日時）が必要です');
        const d = new Date(run_at);
        if (isNaN(d.getTime())) throw new Error(`run_at の形式が不正です: ${run_at}`);
        nextRunAt = toUtcStr(d);
      } else {
        nextRunAt = calcNextRunAt({ schedule_type, schedule_hour, schedule_minute, schedule_weekday, interval_min });
      }
      const ins = db.prepare(
        `INSERT INTO scheduled_tasks
           (owner_email, task_type, skill_id, skill_name, skill_title, description, steps, interval_min, run_at, enabled, next_run_at, schedule_type, schedule_hour, schedule_minute, schedule_weekday, model)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      ).run(user.email, task_type, skill_name, skill_title || skill_name, taskDesc, steps, Number(interval_min), run_at || null, nextRunAt, schedule_type, schedule_hour ?? null, Number(schedule_minute), schedule_weekday ?? null, taskModel);
      audit(user.email, user.name, 'scheduled_task.create_via_chat', { id: ins.lastInsertRowid, task_type, skill_name, schedule_type, model: taskModel });
      const wdays = ['日','月','火','水','木','金','土'];
      const label = task_type === 'once'
        ? `単発タスク「${skill_name}」を ${run_at} に登録しました（ID: ${ins.lastInsertRowid}）`
        : schedule_type === 'daily'
          ? `定期タスク「${skill_name}」を毎日${schedule_hour}:${String(schedule_minute).padStart(2,'0')}に実行するよう登録しました（ID: ${ins.lastInsertRowid}）`
          : schedule_type === 'weekly'
            ? `定期タスク「${skill_name}」を毎週${wdays[schedule_weekday]}曜${schedule_hour}:${String(schedule_minute).padStart(2,'0')}に実行するよう登録しました（ID: ${ins.lastInsertRowid}）`
            : `定期タスク「${skill_name}」を${interval_min}分ごとに実行するよう登録しました（ID: ${ins.lastInsertRowid}）`;
      return { ok: true, id: ins.lastInsertRowid, message: label };
    }
    case 'send_system_notification': {
      const sysToken = process.env.CHATWORK_SYSTEM_TOKEN;
      if (!sysToken) throw new Error('CHATWORK_SYSTEM_TOKEN が未設定です。管理者に環境変数の設定を依頼してください。');
      const { room_id, body: notifyBody } = input;
      if (!room_id || !notifyBody) throw new Error('room_id と body は必須です');
      audit(user.email, user.name, 'tool.system_notify', { roomId: room_id, preview: notifyBody.slice(0, 50) });
      const res = await fetch(`${CW_BASE}/rooms/${room_id}/messages`, {
        method: 'POST',
        headers: {
          'X-ChatWorkToken': sysToken,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ body: notifyBody }).toString()
      });
      if (!res.ok) throw new Error(`システム通知送信エラー: ${res.status} ${await res.text()}`);
      return await res.json();
    }
    case 'fetch_url': {
      const u = new URL(input.url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http(s) URLのみ対応');
      // SSRF対策: ローカル/プライベートアドレスをブロック
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || host.endsWith('.internal') || host.endsWith('.local')) {
        throw new Error(`内部アドレス ${host} へのアクセスは禁止されています`);
      }
      audit(user.email, user.name, 'tool.fetch_url', { url: input.url, mode: input.mode });
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(input.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Acrovision-AI-Agent/1.0' }, redirect: 'follow' });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const raw = await r.text();
      const mode = input.mode || 'text';
      if (mode === 'json') {
        try { return { url: input.url, status: r.status, json: JSON.parse(raw) }; } catch(e) { throw new Error('JSONとしてパースできません: ' + e.message); }
      }
      if (mode === 'html') {
        return { url: input.url, status: r.status, content: raw.slice(0, 60000) };
      }
      // text: HTMLタグを除去
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
      return { url: input.url, status: r.status, content: text.slice(0, 60000) };
    }
    case 'send_gmail': {
      const gmail = getGmailClientForUser(user);
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.gmail_send.preview', { to: input.to, subject: input.subject });
        return {
          preview: true,
          message: 'これはメール送信プレビューです。ユーザーに宛先・件名・本文を提示し、明示的な承認を得てから confirmed:true で再度呼んでください。',
          from: user.email,
          to: input.to,
          cc: input.cc || '',
          bcc: input.bcc || '',
          subject: input.subject,
          body_preview: input.body.slice(0, 1000)
        };
      }
      audit(user.email, user.name, 'tool.gmail_send.execute', { to: input.to, subject: input.subject });
      const headers = [
        `To: ${input.to}`,
        input.cc ? `Cc: ${input.cc}` : null,
        input.bcc ? `Bcc: ${input.bcc}` : null,
        `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64'
      ].filter(Boolean).join('\r\n');
      const message = headers + '\r\n\r\n' + Buffer.from(input.body).toString('base64');
      const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { ok: true, id: r.data.id, threadId: r.data.threadId };
    }
    case 'create_calendar_event': {
      const cal = getCalendarClientForUser(user);
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.calendar_create.preview', { summary: input.summary });
        return {
          preview: true,
          message: 'これは予定作成プレビューです。ユーザーに内容を提示し、明示的な承認を得てから confirmed:true で再度呼んでください。',
          summary: input.summary,
          start: input.start,
          end: input.end,
          description: input.description || '',
          location: input.location || '',
          attendees: input.attendees || []
        };
      }
      audit(user.email, user.name, 'tool.calendar_create.execute', { summary: input.summary, start: input.start });
      const event = {
        summary: input.summary,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        description: input.description,
        location: input.location,
        attendees: (input.attendees || []).map(email => ({ email }))
      };
      const r = await cal.events.insert({ calendarId: 'primary', requestBody: event });
      return { ok: true, id: r.data.id, htmlLink: r.data.htmlLink, summary: r.data.summary, start: r.data.start, end: r.data.end };
    }
    case 'create_drive_file': {
      const drive = getDriveClientForUser(user);
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.drive_create.preview', { name: input.name, type: input.type });
        return {
          preview: true,
          message: 'これはDriveファイル作成プレビューです。ユーザーに内容を提示し、明示的な承認を得てから confirmed:true で再度呼んでください。',
          file_name: input.name,
          file_type: input.type,
          folder_id: input.folder_id || '（マイドライブ直下）',
          content_preview: input.content.slice(0, 500)
        };
      }
      audit(user.email, user.name, 'tool.drive_create.execute', { name: input.name, type: input.type });
      const mimeMap = {
        doc: { source: 'text/plain', target: 'application/vnd.google-apps.document' },
        sheet: { source: 'text/csv', target: 'application/vnd.google-apps.spreadsheet' },
        text: { source: 'text/plain', target: null }
      };
      const m = mimeMap[input.type];
      if (!m) throw new Error('type は doc / sheet / text のいずれか');
      const fileMetadata = { name: input.name };
      if (m.target) fileMetadata.mimeType = m.target;
      if (input.folder_id) fileMetadata.parents = [input.folder_id];
      const media = { mimeType: m.source, body: input.content };
      const r = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id,name,mimeType,webViewLink' });
      return { ok: true, id: r.data.id, name: r.data.name, mimeType: r.data.mimeType, webViewLink: r.data.webViewLink };
    }
    case 'call_ms_graph': {
      if (!process.env.MS_GRAPH_TOKEN) throw new Error('MS_GRAPH_TOKEN 未設定。Microsoft 365 Graph API トークンを管理者に依頼してください');
      const method = (input.method || 'GET').toUpperCase();
      const isWrite = method !== 'GET';
      if (isWrite && !input.confirmed) {
        audit(user.email, user.name, 'tool.ms_graph.preview', { method, path: input.path });
        return {
          preview: true,
          message: 'これはMicrosoft Graph書き込みプレビューです。ユーザー承認後 confirmed:true で再度呼んでください。',
          method, path: input.path, body: input.body
        };
      }
      audit(user.email, user.name, isWrite ? 'tool.ms_graph.execute' : 'tool.ms_graph', { method, path: input.path });
      const qs = input.query ? '?' + new URLSearchParams(input.query).toString() : '';
      const r = await fetch(`https://graph.microsoft.com/v1.0${input.path}${qs}`, {
        method,
        headers: { 'Authorization': `Bearer ${process.env.MS_GRAPH_TOKEN}`, 'Content-Type': 'application/json' },
        body: input.body ? JSON.stringify(input.body) : undefined
      });
      const text = await r.text();
      const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
      if (!r.ok) throw new Error(`Graph error ${r.status}: ${data?.error?.message || text}`);
      return data;
    }
    case 'list_slack_channels': {
      if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 未設定。Slack Botトークンを管理者に依頼してください');
      audit(user.email, user.name, 'tool.slack_channels');
      const qs = new URLSearchParams({ types: input.types || 'public_channel', limit: String(input.limit || 200), exclude_archived: 'true' });
      const r = await fetch(`https://slack.com/api/conversations.list?${qs}`, {
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const d = await r.json();
      if (!d.ok) throw new Error(`Slack error: ${d.error}`);
      return (d.channels || []).map(c => ({ id: c.id, name: c.name, is_private: c.is_private, num_members: c.num_members }));
    }
    case 'get_slack_messages': {
      if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 未設定');
      audit(user.email, user.name, 'tool.slack_messages', { channel: input.channel });
      const qs = new URLSearchParams({ channel: input.channel, limit: String(Math.min(input.limit || 20, 200)) });
      const r = await fetch(`https://slack.com/api/conversations.history?${qs}`, {
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const d = await r.json();
      if (!d.ok) throw new Error(`Slack error: ${d.error}`);
      return (d.messages || []).map(m => ({ ts: m.ts, user: m.user, text: m.text, thread_ts: m.thread_ts }));
    }
    case 'send_slack_message': {
      if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 未設定');
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.slack_send.preview', { channel: input.channel });
        return {
          preview: true,
          message: 'これはSlack送信プレビューです。チャンネル・本文を提示し、承認を得てから confirmed:true で再度呼んでください。',
          channel: input.channel,
          text_preview: input.text.slice(0, 500),
          thread_ts: input.thread_ts || null
        };
      }
      audit(user.email, user.name, 'tool.slack_send.execute', { channel: input.channel });
      const body = { channel: input.channel, text: input.text };
      if (input.thread_ts) body.thread_ts = input.thread_ts;
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!d.ok) throw new Error(`Slack error: ${d.error}`);
      return { ok: true, ts: d.ts, channel: d.channel };
    }
    case 'list_notion_databases': {
      if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 未設定。Notion Integrationトークンを管理者に依頼してください');
      audit(user.email, user.name, 'tool.notion_dbs', { query: input.query });
      const r = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input.query || '', filter: { value: 'database', property: 'object' }, page_size: 50 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`Notion error: ${d.message || r.status}`);
      return (d.results || []).map(db => ({
        id: db.id,
        title: (db.title || []).map(t => t.plain_text).join(''),
        url: db.url,
        last_edited: db.last_edited_time
      }));
    }
    case 'query_notion_database': {
      if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 未設定');
      audit(user.email, user.name, 'tool.notion_query', { dbId: input.database_id });
      const body = { page_size: Math.min(input.page_size || 20, 100) };
      if (input.filter) body.filter = input.filter;
      if (input.sorts) body.sorts = input.sorts;
      const r = await fetch(`https://api.notion.com/v1/databases/${input.database_id}/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`Notion error: ${d.message || r.status}`);
      return { count: d.results?.length || 0, has_more: d.has_more, results: d.results };
    }
    case 'create_notion_page': {
      if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 未設定');
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.notion_create.preview', { dbId: input.database_id });
        return {
          preview: true,
          message: 'これはNotionページ作成プレビューです。データベース・プロパティを提示し、承認を得てから confirmed:true で再度呼んでください。',
          database_id: input.database_id,
          properties: input.properties,
          children_count: (input.children || []).length
        };
      }
      audit(user.email, user.name, 'tool.notion_create.execute', { dbId: input.database_id });
      const r = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { database_id: input.database_id }, properties: input.properties, children: input.children || [] })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`Notion error: ${d.message || r.status}`);
      return { ok: true, id: d.id, url: d.url };
    }
    case 'update_notion_page': {
      if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 未設定');
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.notion_update.preview', { pageId: input.page_id });
        return {
          preview: true,
          message: 'これはNotionページ更新プレビューです。ユーザー承認後 confirmed:true で再度呼んでください。',
          page_id: input.page_id,
          properties: input.properties
        };
      }
      audit(user.email, user.name, 'tool.notion_update.execute', { pageId: input.page_id });
      const r = await fetch(`https://api.notion.com/v1/pages/${input.page_id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: input.properties })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`Notion error: ${d.message || r.status}`);
      return { ok: true, id: d.id, url: d.url };
    }
    case 'export_data_csv': {
      audit(user.email, user.name, 'tool.export_csv', { name: input.file_name, rows: input.rows?.length });
      const rows = Array.isArray(input.rows) ? input.rows : [];
      let headers = input.headers;
      if (!headers && rows.length > 0 && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
        headers = Object.keys(rows[0]);
      }
      const escCsv = v => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [];
      if (headers) lines.push(headers.map(escCsv).join(','));
      for (const r of rows) {
        if (Array.isArray(r)) lines.push(r.map(escCsv).join(','));
        else if (headers) lines.push(headers.map(h => escCsv(r[h])).join(','));
      }
      const csv = '﻿' + lines.join('\n'); // BOM for Excel
      const drive = getDriveClientForUser(user);
      const meta = { name: input.file_name + '.csv' };
      if (input.folder_id) meta.parents = [input.folder_id];
      const dr = await drive.files.create({ requestBody: meta, media: { mimeType: 'text/csv', body: csv }, fields: 'id,name,webViewLink' });
      return { ok: true, id: dr.data.id, name: dr.data.name, webViewLink: dr.data.webViewLink, rows: rows.length };
    }
    case 'export_data_excel': {
      audit(user.email, user.name, 'tool.export_excel', { name: input.file_name });
      const wb = new ExcelJS.Workbook();
      for (const [sheetName, rows] of Object.entries(input.sheets || {})) {
        const ws = wb.addWorksheet(String(sheetName).slice(0, 31));
        const dataRows = Array.isArray(rows) ? rows : [];
        if (dataRows.length > 0) {
          const headers = Object.keys(dataRows[0]);
          ws.addRow(headers);
          for (const row of dataRows) ws.addRow(headers.map(h => row[h] ?? ''));
        }
      }
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const drive = getDriveClientForUser(user);
      const meta = { name: input.file_name + '.xlsx' };
      if (input.folder_id) meta.parents = [input.folder_id];
      const dr = await drive.files.create({
        requestBody: meta,
        media: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Readable.from(buf) },
        fields: 'id,name,webViewLink'
      });
      return { ok: true, id: dr.data.id, name: dr.data.name, webViewLink: dr.data.webViewLink, sheet_count: Object.keys(input.sheets || {}).length };
    }
    case 'generate_chart': {
      audit(user.email, user.name, 'tool.generate_chart', { name: input.file_name });
      const chartConfig = encodeURIComponent(JSON.stringify(input.chart));
      const url = `https://quickchart.io/chart?c=${chartConfig}&w=${input.width || 800}&h=${input.height || 400}&backgroundColor=white&format=png`;
      if (url.length > 8000) throw new Error('Chart設定が大きすぎます。データを集約してください');
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Chart生成エラー: ${r.status} ${await r.text()}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const drive = getDriveClientForUser(user);
      const meta = { name: input.file_name + '.png' };
      if (input.folder_id) meta.parents = [input.folder_id];
      const dr = await drive.files.create({
        requestBody: meta,
        media: { mimeType: 'image/png', body: Readable.from(buf) },
        fields: 'id,name,webViewLink'
      });
      return { ok: true, id: dr.data.id, name: dr.data.name, webViewLink: dr.data.webViewLink };
    }
    case 'generate_pdf_report': {
      audit(user.email, user.name, 'tool.pdf_report', { name: input.file_name });
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: input.title || input.file_name, Author: input.author || user.name || '' } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      const done = new Promise(resolve => doc.on('end', resolve));
      // 日本語フォント対応のため標準フォントだけだとNG。簡易対応で system フォントなしで試す
      // 本格運用なら NotoSansJP.ttf を配置して doc.font() で指定
      if (input.title) doc.fontSize(20).text(input.title, { align: 'center' }).moveDown();
      for (const sec of (input.sections || [])) {
        if (sec.heading) doc.fontSize(14).text(sec.heading).moveDown(0.3);
        if (sec.text) doc.fontSize(11).text(sec.text).moveDown(0.5);
        if (Array.isArray(sec.table) && sec.table.length > 0) {
          const colWidth = 495 / sec.table[0].length;
          let y = doc.y;
          for (const row of sec.table) {
            let x = 50;
            for (const cell of row) {
              doc.fontSize(9).text(String(cell ?? ''), x, y, { width: colWidth - 4, ellipsis: true });
              x += colWidth;
            }
            y = doc.y + 4;
            doc.y = y;
          }
          doc.moveDown();
        }
      }
      doc.end();
      await done;
      const buf = Buffer.concat(chunks);
      const drive = getDriveClientForUser(user);
      const meta = { name: input.file_name + '.pdf' };
      if (input.folder_id) meta.parents = [input.folder_id];
      const dr = await drive.files.create({
        requestBody: meta,
        media: { mimeType: 'application/pdf', body: Readable.from(buf) },
        fields: 'id,name,webViewLink'
      });
      return { ok: true, id: dr.data.id, name: dr.data.name, webViewLink: dr.data.webViewLink };
    }
    case 'create_pptx': {
      const drive = getDriveClientForUser(user);
      const slides = Array.isArray(input.slides) ? input.slides : [];
      if (slides.length === 0) throw new Error('slides は1つ以上必要');
      if (!input.confirmed) {
        audit(user.email, user.name, 'tool.pptx_create.preview', { name: input.file_name, slides: slides.length });
        return {
          preview: true,
          message: 'これはPowerPoint作成プレビューです。スライド構成をユーザーに提示し、承認を得てから confirmed:true で再度呼んでください。',
          file_name: input.file_name + '.pptx',
          title: input.title || input.file_name,
          slide_count: slides.length,
          outline: slides.map((s, i) => ({
            index: i + 1,
            layout: s.layout,
            title: s.title,
            preview: (s.body || (s.bullets || []).join(' / ') || s.subtitle || '').slice(0, 100)
          }))
        };
      }
      audit(user.email, user.name, 'tool.pptx_create.execute', { name: input.file_name, slides: slides.length });
      // pptx生成
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.title = input.title || input.file_name;
      if (input.author) pptx.author = input.author;
      const FONT = 'Yu Gothic';
      for (const s of slides) {
        const slide = pptx.addSlide();
        if (s.layout === 'title') {
          slide.background = { color: '5B6EFF' };
          if (s.title) slide.addText(s.title, { x: 0.5, y: 2.5, w: 9, h: 1.5, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center', fontFace: FONT });
          if (s.subtitle) slide.addText(s.subtitle, { x: 0.5, y: 4.2, w: 9, h: 0.8, fontSize: 20, color: 'FFFFFF', align: 'center', fontFace: FONT });
        } else if (s.layout === 'section') {
          slide.background = { color: 'F4F6FB' };
          if (s.title) slide.addText(s.title, { x: 0.5, y: 2.5, w: 9, h: 1.5, fontSize: 36, bold: true, color: '5B6EFF', align: 'center', fontFace: FONT });
        } else {
          if (s.title) slide.addText(s.title, { x: 0.4, y: 0.3, w: 9.2, h: 0.7, fontSize: 24, bold: true, color: '2D3748', fontFace: FONT });
          if (s.layout === 'bullets' && Array.isArray(s.bullets)) {
            slide.addText(s.bullets.map(b => ({ text: String(b), options: { bullet: true } })), { x: 0.5, y: 1.2, w: 9, h: 4, fontSize: 18, color: '2D3748', fontFace: FONT, valign: 'top', paraSpaceAfter: 8 });
          } else if (s.layout === 'two_column') {
            slide.addText(String(s.left || ''), { x: 0.4, y: 1.2, w: 4.5, h: 4, fontSize: 14, color: '2D3748', fontFace: FONT, valign: 'top' });
            slide.addText(String(s.right || ''), { x: 5.1, y: 1.2, w: 4.5, h: 4, fontSize: 14, color: '2D3748', fontFace: FONT, valign: 'top' });
          } else { // content
            slide.addText(String(s.body || ''), { x: 0.5, y: 1.2, w: 9, h: 4, fontSize: 16, color: '2D3748', fontFace: FONT, valign: 'top' });
          }
        }
      }
      const buf = await pptx.write({ outputType: 'nodebuffer' });
      const fileMetadata = { name: input.file_name + '.pptx' };
      if (input.folder_id) fileMetadata.parents = [input.folder_id];
      const r = await drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          body: Readable.from(buf)
        },
        fields: 'id,name,webViewLink'
      });
      return { ok: true, id: r.data.id, name: r.data.name, slide_count: slides.length, webViewLink: r.data.webViewLink };
    }
    case 'run_subagents': {
      const tasks = (input.tasks || []).slice(0, 3);
      if (tasks.length === 0) return { error: 'tasks が空です' };
      audit(user.email, user.name, 'tool.run_subagents', { count: tasks.length, titles: tasks.map(t => t.title) });
      const results = await Promise.allSettled(tasks.map(t =>
        runSkillBackground(
          { skill_name: 'subagent', skill_title: t.title, description: '', steps: t.steps, model: 'sonnet' },
          user.email
        )
      ));
      return results.map((r, i) => {
        const val = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message };
        const runRow = val.runId ? db.prepare('SELECT result FROM task_runs WHERE id=?').get(val.runId) : null;
        return { task: tasks[i].title, status: val.ok ? 'done' : 'error', result: val.ok ? (runRow?.result || '完了') : val.error };
      });
    }
    case 'create_meeting_minutes': {
      audit(user.email, user.name, 'tool.meeting_minutes', { title: input.title, len: input.transcript?.length });
      const today = new Date().toISOString().slice(0, 10);
      const meetDate = input.date || today;
      const prompt = [
        `以下の会議テキストから議事録を作成してください。`,
        `会議名: ${input.title || '会議'}`,
        `日時: ${meetDate}`,
        `参加者: ${input.attendees || '（テキストから推定）'}`,
        `\n【文字起こし・メモ】\n${(input.transcript || '').slice(0, 80000)}`,
        `\n以下のJSON形式のみで回答してください（前後テキスト不要）:`,
        `{"title":"会議タイトル","date":"YYYY-MM-DD","attendees":["参加者"],"agenda":["議題"],"discussions":[{"topic":"議題","summary":"議論要約"}],"decisions":["決定事項"],"todos":[{"task":"タスク","owner":"担当者","due":"期限またはnull"}],"next_meeting":"次回予定またはnull"}`
      ].join('\n');
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 4096,
        system: 'あなたは優秀な秘書です。会議の文字起こしから正確な議事録を作成してください。',
        messages: [{ role: 'user', content: prompt }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'JSON抽出失敗', raw: text };
      let minutes;
      try { minutes = JSON.parse(jsonMatch[0]); }
      catch (e) { return { error: 'JSONパース失敗: ' + e.message, raw: jsonMatch[0] }; }
      if (input.save_to_drive) {
        const drive = getDriveClientForUser(user);
        const lines = [
          `# ${minutes.title || input.title || '議事録'} - ${minutes.date || meetDate}`,
          `\n## 参加者\n${(minutes.attendees || []).join('、')}`,
          `\n## 議題\n${(minutes.agenda || []).map(a => `- ${a}`).join('\n')}`,
          `\n## 議事内容\n${(minutes.discussions || []).map(d => `### ${d.topic}\n${d.summary}`).join('\n\n')}`,
          `\n## 決定事項\n${(minutes.decisions || []).map(d => `- ${d}`).join('\n')}`,
          `\n## TODO\n${(minutes.todos || []).map(t => `- [ ] ${t.task}（担当: ${t.owner || '未定'}、期限: ${t.due || '未定'}）`).join('\n')}`,
          minutes.next_meeting ? `\n## 次回会議\n${minutes.next_meeting}` : ''
        ].join('\n');
        const docName = `議事録_${minutes.title || input.title || '会議'}_${minutes.date || meetDate}`;
        const r = await drive.files.create({
          requestBody: { name: docName, mimeType: 'application/vnd.google-apps.document' },
          media: { mimeType: 'text/plain', body: lines },
          fields: 'id,webViewLink'
        });
        return { ok: true, minutes, drive_link: r.data.webViewLink, message: `Google Docsに保存しました: ${r.data.webViewLink}` };
      }
      return { ok: true, minutes };
    }
    case 'check_server_health': {
      audit(user.email, user.name, 'tool.server_health', { count: input.urls?.length });
      const timeout = Math.min(input.timeout_ms || 10000, 30000);
      const urls = (input.urls || []).slice(0, 20);
      const results = await Promise.all(urls.map(async (url) => {
        try {
          const u = new URL(url);
          const host = u.hostname.toLowerCase();
          if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || host.endsWith('.internal') || host.endsWith('.local')) {
            return { url, ok: false, error: '内部アドレスへのアクセスは禁止' };
          }
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), timeout);
          const t0 = Date.now();
          const r = await fetch(url, { signal: ctrl.signal, method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'Acrovision-HealthCheck/1.0' } });
          clearTimeout(to);
          return {
            url, ok: r.status < 500,
            status: r.status, status_text: r.statusText,
            response_ms: Date.now() - t0,
            ssl: u.protocol === 'https:' ? 'HTTPS' : 'HTTP（SSL未使用）',
            redirected: r.redirected || false
          };
        } catch (e) {
          return { url, ok: false, error: e.name === 'AbortError' ? `タイムアウト（${timeout}ms超過）` : e.message };
        }
      }));
      const healthy = results.filter(r => r.ok).length;
      return { checked: results.length, healthy, unhealthy: results.length - healthy, results };
    }
    case 'check_job_posting': {
      audit(user.email, user.name, 'tool.job_posting_check', { len: input.text?.length, job_type: input.job_type });
      const focus = (input.focus || ['compliance', 'appeal', 'clarity', 'salary', 'discrimination']).join(', ');
      const prompt = [
        `以下の求人原稿をチェックしてください。`,
        `種別: ${input.job_type || '未指定'}`,
        `重点観点: ${focus}`,
        `\n【原稿】\n${(input.text || '').slice(0, 10000)}`,
        `\n以下のJSON形式のみで回答してください（前後テキスト不要）:`,
        `{"overall_score":"A/B/C/D（A=問題なし,B=軽微な問題あり,C=要修正,D=掲載不可）","issues":[{"category":"compliance|appeal|clarity|salary|discrimination|other","severity":"high|medium|low","location":"問題箇所の引用","issue":"問題の説明","suggestion":"改善案","example":"改善例文"}],"strengths":["良い点"],"missing_items":["記載が必要な項目"],"summary":"総評（2〜3文）"}`
      ].join('\n');
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 3000,
        system: 'あなたは求人広告の品質管理の専門家です。求人原稿を厳格にチェックし、問題点と改善案を具体的に示してください。',
        messages: [{ role: 'user', content: prompt }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'JSON抽出失敗', raw: text };
      try { return { ok: true, result: JSON.parse(jsonMatch[0]) }; }
      catch (e) { return { error: 'JSONパース失敗: ' + e.message, raw: jsonMatch[0] }; }
    }
    case 'generate_weekly_report': {
      const role = user.role || getUserRole(user.email);
      if (!['admin', 'gyoumu'].includes(role)) throw new Error('管理者・業務管理部のみ実行可能');
      audit(user.email, user.name, 'tool.weekly_report');
      const pool = getCorpDb();
      if (!pool) throw new Error('Corp DB未設定');
      const now = new Date();
      const firstDay = input.month_start || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const include = new Set(input.include || ['anken', 'geppo', 'seikyu', 'customer']);
      const report = { month_start: firstDay, generated_at: now.toISOString(), sections: {} };
      const safeQuery = async (sql, params) => {
        try { const [rows] = await pool.execute(sql, params || []); return rows[0] || {}; }
        catch (e) { return { error: e.message }; }
      };
      if (include.has('anken'))    report.sections.anken    = await safeQuery('SELECT COUNT(*) as total FROM kintone_anken_eigyo');
      if (include.has('geppo'))    report.sections.geppo    = await safeQuery('SELECT COUNT(*) as submitted FROM geppo_data WHERE created_at >= ?', [firstDay]);
      if (include.has('seikyu'))   report.sections.seikyu   = await safeQuery('SELECT COUNT(*) as count FROM kintone_seikyu WHERE created_at >= ?', [firstDay]);
      if (include.has('customer')) report.sections.customer = await safeQuery('SELECT COUNT(*) as new_customers FROM kintone_customers WHERE created_at >= ?', [firstDay]);
      report.sections.employees = await safeQuery('SELECT COUNT(*) as total FROM kintone_employees');
      if (input.notify_room_id && !process.env.CHATWORK_SYSTEM_TOKEN) {
        report.notify_warning = 'CHATWORK_SYSTEM_TOKEN が未設定のため、Chatwork通知をスキップしました';
      }
      if (input.notify_room_id && process.env.CHATWORK_SYSTEM_TOKEN) {
        const s = report.sections;
        const body = '[info][title]📊 週次レポート（' + firstDay + '月）[/title]' +
          (s.anken && !s.anken.error    ? '\n■ 案件総数: '           + s.anken.total         + '件' : '') +
          (s.geppo && !s.geppo.error    ? '\n■ 月報提出（今月）: '   + s.geppo.submitted      + '件' : '') +
          (s.seikyu && !s.seikyu.error  ? '\n■ 請求件数（今月）: '   + s.seikyu.count         + '件' : '') +
          (s.customer && !s.customer.error ? '\n■ 顧客総数: '         + s.customer.new_customers + '件' : '') +
          (s.employees && !s.employees.error ? '\n■ 社員数: '         + s.employees.total      + '名' : '') +
          '\n[/info]';
        await fetch(`https://api.chatwork.com/v2/rooms/${input.notify_room_id}/messages`, {
          method: 'POST',
          headers: { 'X-ChatWorkToken': process.env.CHATWORK_SYSTEM_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'body=' + encodeURIComponent(body)
        });
      }
      return { ok: true, report };
    }
    case 'generate_presentation': {
      audit(user.email, user.name, 'tool.generate_presentation', { topic: input.topic });
      const drive = getDriveClientForUser(user);
      const slideCount = Math.min(Math.max(input.slide_count || 8, 4), 20);
      const keyPoints = (input.key_points || []).map(p => `- ${p}`).join('\n');
      const designPrompt = `あなたはプレゼンテーション専門家です。以下の条件でPowerPointスライド構成をJSONで設計してください。
テーマ: ${input.topic}
目的: ${input.purpose || '社内説明'}
対象: ${input.audience || '社内スタッフ'}
スライド枚数: ${slideCount}枚
${keyPoints ? `必須ポイント:\n${keyPoints}` : ''}

出力形式（JSON配列のみ、説明文不要）:
[
  {"layout":"title","title":"タイトル","subtitle":"サブタイトル"},
  {"layout":"bullets","title":"スライドタイトル","bullets":["項目1","項目2","項目3"]},
  {"layout":"content","title":"スライドタイトル","body":"本文テキスト"},
  {"layout":"two_column","title":"タイトル","left":"左カラム内容","right":"右カラム内容"},
  {"layout":"section","title":"セクション区切りタイトル"}
]
最初のスライドはlayout:title、最後はlayout:bulletsでまとめ（次のステップ・まとめなど）にすること。`;

      const designResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 4096,
        messages: [{ role: 'user', content: designPrompt }]
      });
      const designText = (designResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const matchSlides = designText.match(/\[[\s\S]*\]/);
      if (!matchSlides) return { error: 'スライド構成の生成に失敗しました', raw: designText.slice(0, 500) };
      let slides;
      try { slides = JSON.parse(matchSlides[0]); } catch (e) { return { error: 'スライドJSONパース失敗: ' + e.message }; }

      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.title = input.topic;
      const FONT = 'Yu Gothic';
      for (const s of slides) {
        const slide = pptx.addSlide();
        if (s.layout === 'title') {
          slide.background = { color: '5B6EFF' };
          if (s.title) slide.addText(s.title, { x: 0.5, y: 2.2, w: 9, h: 1.8, fontSize: 36, bold: true, color: 'FFFFFF', align: 'center', fontFace: FONT });
          if (s.subtitle) slide.addText(s.subtitle, { x: 0.5, y: 4.2, w: 9, h: 0.8, fontSize: 20, color: 'FFFFFF', align: 'center', fontFace: FONT });
        } else if (s.layout === 'section') {
          slide.background = { color: 'F4F6FB' };
          if (s.title) slide.addText(s.title, { x: 0.5, y: 2.5, w: 9, h: 1.5, fontSize: 32, bold: true, color: '5B6EFF', align: 'center', fontFace: FONT });
        } else if (s.layout === 'two_column') {
          if (s.title) slide.addText(s.title, { x: 0.4, y: 0.3, w: 9.2, h: 0.7, fontSize: 24, bold: true, color: '2D3748', fontFace: FONT });
          slide.addText(String(s.left || ''), { x: 0.4, y: 1.2, w: 4.5, h: 4.2, fontSize: 14, color: '2D3748', fontFace: FONT, valign: 'top' });
          slide.addText(String(s.right || ''), { x: 5.1, y: 1.2, w: 4.5, h: 4.2, fontSize: 14, color: '2D3748', fontFace: FONT, valign: 'top' });
        } else if (s.layout === 'bullets') {
          if (s.title) slide.addText(s.title, { x: 0.4, y: 0.3, w: 9.2, h: 0.7, fontSize: 24, bold: true, color: '2D3748', fontFace: FONT });
          const bullets = (s.bullets || []).map(b => ({ text: String(b), options: { bullet: true } }));
          if (bullets.length) slide.addText(bullets, { x: 0.5, y: 1.2, w: 9, h: 4.2, fontSize: 18, color: '2D3748', fontFace: FONT, valign: 'top', paraSpaceAfter: 10 });
        } else {
          if (s.title) slide.addText(s.title, { x: 0.4, y: 0.3, w: 9.2, h: 0.7, fontSize: 24, bold: true, color: '2D3748', fontFace: FONT });
          if (s.body) slide.addText(String(s.body), { x: 0.5, y: 1.2, w: 9, h: 4.2, fontSize: 16, color: '2D3748', fontFace: FONT, valign: 'top' });
        }
      }
      const buf = await pptx.write({ outputType: 'nodebuffer' });
      const safeName = input.topic.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
      const fileMeta = { name: safeName + '.pptx' };
      if (input.folder_id) fileMeta.parents = [input.folder_id];
      const dr = await drive.files.create({
        requestBody: fileMeta,
        media: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: Readable.from(buf) },
        fields: 'id,name,webViewLink'
      });
      return { ok: true, id: dr.data.id, name: dr.data.name, slide_count: slides.length, webViewLink: dr.data.webViewLink };
    }

    case 'summarize_document': {
      audit(user.email, user.name, 'tool.summarize_document', { fileId: input.file_id });
      const drive = getDriveClientForUser(user);
      const meta = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const mt = meta.data.mimeType;
      let textContent = '';
      let documentBlock = null;

      if (mt === 'application/pdf') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const buf = Buffer.from(r.data);
        if (buf.length > 32 * 1024 * 1024) throw new Error('PDFが大きすぎます（32MB上限）');
        documentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
      } else if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
        const x = await mammoth.extractRawText({ buffer: Buffer.from(r.data) });
        textContent = x.value;
      } else if (mt === 'application/vnd.google-apps.document') {
        const r = await drive.files.export({ fileId: input.file_id, mimeType: 'text/plain' }, { responseType: 'text' });
        textContent = String(r.data);
      } else if (mt?.startsWith('text/')) {
        const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'text' });
        textContent = String(r.data);
      } else {
        throw new Error(`${mt} は要約非対応（PDF/Word/Googleドキュメント/テキストのみ）`);
      }

      const focusNote = input.focus ? `\n重点観点: ${input.focus}` : '';
      const format = input.output_format === 'prose' ? '文章形式（段落）' : '箇条書き（•）';
      const maxLen = input.max_length || 500;
      const promptText = `以下の文書を要約してください。${focusNote}
出力形式: ${format}
最大文字数: ${maxLen}文字以内
ファイル名: ${meta.data.name}

${textContent ? `文書テキスト:\n${textContent.slice(0, 60000)}` : '（上記の文書を読んでください）'}`;

      const userContent = documentBlock
        ? [documentBlock, { type: 'text', text: promptText }]
        : [{ type: 'text', text: promptText }];

      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2048,
        messages: [{ role: 'user', content: userContent }]
      });
      const summary = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      return { ok: true, file_name: meta.data.name, file_type: mt, summary };
    }

    case 'draft_email_reply': {
      audit(user.email, user.name, 'tool.draft_email_reply', { intent: input.reply_intent?.slice(0, 50) });
      const toneMap = { formal: '非常に丁寧・敬語を最大限に使用', standard: '一般的なビジネスメール敬語', brief: '簡潔・要点のみ' };
      const toneDesc = toneMap[input.tone] || toneMap.standard;
      const senderName = input.sender_name || user.name || '';
      const addInfo = input.additional_info ? `\n追加情報: ${input.additional_info}` : '';
      const intentNote = input.reply_intent ? `\n返信の意図: ${input.reply_intent}` : '';

      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `以下のメールへの返信下書きを作成してください。
トーン: ${toneDesc}
差出人名: ${senderName}${intentNote}${addInfo}

--- 元メール ---
${(input.original_email || '').slice(0, 3000)}
--- ここまで ---

返信メールをJSON形式で出力してください（説明文不要）:
{"subject":"件名","body":"本文（署名前まで）","signature":"${senderName}\\n株式会社アクロビジョン"}`
        }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { ok: true, draft: text };
      try {
        const draft = JSON.parse(jsonMatch[0]);
        return { ok: true, subject: draft.subject, body: draft.body, signature: draft.signature, full_text: `件名: ${draft.subject}\n\n${draft.body}\n\n${draft.signature}` };
      } catch { return { ok: true, draft: text }; }
    }

    case 'screen_candidate': {
      audit(user.email, user.name, 'tool.screen_candidate', { job_type: input.job_type });
      const criteria = (input.evaluation_criteria || ['technical_skill', 'experience', 'cultural_fit']).join('・');
      const jobType = input.job_type || '正社員';

      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2500,
        system: 'あなたは採用支援AIです。候補者情報と求人要件を客観的に分析し、採用担当者の一次スクリーニングを支援します。あくまで参考情報であり、最終判断は採用担当者が行います。',
        messages: [{
          role: 'user',
          content: `以下の候補者を評価してください。
雇用形態: ${jobType}
評価軸: ${criteria}

--- 求人要件 ---
${(input.job_requirements || '').slice(0, 2000)}

--- 候補者情報 ---
${(input.candidate_info || '').slice(0, 3000)}

下記JSON形式で回答してください（説明文不要）:
{
  "overall_score": 0〜100の数値,
  "recommendation": "strong_yes/yes/maybe/no",
  "summary": "候補者の総合評価（2〜3文）",
  "strengths": ["強み1","強み2","強み3"],
  "concerns": ["懸念点1","懸念点2"],
  "missing_requirements": ["不足している要件"],
  "interview_questions": ["面接で確認すべき質問1","質問2","質問3"],
  "criteria_scores": {"評価軸名": スコア0〜100}
}`
        }]
      });
      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'スクリーニング結果の生成に失敗しました', raw: text.slice(0, 500) };
      try { return { ok: true, screening: JSON.parse(jsonMatch[0]) }; }
      catch (e) { return { error: 'JSONパース失敗: ' + e.message, raw: jsonMatch[0].slice(0, 500) }; }
    }

    case 'bulk_register_kintone': {
      const domain = process.env.KINTONE_DOMAIN;
      const token  = process.env.KINTONE_API_TOKEN;
      if (!domain || !token) throw new Error('KINTONE_DOMAIN または KINTONE_API_TOKEN が未設定です。管理者に環境変数の設定を依頼してください。');
      audit(user.email, user.name, 'tool.kintone_bulk', { app_id: input.app_id, confirmed: !!input.confirmed });

      const drive = getDriveClientForUser(user);
      const meta  = await drive.files.get({ fileId: input.file_id, fields: 'name,mimeType' });
      const mt    = meta.data.mimeType;
      const isCSV = mt === 'text/csv' || meta.data.name.endsWith('.csv');
      const isXLS = mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || meta.data.name.endsWith('.xlsx');
      if (!isCSV && !isXLS) throw new Error(`${meta.data.name} は非対応形式です（.xlsx または .csv のみ）`);

      const r = await drive.files.get({ fileId: input.file_id, alt: 'media' }, { responseType: 'arraybuffer' });
      const buf = Buffer.from(r.data);

      let rows = [];
      if (isXLS) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        if (!ws) throw new Error('Excelファイルにシートが存在しません');
        let xlsHeaders = [];
        ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
          if (rowNum === 1) {
            xlsHeaders = row.values.slice(1).map(v => String(v ?? '').trim());
          } else {
            const obj = {};
            xlsHeaders.forEach((h, i) => {
              const cell = row.getCell(i + 1);
              let v = cell.value;
              if (v !== null && v !== undefined) {
                if (typeof v === 'object') {
                  if (v.text !== undefined) v = String(v.text);
                  else if (v.result !== undefined) v = String(v.result);
                  else if (v instanceof Date) v = v.toISOString();
                  else v = String(v);
                } else v = String(v);
              } else v = '';
              obj[h] = v;
            });
            rows.push(obj);
          }
        });
      } else {
        const text = buf.toString('utf8');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const parseCSVLine = line => {
          const result = []; let inQ = false, cur = '';
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
              else inQ = !inQ;
            } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          result.push(cur.trim());
          return result;
        };
        const headers = parseCSVLine(lines[0]);
        rows = lines.slice(1).map(line => {
          const vals = parseCSVLine(line);
          return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
        });
      }
      if (rows.length === 0) throw new Error('データが空です。ファイルの内容を確認してください。');

      const mapping = input.field_mapping || {};
      const toRecord = row => {
        const rec = {};
        for (const [col, val] of Object.entries(row)) {
          const fieldCode = mapping[col] || col;
          rec[fieldCode] = { value: String(val) };
        }
        return rec;
      };

      if (!input.confirmed) {
        const preview = rows.slice(0, 5).map(toRecord);
        return {
          preview: true,
          message: `${meta.data.name} から ${rows.length} 件のデータを検出しました。プレビュー（先頭5件）を確認してから confirmed:true で実行してください。`,
          file_name: meta.data.name,
          total_rows: rows.length,
          columns: Object.keys(rows[0] || {}),
          preview_records: preview
        };
      }

      // 一括登録（Kintone APIは最大100件/リクエスト）
      const BATCH = 100;
      let total_registered = 0;
      const errors = [];
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(toRecord);
        const resp = await fetch(`https://${domain}.cybozu.com/k/v1/records.json`, {
          method: 'POST',
          headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: input.app_id, records: batch })
        });
        let data = {};
        try { data = await resp.json(); } catch { data = {}; }
        if (!resp.ok) {
          errors.push(`バッチ ${Math.floor(i/BATCH)+1}: ${data.message || resp.status}`);
        } else {
          total_registered += batch.length;
        }
      }
      return {
        ok: errors.length === 0,
        app_id: input.app_id,
        total_rows: rows.length,
        total_registered,
        errors: errors.length > 0 ? errors : undefined,
        message: errors.length === 0
          ? `${total_registered}件をKintoneアプリ(ID:${input.app_id})に登録しました。`
          : `${total_registered}件登録、${errors.length}件のバッチでエラーが発生しました。`
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// POST /api/chat
app.post('/api/chat', chatRateLimit, async (req, res) => {
  const { message, conversationId, model: modelPref, attachments = [], thinking: thinkingMode = false } = req.body;
  const MODEL_MAP = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6' };
  const chatModel = MODEL_MAP[modelPref] || 'claude-sonnet-4-6';
  // 拡張思考モードは haiku 非対応（sonnet以上のみ）
  const useThinking = thinkingMode && chatModel !== 'claude-haiku-4-5-20251001';
  const user = req.user;

  if ((!message || !message.trim()) && (!Array.isArray(attachments) || attachments.length === 0)) return res.status(400).json({ error: '空メッセージ' });

  const attachLabel = Array.isArray(attachments) && attachments.length > 0
    ? `[添付${attachments.length}件: ${attachments.map(a => a?.name).filter(Boolean).join(', ').slice(0, 80)}]` : '';
  const effectiveMessage = (message && message.trim()) ? message : (attachLabel || '（添付ファイルを確認してください）');
  audit(user.email, user.name, 'chat', { preview: effectiveMessage.slice(0, 100), conversationId, attachments: attachments?.length || 0 });

  // 会話取得 or 作成
  let convId = conversationId;
  if (!convId) {
    // 新規会話作成（タイトルは最初のメッセージ先頭30文字）
    const title = effectiveMessage.slice(0, 30) + (effectiveMessage.length > 30 ? '…' : '');
    const r = db.prepare('INSERT INTO conversations (user_email, title) VALUES (?,?)').run(user.email, title);
    convId = r.lastInsertRowid;
  } else {
    // 所有確認
    const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND user_email=?').get(convId, user.email);
    if (!conv) return res.status(403).json({ error: '会話が見つかりません' });
    db.prepare("UPDATE conversations SET updated_at=datetime('now','localtime') WHERE id=?").run(convId);
  }

  // ユーザーメッセージ保存（添付ファイルバイナリは保存しない、テキストのみ）
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(convId, 'user', effectiveMessage);

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
    const systemPrompt = getSystemPromptForUser(role, user.email);

    // Context Compression: 30件超なら古い部分をサマリ化
    let messages;
    if (history.length > 30) {
      const toCompress = history.slice(0, -20);
      const recentHistory = history.slice(-20);
      const summary = await compressConversationContext(toCompress);
      messages = summary
        ? [
            { role: 'user', content: `[以前の会話サマリー]\n${summary}` },
            { role: 'assistant', content: '承知しました。以前の会話内容を把握しています。' },
            ...recentHistory.map(m => ({ role: m.role, content: m.content }))
          ]
        : history.map(m => ({ role: m.role, content: m.content }));
      res.write(`data: ${JSON.stringify({ contextCompressed: true, savedMessages: toCompress.length })}\n\n`);
    } else {
      messages = history.map(m => ({ role: m.role, content: m.content }));
    }
    // 添付ファイル（画像/PDF）を最新ユーザーメッセージにブロックとして注入
    if (Array.isArray(attachments) && attachments.length > 0 && messages.length > 0) {
      const lastIdx = messages.length - 1;
      const blocks = [];
      for (const a of attachments) {
        if (!a?.mediaType) continue;
        if (a.file_id) {
          // Files API: file_idで参照
          if (a.kind === 'image') {
            blocks.push({ type: 'image', source: { type: 'file', file_id: a.file_id } });
          } else {
            blocks.push({ type: 'document', source: { type: 'file', file_id: a.file_id } });
          }
        } else if (a.base64) {
          if (a.kind === 'image') {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
          } else if (a.kind === 'document') {
            blocks.push({ type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
          }
        }
      }
      if (blocks.length > 0) {
        blocks.push({ type: 'text', text: messages[lastIdx].content });
        messages[lastIdx] = { role: 'user', content: blocks };
      }
    }
    let fullAssistantText = '';
    let toolRound = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const mcpServers = getMcpServers();

    // Prompt Caching: ツール定義の最後にキャッシュマーカーを付与
    const cachedTools = activeTools.length > 0 ? [
      ...activeTools.slice(0, -1),
      { ...activeTools[activeTools.length - 1], cache_control: { type: 'ephemeral' } }
    ] : activeTools;
    const useMcpBeta = mcpServers.length > 0;

    while (toolRound < 10) {
      const stream = (useMcpBeta ? anthropic.beta : anthropic).messages.stream({
        model: chatModel,
        max_tokens: useThinking ? 16000 : 4096,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: cachedTools,
        messages,
        ...(useThinking ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {}),
        ...(useMcpBeta ? { betas: ['mcp-client-2025-04-04'], mcp_servers: mcpServers } : {})
      });

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          fullAssistantText += ev.delta.text;
          res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
        }
        if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
          res.write(`data: ${JSON.stringify({ thinking: ev.delta.thinking })}\n\n`);
        }
      }

      const finalMsg = await stream.finalMessage();
      totalInputTokens += finalMsg.usage?.input_tokens || 0;
      totalOutputTokens += finalMsg.usage?.output_tokens || 0;
      if (finalMsg.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: finalMsg.content });

      const toolResults = [];
      for (const block of finalMsg.content) {
        if (block.type !== 'tool_use') continue;
        res.write(`data: ${JSON.stringify({ tool: block.name, status: 'running' })}\n\n`);
        try {
          const result = await executeTool(block.name, block.input, user);
          let toolContent;
          if (result?.image?.base64) {
            const meta = { ...result, image: undefined, image_attached: true };
            toolContent = [
              { type: 'image', source: { type: 'base64', media_type: result.image.mediaType, data: result.image.base64 } },
              { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
            ];
          } else if (result?.pdf?.base64) {
            const meta = { ...result, pdf: undefined, pdf_attached: true };
            toolContent = [
              { type: 'document', source: { type: 'base64', media_type: result.pdf.mediaType, data: result.pdf.base64 } },
              { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
            ];
          } else {
            toolContent = JSON.stringify(result).slice(0, 80000);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
          const doneEvent = { tool: block.name, status: 'done' };
          if (block.name === 'register_task' && result?.ok && result?.id) {
            doneEvent.task = { id: result.id, title: block.input.skill_title || block.input.skill_name, task_type: block.input.task_type };
          }
          res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
        } catch(e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
          res.write(`data: ${JSON.stringify({ tool: block.name, status: 'error', error: e.message })}\n\n`);
        }
      }
      messages.push({ role: 'user', content: toolResults });
      toolRound++;
    }

    const insertedMsg = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(convId, 'assistant', fullAssistantText);
    recordUsage(user.email, user.name, totalInputTokens, totalOutputTokens, chatModel, 'chat');
    res.write(`data: ${JSON.stringify({ done: true, messageId: insertedMsg.lastInsertRowid })}\n\n`);
    // Auto-memory: バックグラウンドで記憶抽出（完了を待たない）
    extractAndSaveMemories(user.email, messages).catch(() => {});
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

// GET /api/conversations/search?q=xxx&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=30
app.get('/api/conversations/search', (req, res) => {
  const q    = String(req.query.q || '').trim();
  const from = req.query.from ? String(req.query.from) : null;
  const to   = req.query.to   ? String(req.query.to) + ' 23:59:59' : null;
  const lim  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  if (!q && !from && !to) return res.json([]);

  const like = q ? '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%' : null;

  const whereParts = ['c.user_email = ?'];
  const params = [req.user.email];

  if (like) {
    whereParts.push(`(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  if (from) { whereParts.push('c.updated_at >= ?'); params.push(from); }
  if (to)   { whereParts.push('c.updated_at <= ?'); params.push(to); }

  // スニペット用サブクエリパラメータ
  const snipParams = like ? [q, like] : [null, null];
  const rows = db.prepare(`
    SELECT c.id, c.title, c.updated_at,
      ${like ? `(SELECT GROUP_CONCAT(substr(content, MAX(1, instr(LOWER(content), LOWER(?)) - 50), 200), '|||')
                 FROM (SELECT content FROM messages WHERE conversation_id=c.id AND content LIKE ? ESCAPE '\\' ORDER BY id LIMIT 3)
               )` : 'NULL'} AS snippets,
      ${like ? `(SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND content LIKE ? ESCAPE '\\')` : '0'} AS hits
    FROM conversations c
    WHERE ${whereParts.join(' AND ')}
    ORDER BY c.updated_at DESC LIMIT ?
  `).all(...snipParams, ...(like ? [like] : []), ...params, lim);

  audit(req.user.email, req.user.name, 'conversations.search', { q: q.slice(0, 50), results: rows.length });
  res.json(rows);
});

// ── 監査ログAPI ──
app.get('/api/audit-logs', (req, res) => {
  const role = req.user.role || getUserRole(req.user.email);
  const isAdmin = role === 'admin';
  const { email, action, limit = 100, since, scope } = req.query;
  const where = [];
  const params = [];
  if (!isAdmin || scope === 'me') {
    where.push('email = ?'); params.push(req.user.email);
  } else if (email) {
    where.push('email = ?'); params.push(email);
  }
  if (action) { where.push('action LIKE ?'); params.push(action + '%'); }
  if (since) { where.push('ts >= ?'); params.push(since); }
  const sql = `SELECT id, ts, email, name, action, details FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(parseInt(limit, 10) || 100, 1000));
  const rows = db.prepare(sql).all(...params);
  res.json({ admin_view: isAdmin, rows });
});

// ── ダッシュボードAPI ──
app.get('/api/dashboard', (req, res) => {
  const role = req.user.role || getUserRole(req.user.email);
  const isAdmin = role === 'admin';
  const myEmail = req.user.email;
  const todayStart = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' }) + ' 00:00:00';
  const monthStart = todayStart.slice(0, 7) + '-01 00:00:00';
  // 個人/全体 切替
  const scope = isAdmin && req.query.scope === 'all' ? 'all' : 'me';
  const emailClause = scope === 'me' ? 'AND email = ?' : '';
  const emailParam = scope === 'me' ? [myEmail] : [];
  // チャット数
  const todayChats = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action='chat' AND ts >= ? ${emailClause}`).get(todayStart, ...emailParam).c;
  const monthChats = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action='chat' AND ts >= ? ${emailClause}`).get(monthStart, ...emailParam).c;
  // ツール呼び出し（上位）
  const topTools = db.prepare(`SELECT action, COUNT(*) AS c FROM audit_logs WHERE action LIKE 'tool.%' AND ts >= ? ${emailClause} GROUP BY action ORDER BY c DESC LIMIT 10`).all(monthStart, ...emailParam);
  // 最近のタスク実行
  const recentTasks = db.prepare(`SELECT id, user_email, skill_title, status, started_at, finished_at FROM task_runs ${scope === 'me' ? 'WHERE user_email = ?' : ''} ORDER BY id DESC LIMIT 10`).all(...(scope === 'me' ? [myEmail] : []));
  // 直近アクティブユーザー（管理者のみ）
  let activeUsers = [];
  if (isAdmin && scope === 'all') {
    activeUsers = db.prepare(`SELECT email, name, COUNT(*) AS actions, MAX(ts) AS last_action FROM audit_logs WHERE ts >= ? GROUP BY email ORDER BY actions DESC LIMIT 10`).all(todayStart);
  }
  // 連携サービス状態（自分）
  const integ = {
    drive: !!db.prepare('SELECT 1 FROM user_drive_tokens WHERE email=?').get(myEmail),
    calendar: !!db.prepare('SELECT 1 FROM user_calendar_tokens WHERE email=?').get(myEmail),
    gmail: !!db.prepare('SELECT 1 FROM user_gmail_tokens WHERE email=?').get(myEmail),
    chatwork: !!db.prepare('SELECT 1 FROM user_chatwork_tokens WHERE email=?').get(myEmail)
  };
  res.json({ scope, today_chats: todayChats, month_chats: monthChats, top_tools: topTools, recent_tasks: recentTasks, active_users: activeUsers, integrations: integ });
});

// GET /api/dashboard/trends — 日別チャット数・ユーザー別統計
app.get('/api/dashboard/trends', (req, res) => {
  const role = req.user.role || getUserRole(req.user.email);
  const isAdmin = role === 'admin';
  const myEmail = req.user.email;
  const scope = isAdmin && req.query.scope === 'all' ? 'all' : 'me';
  const emailClause = scope === 'me' ? "AND email = ?" : '';
  const emailParam = scope === 'me' ? [myEmail] : [];

  // 過去30日の日別チャット数（JST基準で集計）
  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const daily = db.prepare(`
    SELECT substr(datetime(ts, '+9 hours'), 1, 10) as day, COUNT(*) as chats
    FROM audit_logs
    WHERE action = 'chat' AND ts >= ? ${emailClause}
    GROUP BY day ORDER BY day
  `).all(thirtyAgo, ...emailParam);

  // ユーザー別今月統計（管理者のみ）
  let userStats = [];
  if (isAdmin && scope === 'all') {
    const monthStart = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' }).slice(0, 7) + '-01 00:00:00';
    userStats = db.prepare(`
      SELECT email, name,
        SUM(CASE WHEN action='chat' THEN 1 ELSE 0 END) as chats,
        SUM(CASE WHEN action LIKE 'tool.%' THEN 1 ELSE 0 END) as tools,
        MAX(ts) as last_action
      FROM audit_logs WHERE ts >= ?
      GROUP BY email ORDER BY chats DESC LIMIT 20
    `).all(monthStart);
  }

  res.json({ scope, daily, user_stats: userStats });
});

// ── Webhook管理API（認証済みユーザー） ──
app.get('/api/webhooks', (req, res) => {
  const rows = db.prepare('SELECT token, label, skill_name, prompt_template, enabled, created_at, last_used_at FROM webhook_tokens WHERE owner_email=? ORDER BY created_at DESC').all(req.user.email);
  res.json(rows);
});
app.post('/api/webhooks', (req, res) => {
  const { label = '', skill_name = '', prompt_template = '' } = req.body || {};
  const crypto = require('crypto');
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare('INSERT INTO webhook_tokens (token, owner_email, label, skill_name, prompt_template) VALUES (?,?,?,?,?)').run(token, req.user.email, label, skill_name, prompt_template);
  audit(req.user.email, req.user.name, 'webhook.create', { token });
  res.json({ ok: true, token, url: `https://d2jjp21sq86i80.cloudfront.net/webhooks/${token}` });
});
app.patch('/api/webhooks/:token', (req, res) => {
  const wh = db.prepare('SELECT owner_email FROM webhook_tokens WHERE token=?').get(req.params.token);
  if (!wh || wh.owner_email !== req.user.email) return res.status(404).json({ error: 'not found' });
  const { label, skill_name, prompt_template, enabled } = req.body || {};
  const sets = [], vals = [];
  if (label != null)           { sets.push('label=?'); vals.push(label); }
  if (skill_name != null)      { sets.push('skill_name=?'); vals.push(skill_name); }
  if (prompt_template != null) { sets.push('prompt_template=?'); vals.push(prompt_template); }
  if (enabled != null)         { sets.push('enabled=?'); vals.push(enabled ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.token);
  db.prepare(`UPDATE webhook_tokens SET ${sets.join(',')} WHERE token=?`).run(...vals);
  res.json({ ok: true });
});
app.delete('/api/webhooks/:token', (req, res) => {
  db.prepare('DELETE FROM webhook_tokens WHERE token=? AND owner_email=?').run(req.params.token, req.user.email);
  audit(req.user.email, req.user.name, 'webhook.delete', { token: req.params.token });
  res.json({ ok: true });
});
app.get('/api/webhooks/:token/logs', (req, res) => {
  const wh = db.prepare('SELECT owner_email FROM webhook_tokens WHERE token=?').get(req.params.token);
  if (!wh || wh.owner_email !== req.user.email) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare('SELECT id, received_at, source_ip, status, error, substr(payload,1,500) AS payload_preview FROM webhook_logs WHERE token=? ORDER BY id DESC LIMIT 50').all(req.params.token);
  res.json(rows);
});

// POST /api/conversations
app.post('/api/conversations', (req, res) => {
  const { title } = req.body;
  const r = db.prepare('INSERT INTO conversations (user_email, title) VALUES (?,?)').run(req.user.email, title || '新しい依頼');
  res.json({ id: r.lastInsertRowid });
});

// POST /api/messages/:id/feedback - AI回答へのフィードバック（👍/👎）
app.post('/api/messages/:id/feedback', (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const { rating, comment = '' } = req.body;
  if (!Number.isFinite(messageId) || ![1, -1, 0].includes(rating)) {
    return res.status(400).json({ error: 'rating は 1 / -1 / 0 のみ' });
  }
  // メッセージの所有確認
  const m = db.prepare(`
    SELECT m.id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.user_email = ?
  `).get(messageId, req.user.email);
  if (!m) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (rating === 0) {
    db.prepare('DELETE FROM ai_response_feedback WHERE message_id=?').run(messageId);
  } else {
    db.prepare(`
      INSERT INTO ai_response_feedback (message_id, user_email, rating, comment)
      VALUES (?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment, created_at=datetime('now','localtime')
    `).run(messageId, req.user.email, rating, String(comment).slice(0, 500));
  }
  audit(req.user.email, req.user.name, 'feedback.ai_response', { messageId, rating });
  res.json({ ok: true });
});

// GET /api/conversations/:id/messages
app.get('/api/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND user_email=?').get(req.params.id, req.user.email);
  if (!conv) return res.status(403).json({ error: '見つかりません' });
  const msgs = db.prepare(`
    SELECT m.id, m.role, m.content, m.created_at, f.rating AS feedback_rating
    FROM messages m
    LEFT JOIN ai_response_feedback f ON f.message_id = m.id
    WHERE m.conversation_id=? ORDER BY m.id
  `).all(req.params.id);
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
  const rows = db.prepare(`
    SELECT us.*,
      (SELECT al.name FROM audit_logs al WHERE al.email = us.owner_email AND al.name != '' ORDER BY al.ts DESC LIMIT 1) as owner_name,
      (SELECT COUNT(*) FROM task_runs tr WHERE tr.skill_name = us.name AND tr.status != 'running') as stat_total,
      (SELECT COUNT(*) FROM task_runs tr WHERE tr.skill_name = us.name AND tr.status = 'done') as stat_success,
      (SELECT CAST(ROUND(AVG((julianday(tr.finished_at) - julianday(tr.started_at)) * 86400)) AS INTEGER)
        FROM task_runs tr WHERE tr.skill_name = us.name AND tr.finished_at IS NOT NULL AND tr.status = 'done') as stat_avg_sec,
      (SELECT COUNT(*) FROM skill_versions sv WHERE sv.skill_id = us.id) as version_count
    FROM user_skills us
    WHERE us.owner_email=?
      OR (us.shared=1 AND us.shared_with IS NULL)
      OR (us.shared=1 AND us.shared_with IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(us.shared_with) WHERE value=?))
    ORDER BY us.updated_at DESC
  `).all(req.user.email, req.user.email);
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
    serverError(res, e);
  }
});

// PUT /api/skills/:id
app.put('/api/skills/:id', (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!skill) return res.status(403).json({ error: '見つかりません' });
  const { title, description, steps, shared, shared_with } = req.body;

  // 共有設定のみ更新（shared / shared_with）
  if ((shared !== undefined || shared_with !== undefined) && title === undefined && description === undefined && steps === undefined) {
    const newShared = shared !== undefined ? (shared ? 1 : 0) : skill.shared;
    // shared=false なら shared_with もリセット
    const newSharedWith = newShared === 0 ? null
      : (shared_with === null ? null : (Array.isArray(shared_with) ? JSON.stringify(shared_with) : skill.shared_with));
    db.prepare(`UPDATE user_skills SET shared=?, shared_with=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(newShared, newSharedWith, req.params.id);
    const action = newShared === 0 ? 'skill.unshare' : (newSharedWith ? 'skill.share_team' : 'skill.share_all');
    audit(req.user.email, req.user.name, action, { id: req.params.id, name: skill.name });
    return res.json({ ok: true });
  }

  if (!title?.trim()) return res.status(400).json({ error: 'title は必須' });
  // 更新前の内容をバージョンとして自動保存
  const maxVer = db.prepare('SELECT MAX(version_num) as v FROM skill_versions WHERE skill_id=?').get(req.params.id);
  const nextVer = (maxVer?.v || 0) + 1;
  db.prepare('INSERT OR IGNORE INTO skill_versions (skill_id, version_num, title, description, steps) VALUES (?,?,?,?,?)')
    .run(req.params.id, nextVer, skill.title, skill.description, skill.steps);
  db.prepare('DELETE FROM skill_versions WHERE skill_id=? AND version_num <= ?').run(req.params.id, nextVer - 10);
  db.prepare(`UPDATE user_skills SET title=?, description=?, steps=?, shared=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(title.trim(), description ?? skill.description, steps ?? skill.steps,
      shared !== undefined ? (shared ? 1 : 0) : skill.shared, req.params.id);
  audit(req.user.email, req.user.name, 'skill.update', { id: req.params.id });
  res.json({ ok: true });
});

// DELETE /api/skills/:id
app.delete('/api/skills/:id', (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!skill) return res.status(403).json({ error: '見つかりません' });
  db.prepare('DELETE FROM user_skills WHERE id=?').run(req.params.id);
  audit(req.user.email, req.user.name, 'skill.delete', { id: req.params.id, name: skill.name });
  res.json({ ok: true });
});

// GET /api/skills/:id/versions
app.get('/api/skills/:id/versions', (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!skill) return res.status(403).json({ error: '見つかりません' });
  const versions = db.prepare(
    'SELECT id, version_num, title, description, saved_at, substr(steps,1,200) as steps_preview FROM skill_versions WHERE skill_id=? ORDER BY version_num DESC'
  ).all(req.params.id);
  res.json(versions);
});

// POST /api/skills/:id/versions/:vnum/restore
app.post('/api/skills/:id/versions/:vnum/restore', (req, res) => {
  const skill = db.prepare('SELECT * FROM user_skills WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!skill) return res.status(403).json({ error: '見つかりません' });
  const ver = db.prepare('SELECT * FROM skill_versions WHERE skill_id=? AND version_num=?').get(req.params.id, req.params.vnum);
  if (!ver) return res.status(404).json({ error: 'バージョンが見つかりません' });
  // 復元前に現在の内容を保存
  const maxVer = db.prepare('SELECT MAX(version_num) as v FROM skill_versions WHERE skill_id=?').get(req.params.id);
  const nextVer = (maxVer?.v || 0) + 1;
  db.prepare('INSERT OR IGNORE INTO skill_versions (skill_id, version_num, title, description, steps) VALUES (?,?,?,?,?)')
    .run(req.params.id, nextVer, skill.title, skill.description, skill.steps);
  db.prepare(`UPDATE user_skills SET title=?, description=?, steps=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(ver.title, ver.description, ver.steps, req.params.id);
  audit(req.user.email, req.user.name, 'skill.restore', { id: req.params.id, version_num: ver.version_num });
  res.json({ ok: true });
});

// POST /api/skills/run-parallel — 複数スキルを並列実行
app.post('/api/skills/run-parallel', apiRateLimit, async (req, res) => {
  const { skill_ids } = req.body;
  if (!Array.isArray(skill_ids) || skill_ids.length < 2 || skill_ids.length > 5) {
    return res.status(400).json({ error: 'skill_ids は 2〜5 件' });
  }

  const sharedCheck = `owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?)))`;
  const skills = skill_ids.map(id =>
    db.prepare(`SELECT * FROM user_skills WHERE id=? AND (${sharedCheck})`).get(id, req.user.email, req.user.email)
  );
  if (skills.some(s => !s)) return res.status(403).json({ error: '一部のスキルにアクセスできません' });

  audit(req.user.email, req.user.name, 'skill.run_parallel', { ids: skill_ids });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  await Promise.allSettled(skills.map(async skill => {
    res.write(`data: ${JSON.stringify({ skill_id: skill.id, title: skill.title, status: 'running' })}\n\n`);
    try {
      const r = await runSkillBackground(
        { skill_name: skill.name, skill_title: skill.title, description: skill.description, steps: skill.steps, model: 'sonnet' },
        req.user.email
      );
      // task_runs テーブルから実際の結果テキストを取得
      const runRow = r.runId ? db.prepare('SELECT result FROM task_runs WHERE id=?').get(r.runId) : null;
      const resultText = r.ok ? (runRow?.result || '（結果なし）') : r.error;
      res.write(`data: ${JSON.stringify({ skill_id: skill.id, status: r.ok ? 'done' : 'error', result: resultText })}\n\n`);
    } catch(e) {
      res.write(`data: ${JSON.stringify({ skill_id: skill.id, status: 'error', result: e.message })}\n\n`);
    }
  }));

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

// GET /api/skills/:id/estimate  — 実行コスト見積もり
app.get('/api/skills/:id/estimate', (req, res) => {
  const skill = db.prepare(`SELECT * FROM user_skills WHERE id=? AND (owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?))))`).get(req.params.id, req.user.email, req.user.email);
  if (!skill) return res.status(404).json({ error: 'Not found' });

  const role = req.user.role || getUserRole(req.user.email);
  const systemPrompt = getSystemPromptForUser(role, req.user.email);

  // システムプロンプト + ツール定義のトークン推定
  const systemTokens = Math.round(systemPrompt.length / 3);
  const toolCount = TOOLS_FOR_ROLE[role] ? TOOLS_FOR_ROLE[role].size : TOOLS.length;
  const toolTokens = toolCount * 110; // ツール定義 1件あたり約110トークン

  // スキル内容のトークン推定（日本語主体: 文字数÷2）
  const skillText = (skill.title || '') + (skill.description || '') + (skill.steps || '');
  const skillTokens = Math.round(skillText.length / 2);

  // 手順中のツール呼び出し回数を推定
  const toolKeywords = ['query_corp_db', 'send_chatwork', 'list_drive', 'read_drive', 'update_sheet', 'list_calendar', 'list_gmail', 'call_oss_ai', 'list_wp', 'create_wp'];
  const steps = skill.steps || '';
  const toolHits = toolKeywords.filter(kw => steps.includes(kw)).length;
  const estimatedRounds = Math.max(toolHits, 1);

  // 入力・出力トークンの推定
  const inputTokens = systemTokens + toolTokens + skillTokens + estimatedRounds * 350;
  const outputTokens = 300 + estimatedRounds * 250;

  // claude-sonnet-4-6 料金: 入力 $3/1M、出力 $15/1M
  const costUsd = (inputTokens / 1e6 * 3) + (outputTokens / 1e6 * 15);
  const costJpy = Math.ceil(costUsd * _usdJpy);

  res.json({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_rounds: estimatedRounds,
    cost_usd: Number(costUsd.toFixed(5)),
    cost_jpy: costJpy,
    usd_jpy: _usdJpy
  });
});

// POST /api/skills/:id/run
app.post('/api/skills/:id/run', async (req, res) => {
  const skill = db.prepare(`SELECT * FROM user_skills WHERE id=? AND (owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?))))`).get(req.params.id, req.user.email, req.user.email);
  if (!skill) return res.status(404).json({ error: 'Not found' });

  audit(req.user.email, req.user.name, 'skill.run', { id: skill.id, name: skill.name });

  // task_runs に記録
  const runInsert = db.prepare('INSERT INTO task_runs (user_email, skill_name, skill_title, status) VALUES (?,?,?,?)');
  const runRow = runInsert.run(req.user.email, skill.name, skill.title, 'running');
  const runId = runRow.lastInsertRowid;

  // run_count 更新
  db.prepare("UPDATE user_skills SET run_count=run_count+1, updated_at=datetime('now','localtime') WHERE id=?").run(skill.id);

  // {{変数名}} テンプレート置換
  let prompt = `# ${skill.title}\n\n${skill.description}\n\n## 実行手順\n\n${skill.steps}`;
  const variables = req.body?.variables || {};
  if (Object.keys(variables).length > 0) {
    for (const [k, v] of Object.entries(variables)) {
      prompt = prompt.split(`{{${k}}}`).join(String(v));
    }
  }

  // 拡張思考モード（Sonnet のみ対応）
  const useSkillThinking = !!(req.body?.thinking);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  let resultBuffer = '';
  try {
    const role = req.user.role || getUserRole(req.user.email);
    const allowedToolNames = TOOLS_FOR_ROLE[role];
    const activeTools = (allowedToolNames ? TOOLS.filter(t => allowedToolNames.has(t.name)) : TOOLS)
      .filter(t => t.name !== 'register_task');
    const systemPrompt = getSystemPromptForUser(role, req.user.email);
    const messages = [{ role: 'user', content: prompt }];
    let toolRound = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Hooks: pre_run
    await executeHooks('pre_run', skill, req.user.email, prompt).catch(() => {});

    // Prompt Caching: ツール定義をキャッシュ
    const cachedSkillTools = activeTools.length > 0 ? [
      ...activeTools.slice(0, -1),
      { ...activeTools[activeTools.length - 1], cache_control: { type: 'ephemeral' } }
    ] : activeTools;

    const claudeSkillRun = async () => {
      while (toolRound < 10) {
        const stream = anthropic.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: useSkillThinking ? 16000 : 4096,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: cachedSkillTools,
          messages,
          ...(useSkillThinking ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {})
        });

        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            resultBuffer += ev.delta.text;
            res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
          }
          if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
            res.write(`data: ${JSON.stringify({ thinking: ev.delta.thinking })}\n\n`);
          }
        }

        const finalMsg = await stream.finalMessage();
        totalInputTokens += finalMsg.usage?.input_tokens || 0;
        totalOutputTokens += finalMsg.usage?.output_tokens || 0;
        if (finalMsg.stop_reason !== 'tool_use') break;

        messages.push({ role: 'assistant', content: finalMsg.content });

        for (const block of finalMsg.content) {
          if (block.type === 'tool_use') {
            res.write(`data: ${JSON.stringify({ tool: block.name, status: 'running' })}\n\n`);
          }
        }

        const toolResults = [];
        for (const block of finalMsg.content) {
          if (block.type !== 'tool_use') continue;
          try {
            const result = await executeTool(block.name, block.input, req.user);
            let toolContent;
            if (result?.image?.base64) {
              const meta = { ...result, image: undefined, image_attached: true };
              toolContent = [
                { type: 'image', source: { type: 'base64', media_type: result.image.mediaType, data: result.image.base64 } },
                { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
              ];
            } else if (result?.pdf?.base64) {
              const meta = { ...result, pdf: undefined, pdf_attached: true };
              toolContent = [
                { type: 'document', source: { type: 'base64', media_type: result.pdf.mediaType, data: result.pdf.base64 } },
                { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
              ];
            } else {
              toolContent = JSON.stringify(result).slice(0, 80000);
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
            res.write(`data: ${JSON.stringify({ tool: block.name, status: 'done' })}\n\n`);
          } catch(e) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
            res.write(`data: ${JSON.stringify({ tool: block.name, status: 'error', error: e.message })}\n\n`);
          }
        }
        messages.push({ role: 'user', content: toolResults });
        toolRound++;
      }
    };

    try {
      await retryWithBackoff(claudeSkillRun);
    } catch(claudeErr) {
      if (isOverloadError(claudeErr) && process.env.OPENROUTER_API_KEY) {
        res.write(`data: ${JSON.stringify({ text: '\n\n⚠️ Claude API が混雑しています。OSS AI（Qwen3-235B）で継続します...\n\n' })}\n\n`);
        const fb = await runWithOss(prompt, systemPrompt, activeTools, req.user);
        resultBuffer      += fb.resultBuffer;
        totalInputTokens  += fb.totalInputTokens;
        totalOutputTokens += fb.totalOutputTokens;
        res.write(`data: ${JSON.stringify({ text: fb.resultBuffer })}\n\n`);
      } else {
        throw claudeErr;
      }
    }

    db.prepare(`UPDATE task_runs SET status=?, result=?, input_tokens=?, output_tokens=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run('done', resultBuffer.slice(0, 2000), totalInputTokens, totalOutputTokens, runId);
    recordUsage(req.user.email, req.user.name, totalInputTokens, totalOutputTokens, 'claude-sonnet-4-6', 'skill_run');
    // Hooks: post_run
    executeHooks('post_run', skill, req.user.email, resultBuffer).catch(() => {});
    res.write(`data: ${JSON.stringify({ done: true, code: 0, runId })}\n\n`);
  } catch(e) {
    db.prepare(`UPDATE task_runs SET status=?, result=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run('error', e.message.slice(0, 2000), runId);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, code: 1, runId })}\n\n`);
  }
  res.end();
});

// GET /api/skills/:id/plan — Plan Mode: 実行前プレビュー
app.get('/api/skills/:id/plan', async (req, res) => {
  const skill = db.prepare(`SELECT * FROM user_skills WHERE id=? AND (owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?))))`).get(req.params.id, req.user.email, req.user.email);
  if (!skill) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `以下のスキルを実行する前に、実行計画を番号付きリストで示してください。各ステップで使用するツール（DBクエリ・Chatwork送信・Drive操作等）を明記してください。\n\nスキル: ${skill.title}\n説明: ${skill.description}\n手順:\n${skill.steps}`
      }]
    });
    res.json({ plan: r.content[0]?.text || '', skill_id: skill.id, title: skill.title });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 為替レート（USD/JPY）──
let _usdJpy = 150;
let _usdJpyUpdatedAt = null;
let _usdJpyFetching = false;

async function fetchUsdJpy() {
  if (_usdJpyFetching) return;
  _usdJpyFetching = true;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=JPY', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const rate = data?.rates?.JPY;
    if (rate && rate > 50 && rate < 300) {
      _usdJpy = Math.round(rate * 10) / 10;
      _usdJpyUpdatedAt = new Date().toISOString();
      console.log(`[fx] USD/JPY updated: ${_usdJpy}`);
    }
  } catch (e) {
    console.warn('[fx] fetch failed:', e.message);
  } finally {
    _usdJpyFetching = false;
  }
}
fetchUsdJpy();
setInterval(fetchUsdJpy, 24 * 60 * 60 * 1000); // 1日1回更新

// GET /api/exchange-rate
app.get('/api/exchange-rate', (req, res) => {
  res.json({ usd_jpy: _usdJpy, updated_at: _usdJpyUpdatedAt, source: 'frankfurter.app' });
});

// ── Usage API ──
// Sonnet 4.6: $3/1M input, $15/1M output
const PRICE_INPUT_PER_M  = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;

function calcCost(inputTokens, outputTokens) {
  const usd = (inputTokens / 1e6 * PRICE_INPUT_PER_M) + (outputTokens / 1e6 * PRICE_OUTPUT_PER_M);
  return { usd: Number(usd.toFixed(4)), jpy: Math.ceil(usd * _usdJpy) };
}

function rowToCost(r) {
  // cost_usd_sum > 0 ならモデル別実績コストを使い、古いレコード(=0)はSonnet料金でフォールバック
  const usd = r.cost_usd_sum > 0 ? r.cost_usd_sum : calcCost(r.input_tokens, r.output_tokens).usd;
  return { usd: Number(usd.toFixed(4)), jpy: Math.ceil(usd * _usdJpy) };
}

// GET /api/usage/me  — 本人の月次サマリー（直近3ヶ月）
app.get('/api/usage/me', (req, res) => {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', ts) AS month,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      COUNT(*)           AS requests,
      SUM(cost_usd)      AS cost_usd_sum
    FROM token_usage
    WHERE email = ?
      AND ts >= date('now', '-3 months')
    GROUP BY month
    ORDER BY month DESC
  `).all(req.user.email);

  res.json(rows.map(r => ({ ...r, ...rowToCost(r) })));
});

// GET /api/usage/all  — 全ユーザー当月サマリー（admin専用）
app.get('/api/usage/all', (req, res) => {
  const role = req.user.role || getUserRole(req.user.email);
  if (role !== 'admin') return res.status(403).json({ error: '管理者のみ' });

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT
      email,
      MAX(name) AS name,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      COUNT(*)           AS requests,
      SUM(cost_usd)      AS cost_usd_sum
    FROM token_usage
    WHERE strftime('%Y-%m', ts) = ?
    GROUP BY email
    ORDER BY cost_usd_sum DESC
  `).all(month);

  const total = rows.reduce((acc, r) => {
    acc.input_tokens  += r.input_tokens;
    acc.output_tokens += r.output_tokens;
    acc.requests      += r.requests;
    acc.cost_usd_sum  += r.cost_usd_sum || 0;
    return acc;
  }, { input_tokens: 0, output_tokens: 0, requests: 0, cost_usd_sum: 0 });

  res.json({
    month,
    users: rows.map(r => ({ ...r, ...rowToCost(r) })),
    total: { ...total, ...rowToCost(total) }
  });
});

// ── User Settings API ──

app.get('/api/user-settings', (req, res) => {
  const row = db.prepare('SELECT custom_rules FROM user_settings WHERE email=?').get(req.user.email);
  res.json({ custom_rules: row?.custom_rules || '' });
});

app.put('/api/user-settings', (req, res) => {
  const { custom_rules = '' } = req.body;
  db.prepare(`
    INSERT INTO user_settings (email, custom_rules, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(email) DO UPDATE SET custom_rules=excluded.custom_rules, updated_at=excluded.updated_at
  `).run(req.user.email, custom_rules.slice(0, 2000));
  audit(req.user.email, req.user.name, 'user_settings.update');
  res.json({ ok: true });
});

// ── Memories API ──
app.get('/api/memories', (req, res) => {
  const rows = db.prepare('SELECT id, memory, importance, created_at FROM user_memories WHERE email=? ORDER BY id DESC LIMIT 20').all(req.user.email);
  res.json(rows);
});
app.delete('/api/memories/:id', (req, res) => {
  db.prepare('DELETE FROM user_memories WHERE id=? AND email=?').run(req.params.id, req.user.email);
  res.json({ ok: true });
});
app.delete('/api/memories', (req, res) => {
  db.prepare('DELETE FROM user_memories WHERE email=?').run(req.user.email);
  res.json({ ok: true });
});

// ── Skill Hooks API ──
app.get('/api/skill-hooks', (req, res) => {
  const hooks = db.prepare('SELECT * FROM skill_hooks WHERE owner_email=? ORDER BY id DESC').all(req.user.email);
  res.json(hooks);
});
app.post('/api/skill-hooks', (req, res) => {
  const { skill_id, hook_type, action, config } = req.body;
  if (!hook_type || !action) return res.status(400).json({ error: 'hook_type と action は必須' });
  const r = db.prepare('INSERT INTO skill_hooks (owner_email, skill_id, hook_type, action, config) VALUES (?,?,?,?,?)').run(req.user.email, skill_id || null, hook_type, action, config ? JSON.stringify(config) : '{}');
  audit(req.user.email, req.user.name, 'hook.create', { id: r.lastInsertRowid, hook_type, action });
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.patch('/api/skill-hooks/:id', (req, res) => {
  const hook = db.prepare('SELECT id FROM skill_hooks WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
  if (!hook) return res.status(404).json({ error: 'not found' });
  const { enabled } = req.body;
  if (enabled !== undefined) db.prepare('UPDATE skill_hooks SET enabled=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/skill-hooks/:id', (req, res) => {
  db.prepare('DELETE FROM skill_hooks WHERE id=? AND owner_email=?').run(req.params.id, req.user.email);
  res.json({ ok: true });
});

// ── Files API (Anthropic Files API) ──
app.post('/api/files/upload', apiRateLimit, async (req, res) => {
  const { filename, mediaType, base64 } = req.body;
  if (!filename || !mediaType || !base64) return res.status(400).json({ error: 'filename, mediaType, base64 は必須' });
  const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (!supportedTypes.includes(mediaType)) return res.status(400).json({ error: '未対応ファイル形式' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    const { Blob } = require('buffer');
    const fileObj = new File([new Blob([buffer], { type: mediaType })], filename, { type: mediaType });
    const fileResponse = await anthropic.beta.files.upload({ file: fileObj });
    db.prepare('INSERT INTO uploaded_files (email, file_id, filename, media_type, size_bytes) VALUES (?,?,?,?,?)').run(req.user.email, fileResponse.id, filename, mediaType, buffer.length);
    audit(req.user.email, req.user.name, 'file.upload', { file_id: fileResponse.id, filename, size: buffer.length });
    res.json({ ok: true, file_id: fileResponse.id, filename });
  } catch(e) {
    serverError(res, e, 'ファイルアップロードに失敗しました');
  }
});
app.get('/api/files', (req, res) => {
  const files = db.prepare('SELECT id, file_id, filename, media_type, size_bytes, created_at FROM uploaded_files WHERE email=? ORDER BY id DESC LIMIT 50').all(req.user.email);
  res.json(files);
});
app.delete('/api/files/:fileId', async (req, res) => {
  const file = db.prepare('SELECT id FROM uploaded_files WHERE file_id=? AND email=?').get(req.params.fileId, req.user.email);
  if (!file) return res.status(404).json({ error: 'not found' });
  try { await anthropic.beta.files.delete(req.params.fileId); } catch(e) { console.warn('[files] Anthropic delete failed:', e.message); }
  db.prepare('DELETE FROM uploaded_files WHERE id=?').run(file.id);
  res.json({ ok: true });
});

// ── Batch API ──
app.post('/api/skills/batch', apiRateLimit, async (req, res) => {
  const { skill_ids } = req.body;
  if (!Array.isArray(skill_ids) || skill_ids.length < 1 || skill_ids.length > 10) {
    return res.status(400).json({ error: 'skill_ids は 1〜10 件' });
  }
  const sharedCheck = `owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?)))`;
  const skills = skill_ids.map(id => db.prepare(`SELECT * FROM user_skills WHERE id=? AND (${sharedCheck})`).get(id, req.user.email, req.user.email)).filter(Boolean);
  if (skills.length === 0) return res.status(404).json({ error: 'スキルが見つかりません' });
  const role = req.user.role || getUserRole(req.user.email);
  const systemPrompt = getSystemPromptForUser(role, req.user.email);
  const requests = skills.map(s => ({
    custom_id: `skill-${s.id}`,
    params: {
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: `# ${s.title}\n\n${s.description}\n\n## 実行手順\n\n${s.steps}` }]
    }
  }));
  try {
    const batch = await anthropic.messages.batches.create({ requests });
    db.prepare('INSERT INTO skill_batch_jobs (owner_email, batch_id, skill_ids) VALUES (?,?,?)').run(req.user.email, batch.id, JSON.stringify(skill_ids));
    audit(req.user.email, req.user.name, 'skill.batch', { batch_id: batch.id, count: skills.length });
    res.json({ ok: true, batch_id: batch.id, status: batch.processing_status, skill_count: skills.length });
  } catch(e) {
    serverError(res, e, 'バッチ実行の開始に失敗しました');
  }
});
app.get('/api/skills/batch/:batchId', async (req, res) => {
  const job = db.prepare('SELECT * FROM skill_batch_jobs WHERE batch_id=? AND owner_email=?').get(req.params.batchId, req.user.email);
  if (!job) return res.status(404).json({ error: 'not found' });
  try {
    const batch = await anthropic.messages.batches.retrieve(req.params.batchId);
    res.json({ batch_id: batch.id, status: batch.processing_status, request_counts: batch.request_counts, created_at: job.created_at });
  } catch(e) { serverError(res, e); }
});
app.get('/api/skills/batches', (req, res) => {
  const rows = db.prepare('SELECT * FROM skill_batch_jobs WHERE owner_email=? ORDER BY id DESC LIMIT 20').all(req.user.email);
  res.json(rows);
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
  catch(e) { serverError(res, e); }
});

// GET /api/chatwork/rooms/:id/messages?force=1
app.get('/api/chatwork/rooms/:id/messages', async (req, res) => {
  audit(req.user.email, req.user.name, 'cw.messages', { roomId: req.params.id });
  try {
    const force = req.query.force === '1' ? '?force=1' : '';
    res.json(await cwFetch(`/rooms/${req.params.id}/messages${force}`, {}, req.user.email));
  } catch(e) { serverError(res, e); }
});

// GET /api/chatwork/rooms/:id (room info)
app.get('/api/chatwork/rooms/:id', async (req, res) => {
  try { res.json(await cwFetch(`/rooms/${req.params.id}`, {}, req.user.email)); }
  catch(e) { serverError(res, e); }
});

// POST /api/chatwork/rooms/:id/messages  body: { body }
app.post('/api/chatwork/rooms/:id/messages', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'bodyは必須' });
  audit(req.user.email, req.user.name, 'cw.send', { roomId: req.params.id, preview: body.slice(0, 50) });
  try {
    const params = new URLSearchParams({ body });
    res.json(await cwFetch(`/rooms/${req.params.id}/messages`, { method: 'POST', body: params.toString() }, req.user.email));
  } catch(e) { serverError(res, e); }
});

// GET /api/chatwork/me
app.get('/api/chatwork/me', async (req, res) => {
  try { res.json(await cwFetch('/me', {}, req.user.email)); }
  catch(e) { serverError(res, e); }
});

// ── Chatwork OAuth ──
app.get('/auth/chatwork', (req, res) => {
  const clientId = process.env.CHATWORK_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(503).send('CHATWORK_OAUTH_CLIENT_IDが未設定です。環境変数を確認してください。');
  const callbackUrl = process.env.CHATWORK_CALLBACK_URL;
  const csrf = crypto.randomBytes(16).toString('hex');
  req.session.oauth_csrf_chatwork = csrf;
  const state = csrf + '.' + Buffer.from(req.user.email).toString('base64url');
  const scopes = 'offline_access rooms.all:read rooms.messages:write users.profile.me:read';
  const authUrl = `${CW_OAUTH_BASE}/packages/oauth2/login.php`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(callbackUrl)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&state=${encodeURIComponent(state)}`;
  console.log('[auth/chatwork] redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/chatwork/callback', async (req, res) => {
  const { code, error, state } = req.query;
  console.log('[chatwork/callback] called', { code: !!code, error, state: !!state, auth: req.isAuthenticated() });
  if (error || !code) return res.redirect('/?chatwork_error=1');
  const [csrfToken, emailB64] = (state || '').split('.');
  const expectedCsrf = req.session.oauth_csrf_chatwork;
  if (!csrfToken || !expectedCsrf || csrfToken !== expectedCsrf) return res.redirect('/?chatwork_error=csrf');
  delete req.session.oauth_csrf_chatwork;
  let userEmail = req.user?.email;
  if (!userEmail && emailB64) {
    try { userEmail = Buffer.from(emailB64, 'base64url').toString('utf8'); } catch(e) {}
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
app.get('/api/chatwork/status', async (req, res) => {
  const row = db.prepare('SELECT * FROM user_chatwork_tokens WHERE email=?').get(req.user.email);
  if (!row) return res.json({ connected: false });
  const expired = row.expires_at ? new Date(row.expires_at) <= new Date() : false;
  if (expired && row.refresh_token) {
    try {
      await refreshChatworkToken(row.refresh_token, req.user.email);
      return res.json({ connected: true, expired: false, updatedAt: new Date().toISOString() });
    } catch(e) {
      return res.json({ connected: true, expired: true, updatedAt: row.updated_at });
    }
  }
  res.json({ connected: true, expired, updatedAt: row.updated_at });
});

// DELETE /api/chatwork/disconnect
app.delete('/api/chatwork/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_chatwork_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'chatwork.oauth.disconnect');
  res.json({ ok: true });
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
// アロウリスト方式: 明示的に許可されたテーブルのみ照会可能。未定義テーブルはすべて拒否。
//
// ⚠️ 同期注意: このアロウリストは corp 側 PHP にも同じ内容が定義されています。
//   多層防御のため両方に同じテーブル名を維持する必要があります。
//   対応箇所: corp-dev-ec2/home/acrovision/www/corp.acrovision.jp/api/agent.php
//             の case 'query': 内 $ALLOWED_TABLES（同じ8テーブル）
//   テーブルを追加・削除する場合は必ず両方を更新してください。
const DB_BLOCKED_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|DESCRIBE|SHOW)\b/i;
const DB_ALLOWED_TABLES = new Set([
  'kintone_employees',
  'kintone_contract',
  'kintone_anken_eigyo',
  'geppo_data',
  'kintone_customers',
  'kintone_seikyu',
  'hotprofile_business_cards',
  'it_kyujin_job_acrovision'
]);
// SQLからFROM/JOIN後のテーブル参照を抽出し、すべてアロウリストに含まれるか検査
function checkSqlAllowed(sql) {
  const tableRe = /\b(?:FROM|JOIN)\s+`?(?:\w+\.)?(\w+)`?/gi;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    const t = m[1].toLowerCase();
    if (!DB_ALLOWED_TABLES.has(t)) {
      return { ok: false, table: t };
    }
  }
  return { ok: true };
}
const DB_DENIED_MESSAGE = sql => {
  const c = checkSqlAllowed(sql);
  return c.ok ? '' : `テーブル「${c.table}」への照会は許可されていません。許可: ${[...DB_ALLOWED_TABLES].join(', ')}`;
};
app.post('/api/db/query', async (req, res) => {
  const pool = getCorpDb();
  if (!pool) return res.status(503).json({ error: 'Corp DB未設定' });
  const { sql, params = [] } = req.body;
  if (!sql) return res.status(400).json({ error: 'sql is required' });
  if (DB_BLOCKED_KEYWORDS.test(sql)) {
    audit(req.user.email, req.user.name, 'db.query.denied', { reason: 'keyword', preview: sql.slice(0, 100) });
    return res.status(403).json({ error: '読み取り専用です（SELECT のみ許可、SHOW/DESCRIBE等は不可）' });
  }
  const allowCheck = checkSqlAllowed(sql);
  if (!allowCheck.ok) {
    audit(req.user.email, req.user.name, 'db.query.denied', { reason: 'table', table: allowCheck.table, preview: sql.slice(0, 100) });
    return res.status(403).json({ error: DB_DENIED_MESSAGE(sql) });
  }
  audit(req.user.email, req.user.name, 'db.query', { preview: sql.slice(0, 100) });
  try {
    const [rows] = await pool.execute(sql, params);
    res.json({ rows, count: rows.length });
  } catch(e) { serverError(res, e); }
});

// GET /api/db/tables  アロウリスト内のテーブルのみ返却
app.get('/api/db/tables', async (req, res) => {
  const pool = getCorpDb();
  if (!pool) return res.status(503).json({ error: 'Corp DB未設定' });
  try {
    const [rows] = await pool.execute('SHOW TABLES');
    const all = rows.map(r => Object.values(r)[0]);
    res.json(all.filter(t => DB_ALLOWED_TABLES.has(String(t).toLowerCase())));
  } catch(e) { serverError(res, e); }
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
  } catch(e) { serverError(res, e); }
});

// GET /api/wp/posts/:id
app.get('/api/wp/posts/:id', async (req, res) => {
  if (!process.env.WP_URL) return res.status(503).json({ error: 'WordPress未設定' });
  audit(req.user.email, req.user.name, 'wp.post', { id: req.params.id });
  try { res.json(await wpFetch(`/posts/${req.params.id}`)); }
  catch(e) { serverError(res, e); }
});

// POST /api/wp/posts  body: { title, content, status }
app.post('/api/wp/posts', async (req, res) => {
  if (!process.env.WP_URL) return res.status(503).json({ error: 'WordPress未設定' });
  const { title, content, status = 'draft' } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title と content は必須' });
  audit(req.user.email, req.user.name, 'wp.create_post', { title: title.slice(0, 50), status });
  try {
    res.json(await wpFetch('/posts', { method: 'POST', body: JSON.stringify({ title, content, status }) }));
  } catch(e) { serverError(res, e); }
});

// ── AWS SES (SDK + EC2 IAM Role) ──
// 認証は AWS SDK default credential chain（EC2 IAM Role → ~/.aws/credentials → env）
// corp-dev-ec2 の SesSend.php と同じパターン。SES_USER/SES_SECRET（旧 SMTP 認証）は無視する。
let _sesClient = null;
function getSesClient() {
  if (!_sesClient) {
    const region = process.env.SES_REGION
      || (process.env.SES_HOST || 'email-smtp.us-west-2.amazonaws.com').match(/email-smtp\.([^.]+)/)?.[1]
      || 'us-west-2';
    _sesClient = new SESClient({ region });
  }
  return _sesClient;
}
// nodemailer 互換: 文字列 "a@x.com, b@x.com" / "a@x.com; b@x.com" / 配列 / 単一文字列 を配列に正規化
function normalizeAddresses(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(/[,;]\s*/);
  return list.map(s => String(s).trim()).filter(Boolean);
}
function getSesTransport() {
  return {
    async sendMail({ from, to, cc, bcc, replyTo, subject, text, html }) {
      const destination = { ToAddresses: normalizeAddresses(to) };
      const ccList = normalizeAddresses(cc);
      const bccList = normalizeAddresses(bcc);
      if (ccList.length) destination.CcAddresses = ccList;
      if (bccList.length) destination.BccAddresses = bccList;
      const body = {};
      if (text) body.Text = { Charset: 'UTF-8', Data: text };
      if (html) body.Html = { Charset: 'UTF-8', Data: html };
      if (!body.Text && !body.Html) body.Text = { Charset: 'UTF-8', Data: '' };
      const params = {
        Source: from || process.env.SES_FROM || 'info@acrovision.co.jp',
        Destination: destination,
        Message: {
          Subject: { Charset: 'UTF-8', Data: subject || '' },
          Body: body,
        },
      };
      const replyToList = normalizeAddresses(replyTo);
      if (replyToList.length) params.ReplyToAddresses = replyToList;
      const result = await getSesClient().send(new SendEmailCommand(params));
      return { messageId: result.MessageId };
    }
  };
}

// POST /api/email/send  body: { to, subject, text, html }
app.post('/api/email/send', async (req, res) => {
  if (!process.env.SES_FROM) return res.status(503).json({ error: 'SES未設定' });
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
  } catch(e) { serverError(res, e); }
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
  } catch(e) { serverError(res, e); }
});

// ── Google Calendar API ──
function getCalendarClientForUser(user) {
  // メインログイントークン（user_drive_tokens）が calendar フルスコープを持つため優先。
  // 旧 user_calendar_tokens は calendar.readonly のみの場合があり書込不可なのでフォールバック扱い。
  let tokenRow = db.prepare('SELECT access_token, refresh_token FROM user_drive_tokens WHERE email=?').get(user.email);
  let tableName = 'user_drive_tokens';
  if (!tokenRow?.refresh_token) {
    tokenRow = db.prepare('SELECT access_token, refresh_token FROM user_calendar_tokens WHERE email=?').get(user.email);
    tableName = 'user_calendar_tokens';
  }
  if (!tokenRow?.refresh_token) {
    throw new Error('Googleカレンダー未連携。一度ログアウトして再ログインし、カレンダー権限を許可してください');
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ access_token: tokenRow.access_token, refresh_token: tokenRow.refresh_token });
  oauth2.on('tokens', tokens => {
    if (tokens.access_token) {
      db.prepare(`UPDATE ${tableName} SET access_token=?, updated_at=datetime('now','localtime') WHERE email=?`)
        .run(tokens.access_token, user.email);
    }
  });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

// GET /api/calendar/status
app.get('/api/calendar/status', (req, res) => {
  const row = db.prepare('SELECT refresh_token, updated_at FROM user_calendar_tokens WHERE email=?').get(req.user.email);
  res.json({ connected: !!(row?.refresh_token), updatedAt: row?.updated_at || null });
});

// DELETE /api/calendar/disconnect
app.delete('/api/calendar/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_calendar_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'calendar.oauth.disconnect');
  res.json({ ok: true });
});

// GET /api/calendar/events?days=7&maxResults=20
app.get('/api/calendar/events', async (req, res) => {
  audit(req.user.email, req.user.name, 'calendar.events');
  try {
    const cal = getCalendarClientForUser(req.user);
    const now = new Date();
    const days = parseInt(req.query.days || '7');
    const maxResults = parseInt(req.query.maxResults || '20');
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();
    const r = await cal.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json(r.data.items || []);
  } catch(e) {
    serverError(res, e);
  }
});

// ── Google Drive API ──
function getDriveAuthForUser(user) {
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
  return oauth2;
}
function getDriveClientForUser(user) {
  return google.drive({ version: 'v3', auth: getDriveAuthForUser(user) });
}
function getSheetsClientForUser(user) {
  return google.sheets({ version: 'v4', auth: getDriveAuthForUser(user) });
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

// GET /api/drive/status
app.get('/api/drive/status', (req, res) => {
  const row = db.prepare('SELECT updated_at FROM user_drive_tokens WHERE email=? AND refresh_token IS NOT NULL').get(req.user.email);
  res.json({ connected: !!row, updatedAt: row?.updated_at || null });
});

// DELETE /api/drive/disconnect
app.delete('/api/drive/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_drive_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'drive.oauth.disconnect');
  res.json({ ok: true });
});

// GET /api/drive/list?folderId=xxx
app.get('/api/drive/list', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) return res.status(400).json({ error: '無効なフォルダIDです' });
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
    serverError(res, e);
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
    serverError(res, e);
  }
});

// ── Gmail API ──
function getGmailClientForUser(user) {
  // メインログイントークン（user_drive_tokens）が gmail.send/readonly を持つため優先。
  // 旧 user_gmail_tokens は gmail.readonly のみで送信不可なのでフォールバック扱い。
  let tokenRow = db.prepare('SELECT access_token, refresh_token FROM user_drive_tokens WHERE email=?').get(user.email);
  let tableName = 'user_drive_tokens';
  if (!tokenRow?.refresh_token) {
    tokenRow = db.prepare('SELECT access_token, refresh_token FROM user_gmail_tokens WHERE email=?').get(user.email);
    tableName = 'user_gmail_tokens';
  }
  if (!tokenRow?.refresh_token) {
    throw new Error('Gmail未連携。一度ログアウトして再ログインし、Gmail権限を許可してください');
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ access_token: tokenRow.access_token, refresh_token: tokenRow.refresh_token });
  oauth2.on('tokens', tokens => {
    if (tokens.access_token) {
      db.prepare(`UPDATE ${tableName} SET access_token=?, updated_at=datetime('now','localtime') WHERE email=?`)
        .run(tokens.access_token, user.email);
    }
  });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function extractGmailBody(payload) {
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      const body = extractGmailBody(part);
      if (body) return body;
    }
  }
  return '';
}

// GET /api/gmail/status
app.get('/api/gmail/status', (req, res) => {
  const row = db.prepare('SELECT refresh_token, updated_at FROM user_gmail_tokens WHERE email=?').get(req.user.email);
  res.json({ connected: !!(row?.refresh_token), updatedAt: row?.updated_at || null });
});

// DELETE /api/gmail/disconnect
app.delete('/api/gmail/disconnect', (req, res) => {
  db.prepare('DELETE FROM user_gmail_tokens WHERE email=?').run(req.user.email);
  audit(req.user.email, req.user.name, 'gmail.oauth.disconnect');
  res.json({ ok: true });
});

// GET /api/gmail/messages?maxResults=20&q=
app.get('/api/gmail/messages', async (req, res) => {
  audit(req.user.email, req.user.name, 'gmail.messages');
  try {
    const gmail = getGmailClientForUser(req.user);
    const maxResults = parseInt(req.query.maxResults || '20');
    const q = req.query.q || '';
    const listRes = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults, q });
    const msgs = listRes.data.messages || [];
    const details = await Promise.all(msgs.map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] })
    ));
    res.json(details.map(d => {
      const headers = Object.fromEntries((d.data.payload?.headers || []).map(h => [h.name, h.value]));
      return { id: d.data.id, subject: headers['Subject'] || '', from: headers['From'] || '', date: headers['Date'] || '', snippet: d.data.snippet || '' };
    }));
  } catch(e) {
    serverError(res, e);
  }
});

// GET /api/gmail/messages/:id
app.get('/api/gmail/messages/:id', async (req, res) => {
  audit(req.user.email, req.user.name, 'gmail.message.read', { id: req.params.id });
  try {
    const gmail = getGmailClientForUser(req.user);
    const msg = await gmail.users.messages.get({ userId: 'me', id: req.params.id, format: 'full' });
    const headers = Object.fromEntries((msg.data.payload?.headers || []).map(h => [h.name, h.value]));
    const body = extractGmailBody(msg.data.payload || {});
    res.json({
      id: msg.data.id,
      subject: headers['Subject'] || '',
      from: headers['From'] || '',
      to: headers['To'] || '',
      date: headers['Date'] || '',
      body: body.slice(0, 20000)
    });
  } catch(e) {
    serverError(res, e);
  }
});

// ── Scheduled Tasks API (SQLite) ──

function toUtcStr(d) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
}

function calcNextRunAt(task) {
  const JST = 9 * 3600 * 1000;
  if ((task.schedule_type === 'daily' || task.schedule_type === 'weekly') && task.schedule_hour != null) {
    const nowMs = Date.now();
    const nowJst = new Date(nowMs + JST);
    const target = new Date(nowMs + JST);
    target.setUTCHours(task.schedule_hour, task.schedule_minute || 0, 0, 0);
    if (task.schedule_type === 'weekly' && task.schedule_weekday != null) {
      const diff = (task.schedule_weekday - nowJst.getUTCDay() + 7) % 7;
      target.setUTCDate(target.getUTCDate() + diff);
    }
    if (target <= nowJst) {
      target.setUTCDate(target.getUTCDate() + (task.schedule_type === 'weekly' ? 7 : 1));
    }
    return toUtcStr(target.getTime() - JST);
  }
  return toUtcStr(Date.now() + (task.interval_min || 60) * 60000);
}

// GET /api/scheduled-tasks
app.get('/api/scheduled-tasks', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT st.*,
        (SELECT al.name FROM audit_logs al WHERE al.email = st.owner_email AND al.name != '' ORDER BY al.ts DESC LIMIT 1) as owner_name
      FROM scheduled_tasks st
      WHERE st.owner_email=?
        OR (st.shared=1 AND st.shared_with IS NULL)
        OR (st.shared=1 AND st.shared_with IS NOT NULL
            AND EXISTS (SELECT 1 FROM json_each(st.shared_with) WHERE value=?))
      ORDER BY st.created_at DESC
    `).all(req.user.email, req.user.email);
    res.json(rows);
  } catch(e) { serverError(res, e); }
});

// POST /api/scheduled-tasks
app.post('/api/scheduled-tasks', (req, res) => {
  const { skill_id, task_type = 'recurring', interval_min = 60, run_at, schedule_type = 'interval', schedule_hour, schedule_minute = 0, schedule_weekday, model = 'sonnet', loop_enabled = 0, loop_remaining, loop_interval_min = 60 } = req.body;

  let taskData = {};
  if (skill_id) {
    const skill = db.prepare(`SELECT * FROM user_skills WHERE id=? AND (owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?))))`).get(skill_id, req.user.email, req.user.email);
    if (!skill) return res.status(404).json({ error: 'スキルが見つかりません' });
    taskData = { skill_id: skill.id, skill_name: skill.name, skill_title: skill.title, description: skill.description || '', steps: skill.steps || '' };
  } else {
    return res.status(400).json({ error: 'skill_id は必須' });
  }

  let nextRunAt;
  if (task_type === 'once') {
    if (!run_at) return res.status(400).json({ error: '単発タスクには run_at が必要です' });
    nextRunAt = toUtcStr(run_at);
  } else {
    nextRunAt = calcNextRunAt({ schedule_type, schedule_hour, schedule_minute, schedule_weekday, interval_min });
  }

  audit(req.user.email, req.user.name, 'scheduled_task.create', { skill_id, task_type, interval_min, schedule_type, model });
  try {
    const result = db.prepare(
      `INSERT INTO scheduled_tasks
         (owner_email, task_type, skill_id, skill_name, skill_title, description, steps, interval_min, run_at, enabled, next_run_at, schedule_type, schedule_hour, schedule_minute, schedule_weekday, model, loop_enabled, loop_remaining, loop_interval_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.user.email, task_type, taskData.skill_id, taskData.skill_name, taskData.skill_title, taskData.description, taskData.steps, Number(interval_min), run_at || null, nextRunAt, schedule_type, schedule_hour ?? null, Number(schedule_minute), schedule_weekday ?? null, model, loop_enabled ? 1 : 0, loop_remaining ?? null, Number(loop_interval_min));
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(e) { serverError(res, e); }
});

// PUT /api/scheduled-tasks/:id
app.put('/api/scheduled-tasks/:id', (req, res) => {
  const { interval_min, enabled, skill_title, description, steps, schedule_type, schedule_hour, schedule_minute, schedule_weekday, model, shared } = req.body;
  try {
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
    if (!row) return res.status(403).json({ error: '権限がありません' });

    // 共有設定のみの更新（shared / shared_with）
    if ((shared !== undefined || shared_with !== undefined) && interval_min === undefined && enabled === undefined && skill_title === undefined && description === undefined && steps === undefined && model === undefined) {
      const newShared = shared !== undefined ? (shared ? 1 : 0) : row.shared;
      const newSharedWith = newShared === 0 ? null
        : (shared_with === null ? null : (Array.isArray(shared_with) ? JSON.stringify(shared_with) : row.shared_with));
      db.prepare('UPDATE scheduled_tasks SET shared=?, shared_with=? WHERE id=?').run(newShared, newSharedWith, req.params.id);
      const action = newShared === 0 ? 'scheduled_task.unshare' : (newSharedWith ? 'scheduled_task.share_team' : 'scheduled_task.share_all');
      audit(req.user.email, req.user.name, action, { id: req.params.id, name: row.skill_title });
      return res.json({ ok: true });
    }

    const updates = [];
    const params = [];
    if (interval_min !== undefined) { updates.push('interval_min=?'); params.push(Number(interval_min)); }
    if (enabled !== undefined) { updates.push('enabled=?'); params.push(enabled ? 1 : 0); }
    if (skill_title !== undefined) { updates.push('skill_title=?'); params.push(skill_title); }
    if (description !== undefined) { updates.push('description=?'); params.push(description); }
    if (steps !== undefined) { updates.push('steps=?'); params.push(steps); }
    if (schedule_type !== undefined) { updates.push('schedule_type=?'); params.push(schedule_type); }
    if (schedule_hour !== undefined) { updates.push('schedule_hour=?'); params.push(schedule_hour); }
    if (schedule_minute !== undefined) { updates.push('schedule_minute=?'); params.push(schedule_minute); }
    if (schedule_weekday !== undefined) { updates.push('schedule_weekday=?'); params.push(schedule_weekday); }
    if (model !== undefined) { updates.push('model=?'); params.push(model); }
    const schedChanged = schedule_type !== undefined || schedule_hour !== undefined || schedule_minute !== undefined || schedule_weekday !== undefined || interval_min !== undefined;
    if (schedChanged && row.task_type === 'recurring') {
      const merged = {
        schedule_type: schedule_type ?? row.schedule_type ?? 'interval',
        schedule_hour: schedule_hour ?? row.schedule_hour,
        schedule_minute: schedule_minute ?? row.schedule_minute ?? 0,
        schedule_weekday: schedule_weekday ?? row.schedule_weekday,
        interval_min: interval_min ?? row.interval_min ?? 60
      };
      updates.push('next_run_at=?');
      params.push(calcNextRunAt(merged));
    }
    if (!updates.length) return res.status(400).json({ error: '更新項目がありません' });

    params.push(req.params.id, req.user.email);
    db.prepare(`UPDATE scheduled_tasks SET ${updates.join(',')} WHERE id=? AND owner_email=?`).run(...params);
    audit(req.user.email, req.user.name, 'scheduled_task.update', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { serverError(res, e); }
});

// POST /api/scheduled-tasks/:id/run — 即時実行（自分のタスク or 共有タスク）
app.post('/api/scheduled-tasks/:id/run', (req, res) => {
  try {
    const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id=? AND (owner_email=? OR (shared=1 AND (shared_with IS NULL OR EXISTS (SELECT 1 FROM json_each(shared_with) WHERE value=?))))`).get(req.params.id, req.user.email, req.user.email);
    if (!task) return res.status(403).json({ error: '権限がありません' });
    const isOwn = task.owner_email === req.user.email;
    const now = toUtcStr(Date.now());
    // 自分のタスクのみ last_run_at / last_status を更新（共有タスクの状態は変えない）
    if (isOwn) {
      db.prepare("UPDATE scheduled_tasks SET last_run_at=?, last_status='running' WHERE id=?").run(now, task.id);
    }
    runSkillBackground(task, req.user.email).then(result => {
      if (isOwn) {
        db.prepare("UPDATE scheduled_tasks SET last_status=?, last_result=? WHERE id=?")
          .run(result.ok ? 'done' : 'error', result.error || null, task.id);
      }
    }).catch(() => {});
    audit(req.user.email, req.user.name, 'scheduled_task.run_now', { id: task.id, skill_name: task.skill_name });
    res.json({ ok: true, message: '実行を開始しました' });
  } catch(e) { serverError(res, e); }
});

// DELETE /api/scheduled-tasks/:id
app.delete('/api/scheduled-tasks/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT id FROM scheduled_tasks WHERE id=? AND owner_email=?').get(req.params.id, req.user.email);
    if (!row) return res.status(403).json({ error: '権限がありません' });
    db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(req.params.id);
    audit(req.user.email, req.user.name, 'scheduled_task.delete', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { serverError(res, e); }
});

// ── モデル推薦 ──
const MODELS_FOR_RECOMMENDATION = [
  { key: 'sonnet',    name: 'Claude Sonnet 4.6 (Anthropic)', strengths: '高品質・ツール連携安定・複雑な判断',   cost_label: '約3〜4円/回', input_per_1m: 3.0,  output_per_1m: 15.0 },
  { key: 'haiku',     name: 'Claude Haiku 4.5 (Anthropic)',  strengths: '高速・低コスト・シンプルな定型作業',   cost_label: '約1円/回',   input_per_1m: 0.8,  output_per_1m: 4.0  },
  { key: 'openrouter:deepseek/deepseek-chat',              name: 'DeepSeek V3 (OpenRouter)',      strengths: 'コーディング・データ分析・超低コスト',     cost_label: '約0.1円/回', input_per_1m: 0.14, output_per_1m: 0.28 },
  { key: 'openrouter:deepseek/deepseek-r1',                name: 'DeepSeek R1 推論 (OpenRouter)', strengths: '推論・論理・数学・複雑な問題解決（やや遅め）', cost_label: '約0.6円/回', input_per_1m: 0.55, output_per_1m: 2.19 },
  { key: 'deepinfra:deepseek-ai/DeepSeek-V3',             name: 'DeepSeek V3 (DeepInfra)',       strengths: 'コーディング・分析（DeepInfra・低コスト）', cost_label: '約0.3円/回', input_per_1m: 0.35, output_per_1m: 0.89 },
  { key: 'deepinfra:deepseek-ai/DeepSeek-R1',             name: 'DeepSeek R1 推論 (DeepInfra)', strengths: '推論・論理・数学（DeepInfra経由）',          cost_label: '約0.6円/回', input_per_1m: 0.55, output_per_1m: 2.19 },
  { key: 'openrouter:qwen/qwen3-235b-a22b',               name: 'Qwen3 235B (OpenRouter)',       strengths: '日本語強・多言語・バランス良・低コスト',   cost_label: '約0.2円/回', input_per_1m: 0.22, output_per_1m: 0.88 },
  { key: 'openrouter:qwen/qwen3-30b-a3b',                 name: 'Qwen3 30B (OpenRouter)',        strengths: '超軽量・超低コスト・日本語対応・高頻度向け', cost_label: '約0.03円/回', input_per_1m: 0.03, output_per_1m: 0.09 },
  { key: 'deepinfra:Qwen/Qwen3-235B-A22B',                name: 'Qwen3 235B (DeepInfra)',        strengths: '日本語・多言語（DeepInfra経由）',           cost_label: '約0.2円/回', input_per_1m: 0.22, output_per_1m: 0.88 },
  { key: 'openrouter:meta-llama/llama-4-maverick',        name: 'Llama 4 Maverick (OpenRouter)', strengths: '最新Llama・汎用・マルチモーダル・英語強',   cost_label: '約0.2円/回', input_per_1m: 0.19, output_per_1m: 0.85 },
  { key: 'openrouter:meta-llama/llama-4-scout',           name: 'Llama 4 Scout (OpenRouter)',    strengths: '軽量Llama4・高速・低コスト・シンプルタスク', cost_label: '約0.2円/回', input_per_1m: 0.18, output_per_1m: 0.59 },
  { key: 'deepinfra:meta-llama/Llama-3.3-70B-Instruct',  name: 'Llama 3.3 70B (DeepInfra)',    strengths: '前世代大型Llama・汎用・英語強・低コスト',   cost_label: '約0.1円/回', input_per_1m: 0.13, output_per_1m: 0.40 },
  { key: 'openrouter:mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 (OpenRouter)', strengths: '効率的・ツール対応・低コスト',    cost_label: '約0.1円/回', input_per_1m: 0.10, output_per_1m: 0.30 },
];

app.post('/api/recommend-model', async (req, res) => {
  const { title = '', steps = '' } = req.body;
  if (!title && !steps) return res.status(400).json({ error: 'タスク情報が必要です' });
  audit(req.user.email, req.user.name, 'model.recommend', { title: title.slice(0, 30) });
  try {
    const modelList = MODELS_FOR_RECOMMENDATION.map(m =>
      `- key="${m.key}" | ${m.name} | 特徴: ${m.strengths} | コスト: ${m.cost_label}`
    ).join('\n');
    const prompt = `あなたはAIモデル選択アドバイザーです。以下のスケジュールタスクに最適なモデルを推薦してください。

**最重要基準: コスパ（品質÷コスト）**
- 単純なタスク（通知送信・定型チェック）→ 安価なモデルを優先
- 複雑なタスク（DB分析・複数ツール連携・判断が必要）→ 品質重視
- 日本語処理が多い → 日本語強のモデルを優先
- ツールを頻繁に使う → Anthropic優先（ツール安定性）

タスク名: ${title}
実行手順（抜粋）:
${steps.slice(0, 1200)}

利用可能なモデル:
${modelList}

以下のJSON形式のみで回答（説明文・コードブロック不要）:
{"model":"モデルのkey","reason":"推薦理由（40文字以内・日本語）","cost_note":"コスパコメント（30文字以内）"}`;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error('推薦結果のパースに失敗しました');
    const parsed = JSON.parse(m[0]);
    if (!MODELS_FOR_RECOMMENDATION.find(x => x.key === parsed.model)) {
      parsed.model = 'sonnet';
    }
    res.json(parsed);
  } catch(e) {
    console.error('[recommend-model] error:', e.message);
    serverError(res, e);
  }
});

// ── Feedback (改善提案・不具合報告) ──
const FEEDBACK_NOTIFY_TO = process.env.FEEDBACK_NOTIFY_TO || 'marketing@acrovision.co.jp';
const FEEDBACK_LABELS = {
  status: {
    submitted:    { label: '受付', color: '#0a84ff' },
    investigating:{ label: '確認中', color: '#f59f00' },
    in_progress:  { label: '対応中', color: '#1a8917' },
    done:         { label: '完了', color: '#666' },
    rejected:     { label: '却下', color: '#c92a2a' }
  },
  category: {
    bug:         { label: '不具合',   color: '#fa5252' },
    improvement: { label: '改善要望', color: '#1a8917' },
    operation:   { label: '運用要望', color: '#7048e8' },
    question:    { label: '質問',     color: '#0a84ff' }
  },
  priority: {
    urgent: { label: '緊急', color: '#c92a2a' },
    high:   { label: '高',   color: '#fa5252' },
    medium: { label: '中',   color: '#888'    },
    low:    { label: '低',   color: '#aaa'    }
  }
};

function feedbackIsAdmin(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim());
  return adminEmails.includes(email);
}

function feedbackGetOrCreateSession(req) {
  if (!req.session.feedback_sid) {
    req.session.feedback_sid = 'fbk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  return req.session.feedback_sid;
}

function feedbackLogStatus(reportId, before, after, user, note = '') {
  db.prepare(`INSERT INTO feedback_status_log
    (report_id, status_before, status_after, changed_by_email, changed_by_name, note)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(reportId, before, after, user.email || '', user.name || '', note || '');
}

async function feedbackNotifyByEmail(report, reporterEmail, reporterName) {
  if (!process.env.SES_FROM) {
    console.log('[feedback] SES未設定のためメール通知スキップ');
    return false;
  }
  const cat = FEEDBACK_LABELS.category[report.category]?.label || report.category;
  const pri = FEEDBACK_LABELS.priority[report.priority]?.label || report.priority;
  const jst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const baseUrl = process.env.APP_BASE_URL || 'https://d2jjp21sq86i80.cloudfront.net';
  const detailUrl = `${baseUrl}/feedback-detail?id=${report.id}`;
  const text =
`💡 改善提案ボックスに新しい報告が届きました（#${report.id}）

報告者: ${reporterName} <${reporterEmail}>
受付日時: ${jst} (JST)
カテゴリ: ${cat} / 優先度: ${pri}

タイトル:
${report.title}

要約:
${report.summary}

${report.affected_url ? `対象URL: ${report.affected_url}\n` : ''}${report.reproduce_steps ? `再現手順:\n${report.reproduce_steps}\n\n` : ''}${report.expected_behavior ? `期待動作:\n${report.expected_behavior}\n\n` : ''}${report.actual_behavior ? `実際の動作:\n${report.actual_behavior}\n\n` : ''}
詳細・対応: ${detailUrl}
`;
  try {
    await getSesTransport().sendMail({
      from: process.env.SES_FROM || 'info@acrovision.co.jp',
      to: FEEDBACK_NOTIFY_TO,
      replyTo: reporterEmail,
      subject: `💡 [改善提案 #${report.id}] ${cat} - ${report.title}`,
      text
    });
    return true;
  } catch(e) {
    console.error('[feedback] メール通知失敗:', e.message);
    return false;
  }
}

const FEEDBACK_HEARING_PROMPT = `あなたは社内の改善提案・不具合報告を整理するヒアリング担当AIです。ユーザーは社員で、業務システムやAIエージェントの不具合・改善要望・運用相談を持ってきます。

# あなたの役割
1. ユーザーの困りごとを丁寧に聞き取り、共感的な口調で整理する
2. 必要な情報（再現手順・期待動作・実際の動作・対象URL）を1〜2項目ずつ自然な会話で引き出す
3. 情報が十分集まったら、最後に以下の構造化JSONを **<<FINALIZE>>** と **<<END>>** で囲んで出力する

# FINALIZEを出すタイミング
- ユーザーが「これで報告して」「もう十分」「以上です」等と言ったとき
- または3〜4ターン程度の対話で要点（何が・どこで・どうなる）が揃ったとき
- ユーザーが質問だけで終わる場合は無理に出さなくてよい

# FINALIZE出力フォーマット（最終ターンのみ、画面では除去される）
<<FINALIZE>>
{
  "title": "30文字以内の簡潔なタイトル",
  "summary": "報告の要約（200〜400文字）",
  "category": "bug | improvement | operation | question のいずれか",
  "priority": "urgent | high | medium | low のいずれか",
  "reproduce_steps": "再現手順（不明なら空文字）",
  "expected_behavior": "期待される動作（不明なら空文字）",
  "actual_behavior": "実際の動作（不明なら空文字）",
  "affected_url": "対象URL（あれば、なければ空文字）"
}
<<END>>

# 注意
- FINALIZE は本文の最後に必ずマーカー付きで出力する。前後に説明を付けてOK
- カテゴリ判定: 動かない/エラー=bug、新機能/改善=improvement、運用ルール/権限=operation、わからない=question
- 優先度: 業務停止級=urgent、業務に支障=high、不便=medium、要望=low
- 共感的に、しかし冗長にならず、1メッセージ2〜4行程度`;

// POST /api/feedback/chat (SSE)
app.post('/api/feedback/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '空メッセージ' });
  const user = req.user;
  const sessionId = feedbackGetOrCreateSession(req);

  audit(user.email, user.name, 'feedback.chat', { preview: message.slice(0, 100), sessionId });

  // ユーザーメッセージ保存
  db.prepare('INSERT INTO feedback_messages (session_id, email, role, content) VALUES (?,?,?,?)')
    .run(sessionId, user.email, 'user', message);

  // 履歴取得（user/assistantのみ、直近20件）
  const history = db.prepare(
    `SELECT role, content FROM feedback_messages
     WHERE session_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 20`
  ).all(sessionId).reverse();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let fullText = '';
  try {
    const messages = history.map(m => ({ role: m.role, content: m.content }));
    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: FEEDBACK_HEARING_PROMPT,
      messages
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        fullText += ev.delta.text;
        // FINALIZE マーカー中はクライアントに出さない（マーカー含まないなら都度送る）
        // 簡易: クライアント側で除去するため、全テキスト都度送出
        res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
      }
    }
    await stream.finalMessage();

    // FINALIZE 検出
    let finalizeJson = null;
    const m = fullText.match(/<<FINALIZE>>\s*(\{[\s\S]*?\})\s*<<END>>/);
    if (m) {
      try { finalizeJson = JSON.parse(m[1]); } catch(e) {}
    }
    const displayText = m
      ? fullText.replace(/<<FINALIZE>>[\s\S]*?<<END>>/, '').trim()
      : fullText;

    // assistant 保存（表示用テキスト）
    if (displayText) {
      db.prepare('INSERT INTO feedback_messages (session_id, email, role, content) VALUES (?,?,?,?)')
        .run(sessionId, user.email, 'assistant', displayText);
    }
    // FINALIZE は system ロールで保存
    if (finalizeJson) {
      db.prepare('INSERT INTO feedback_messages (session_id, email, role, content) VALUES (?,?,?,?)')
        .run(sessionId, user.email, 'system', JSON.stringify(finalizeJson));
      res.write(`data: ${JSON.stringify({ finalize: true })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch(e) {
    console.error('[feedback.chat] error:', e.message);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// GET /api/feedback/session — 現在のセッションID / 履歴 / finalize有無
app.get('/api/feedback/session', (req, res) => {
  const sessionId = feedbackGetOrCreateSession(req);
  const messages = db.prepare(
    `SELECT role, content, created_at FROM feedback_messages
     WHERE session_id=? AND role IN ('user','assistant') ORDER BY id ASC LIMIT 100`
  ).all(sessionId);
  // 既にreport化されているか
  const exists = db.prepare('SELECT id FROM feedback_reports WHERE session_id=?').get(sessionId);
  // 最新FINALIZE
  const lastFinal = db.prepare(
    `SELECT content FROM feedback_messages WHERE session_id=? AND role='system' ORDER BY id DESC LIMIT 1`
  ).get(sessionId);
  res.json({
    sessionId,
    messages,
    canFinalize: !!lastFinal && !exists,
    reportId: exists?.id || null,
    hasMessages: messages.length > 0
  });
});

// POST /api/feedback/reset — 新規報告のためセッションをローテート
app.post('/api/feedback/reset', (req, res) => {
  delete req.session.feedback_sid;
  res.json({ ok: true });
});

// POST /api/feedback/finalize — チャット内容を確定して報告化
app.post('/api/feedback/finalize', async (req, res) => {
  const user = req.user;
  const sessionId = feedbackGetOrCreateSession(req);

  // 既存チェック
  const existing = db.prepare('SELECT id FROM feedback_reports WHERE session_id=?').get(sessionId);
  if (existing) return res.json({ ok: true, id: existing.id, alreadyExists: true });

  // 最新FINALIZE取得。なければ簡易ヒアリング(=最後のユーザー発言から)で生成
  let draft = null;
  const last = db.prepare(
    `SELECT content FROM feedback_messages WHERE session_id=? AND role='system' ORDER BY id DESC LIMIT 1`
  ).get(sessionId);
  if (last) {
    try { draft = JSON.parse(last.content); } catch(e) {}
  }

  // FINALIZEがない場合は user/assistant 履歴からHaikuでワンショット生成
  if (!draft) {
    const msgs = db.prepare(
      `SELECT role, content FROM feedback_messages
       WHERE session_id=? AND role IN ('user','assistant') ORDER BY id ASC LIMIT 30`
    ).all(sessionId);
    if (msgs.length === 0) return res.status(400).json({ error: 'まだ報告内容がありません' });
    const transcript = msgs.map(m => (m.role === 'user' ? '【ユーザー】' : '【AI】') + ' ' + m.content).join('\n');
    try {
      const r = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `以下の社員と整理AIの対話から、改善提案/不具合報告のJSONを生成してください。
必ず以下のキーを持つJSONのみを返してください（マークダウンや説明文は不要）：
{"title": "...", "summary": "...", "category": "bug|improvement|operation|question", "priority": "urgent|high|medium|low", "reproduce_steps": "", "expected_behavior": "", "actual_behavior": "", "affected_url": ""}

対話:
${transcript}`
        }]
      });
      const text = r.content[0]?.text || '';
      const jm = text.match(/\{[\s\S]*\}/);
      if (jm) draft = JSON.parse(jm[0]);
    } catch(e) {
      console.error('[feedback.finalize] auto draft error:', e.message);
    }
    if (!draft) return res.status(400).json({ error: '報告内容の整理に失敗しました。もう少し詳しく入力してください' });
  }

  const title = String(draft.title || '').trim();
  const summary = String(draft.summary || '').trim();
  if (!title || !summary) return res.status(400).json({ error: 'タイトルまたは要約が空です' });

  let category = String(draft.category || 'bug');
  if (!['bug','improvement','operation','question'].includes(category)) category = 'bug';
  let priority = String(draft.priority || 'medium');
  if (!['urgent','high','medium','low'].includes(priority)) priority = 'medium';

  const info = db.prepare(`INSERT INTO feedback_reports
    (session_id, reporter_email, reporter_name, title, summary,
     reproduce_steps, expected_behavior, actual_behavior, affected_url,
     category, priority, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sessionId, user.email, user.name || '',
      title.slice(0, 200), summary,
      String(draft.reproduce_steps || ''),
      String(draft.expected_behavior || ''),
      String(draft.actual_behavior || ''),
      String(draft.affected_url || '').slice(0, 500),
      category, priority, 'submitted'
    );
  const reportId = info.lastInsertRowid;
  feedbackLogStatus(reportId, null, 'submitted', user, '報告受付');

  audit(user.email, user.name, 'feedback.submit', { id: reportId, title: title.slice(0, 80), category, priority });

  // 報告本体取得
  const report = db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(reportId);
  // 通知（非同期）
  feedbackNotifyByEmail(report, user.email, user.name || '').then(ok => {
    if (ok) audit(user.email, user.name, 'feedback.notify.sent', { id: reportId, to: FEEDBACK_NOTIFY_TO });
  }).catch(() => {});

  // 次回の報告は新セッション
  delete req.session.feedback_sid;

  res.json({ ok: true, id: reportId });
});

// GET /api/feedback — 自分の報告一覧 (admin は全件)
app.get('/api/feedback', (req, res) => {
  const isAdmin = feedbackIsAdmin(req.user.email);
  const status = req.query.status || '';
  const all = req.query.all === '1' && isAdmin;
  const params = [];
  let sql = 'SELECT id, reporter_email, reporter_name, title, category, priority, status, created_at FROM feedback_reports WHERE 1=1';
  if (!all) { sql += ' AND reporter_email=?'; params.push(req.user.email); }
  if (status && FEEDBACK_LABELS.status[status]) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY id DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json({ items: rows, isAdmin });
});

// GET /api/feedback/:id — 詳細
app.get('/api/feedback/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const r = db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '見つかりません' });
  const isAdmin = feedbackIsAdmin(req.user.email);
  if (!isAdmin && r.reporter_email !== req.user.email) {
    return res.status(403).json({ error: '閲覧権限がありません' });
  }
  const logs = db.prepare('SELECT * FROM feedback_status_log WHERE report_id=? ORDER BY id ASC').all(id);
  const chat = db.prepare(
    `SELECT role, content, created_at FROM feedback_messages
     WHERE session_id=? AND role IN ('user','assistant') ORDER BY id ASC`
  ).all(r.session_id);
  res.json({ report: r, logs, chat, isAdmin });
});

// PUT /api/feedback/:id — admin: ステータス更新
app.put('/api/feedback/:id', (req, res) => {
  if (!feedbackIsAdmin(req.user.email)) return res.status(403).json({ error: '管理者専用' });
  const id = parseInt(req.params.id);
  const r = db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '見つかりません' });
  const { status, priority, category, admin_note } = req.body;
  const changes = [];
  const params = [];
  if (status && FEEDBACK_LABELS.status[status] && status !== r.status) {
    changes.push('status=?'); params.push(status);
    feedbackLogStatus(id, r.status, status, req.user, admin_note || '');
  }
  if (priority && FEEDBACK_LABELS.priority[priority]) { changes.push('priority=?'); params.push(priority); }
  if (category && FEEDBACK_LABELS.category[category]) { changes.push('category=?'); params.push(category); }
  if (typeof admin_note === 'string') { changes.push('admin_note=?'); params.push(admin_note); }
  if (changes.length === 0) return res.json({ ok: true });
  changes.push("updated_at=datetime('now','localtime')");
  params.push(id);
  db.prepare(`UPDATE feedback_reports SET ${changes.join(', ')} WHERE id=?`).run(...params);
  audit(req.user.email, req.user.name, 'feedback.update', { id, status, priority, category });
  res.json({ ok: true });
});

// GET /api/feedback/labels — UIで使うラベル定義
app.get('/api/feedback-labels', (req, res) => {
  res.json(FEEDBACK_LABELS);
});

// ── Task Validator ──
async function validateTaskSteps(steps, skillTitle) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `以下のタスク定義が安全に実行できるか確認してください。

タイトル: ${skillTitle || '(未設定)'}
実行手順:
${steps}

【NG判定は最小限に】次の場合のみ {"ok":false,"issue":"..."} を返してください：
- 存在しないツール名を使おうとしている
- 無限ループになる可能性がある手順
- 完全に意味不明で実行不能な内容

【必ずOKにするもの】：
- Chatworkへのメッセージ送信（送信先・内容の有無を問わず）
- 情報取得・検索・集計タスク
- 手順が多少あいまいでも意図が読み取れるもの
- テスト・確認目的のタスク

必ずこのJSON形式のみで返答：
{"ok":true} または {"ok":false,"issue":"問題点を1文で（日本語）"}`
      }]
    });
    const text = resp.content[0]?.text?.trim() || '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { ok: true };
  } catch(e) {
    return { ok: true };
  }
}

// ── モデルキー解決 ──
// "sonnet" / "haiku" → Anthropic
// "openrouter:model-id" / "deepinfra:model-id" → OSS (OpenAI互換)
const CLAUDE_MODEL_MAP = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001'
};

function resolveModel(modelKey) {
  if (!modelKey || CLAUDE_MODEL_MAP[modelKey]) {
    return { provider: 'anthropic', modelId: CLAUDE_MODEL_MAP[modelKey] || CLAUDE_MODEL_MAP.sonnet };
  }
  const colonIdx = modelKey.indexOf(':');
  if (colonIdx === -1) return { provider: 'anthropic', modelId: CLAUDE_MODEL_MAP.sonnet };
  return { provider: modelKey.slice(0, colonIdx), modelId: modelKey.slice(colonIdx + 1) };
}

// ── Anthropic API フォールバック ──

function isOverloadError(e) {
  const msg = String(e?.message || '');
  const status = e?.status || e?.statusCode;
  return status === 529 || status === 503 || status === 429 ||
    msg.includes('overloaded') || msg.includes('529') || msg.includes('503') || msg.includes('rate limit');
}

// 指数バックオフでリトライ（fn は async）
async function retryWithBackoff(fn, { maxRetries = 2, delays = [2000, 5000] } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch(e) {
      if (attempt < maxRetries && isOverloadError(e)) {
        await new Promise(r => setTimeout(r, delays[attempt] || 5000));
        continue;
      }
      throw e;
    }
  }
}

// OSS AI（OpenRouter Qwen3-235B）でタスクを実行（ツールあり）
async function runWithOss(prompt, systemPrompt, activeTools, user) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY が未設定のため OSS フォールバック不可');
  const baseUrl = 'https://openrouter.ai/api/v1';
  const fallbackModel = 'qwen/qwen3-235b-a22b';

  const openaiTools = toOpenAITools(activeTools);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];
  let resultBuffer = '';
  let toolRound = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (toolRound < 10) {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://acrovision.co.jp'
      },
      body: JSON.stringify({ model: fallbackModel, messages, tools: openaiTools, tool_choice: 'auto', max_tokens: 4096 })
    });
    if (!r.ok) throw new Error(`OSS fallback error: ${r.status} ${await r.text()}`);
    const data = await r.json();
    totalInputTokens  += data.usage?.prompt_tokens     || 0;
    totalOutputTokens += data.usage?.completion_tokens || 0;
    const choice = data.choices?.[0];
    if (!choice) break;
    if (choice.message?.content) resultBuffer += choice.message.content;
    if (!choice.message?.tool_calls?.length) break;
    messages.push({ role: 'assistant', content: choice.message.content || null, tool_calls: choice.message.tool_calls });
    for (const tc of choice.message.tool_calls) {
      let toolResultContent;
      try {
        const input = JSON.parse(tc.function.arguments);
        const result = await executeTool(tc.function.name, input, user);
        toolResultContent = JSON.stringify(result).slice(0, 80000);
      } catch(e) { toolResultContent = JSON.stringify({ error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent });
    }
    toolRound++;
  }
  return { resultBuffer, totalInputTokens, totalOutputTokens };
}

// Anthropicツール定義をOpenAI形式に変換
function toOpenAITools(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

// ── Background Skill Runner ──
async function runSkillBackground(task, ownerEmail) {
  const role = getUserRole(ownerEmail);
  const user = { email: ownerEmail, role };
  const prompt = `# ${task.skill_title || task.title}\n\n${task.description || ''}\n\n## 実行手順\n\n${task.steps || ''}`;

  const runRow = db.prepare('INSERT INTO task_runs (user_email, skill_name, skill_title, status) VALUES (?,?,?,?)')
    .run(ownerEmail, task.skill_name || task.name, task.skill_title || task.title, 'running');
  const runId = runRow.lastInsertRowid;

  const bgSystemPrompt = getSystemPromptForUser(role, ownerEmail) + `

## 【バックグラウンド自動実行モード】
スケジューラーがこのタスクを自動実行しています。以下のルールを厳守してください：
- タスクの手順を「今すぐ」実行してください。スケジュール登録は不要です
- register_task は使わない（スケジューリングはすでに完了しています）
- Chatworkへの送信は send_system_notification を使用し、ユーザー確認なしで即送信
- send_chatwork_message は使わない
- 実行が完了したら結果のみ返してください`;

  let resultBuffer = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let usedFallback = false;
  let actualModel = task.model || 'sonnet';
  try {
    const allowedToolNames = TOOLS_FOR_ROLE[role];
    const activeTools = (allowedToolNames ? TOOLS.filter(t => allowedToolNames.has(t.name)) : TOOLS)
      .filter(t => t.name !== 'register_task');

    const { provider, modelId } = resolveModel(task.model);

    if (provider === 'anthropic') {
      // ── Anthropic (Claude) — リトライ付き、失敗時は OSS フォールバック ──
      const anthropicRun = async () => {
        const messages = [{ role: 'user', content: prompt }];
        let toolRound = 0;
        let inTokens = 0;
        let outTokens = 0;
        let buf = '';

        // Prompt Caching for background tasks
        const cachedBgTools = activeTools.length > 0 ? [
          ...activeTools.slice(0, -1),
          { ...activeTools[activeTools.length - 1], cache_control: { type: 'ephemeral' } }
        ] : activeTools;
        while (toolRound < 10) {
          const response = await anthropic.messages.create({
            model: modelId,
            max_tokens: 4096,
            system: [{ type: 'text', text: bgSystemPrompt, cache_control: { type: 'ephemeral' } }],
            tools: cachedBgTools,
            messages
          });
          inTokens  += response.usage?.input_tokens  || 0;
          outTokens += response.usage?.output_tokens || 0;
          for (const block of response.content) {
            if (block.type === 'text') buf += block.text;
          }
          if (response.stop_reason !== 'tool_use') break;
          messages.push({ role: 'assistant', content: response.content });
          const toolResults = [];
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            try {
              const result = await executeTool(block.name, block.input, user);
              let toolContent;
              if (result?.image?.base64) {
                const meta = { ...result, image: undefined, image_attached: true };
                toolContent = [
                  { type: 'image', source: { type: 'base64', media_type: result.image.mediaType, data: result.image.base64 } },
                  { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
                ];
              } else if (result?.pdf?.base64) {
                const meta = { ...result, pdf: undefined, pdf_attached: true };
                toolContent = [
                  { type: 'document', source: { type: 'base64', media_type: result.pdf.mediaType, data: result.pdf.base64 } },
                  { type: 'text', text: JSON.stringify(meta).slice(0, 5000) }
                ];
              } else {
                toolContent = JSON.stringify(result).slice(0, 80000);
              }
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
            } catch(e) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
            }
          }
          messages.push({ role: 'user', content: toolResults });
          toolRound++;
        }
        return { buf, inTokens, outTokens };
      };

      try {
        const res = await retryWithBackoff(anthropicRun);
        resultBuffer      = res.buf;
        totalInputTokens  = res.inTokens;
        totalOutputTokens = res.outTokens;
      } catch(anthropicErr) {
        if (isOverloadError(anthropicErr) && process.env.OPENROUTER_API_KEY) {
          console.warn(`[fallback] Claude API overloaded (${task.skill_name}), switching to OSS`);
          const fb = await runWithOss(prompt, bgSystemPrompt, activeTools, user);
          resultBuffer      = `[OSS フォールバック: Qwen3-235B]\n${fb.resultBuffer}`;
          totalInputTokens  = fb.totalInputTokens;
          totalOutputTokens = fb.totalOutputTokens;
          usedFallback = true;
          actualModel  = 'openrouter:qwen/qwen3-235b-a22b';
        } else {
          throw anthropicErr;
        }
      }
    } else {
      // ── OSS (OpenRouter / DeepInfra) — OpenAI互換API ──
      const apiKey = provider === 'deepinfra' ? process.env.DEEPINFRA_API_KEY : process.env.OPENROUTER_API_KEY;
      const baseUrl = provider === 'deepinfra' ? 'https://api.deepinfra.com/v1/openai' : 'https://openrouter.ai/api/v1';
      if (!apiKey) throw new Error(`${provider} APIキーが未設定です`);

      const openaiTools = toOpenAITools(activeTools);
      const messages = [
        { role: 'system', content: bgSystemPrompt },
        { role: 'user', content: prompt }
      ];
      let toolRound = 0;

      while (toolRound < 10) {
        const r = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://acrovision.co.jp' } : {})
          },
          body: JSON.stringify({ model: modelId, messages, tools: openaiTools, tool_choice: 'auto', max_tokens: 4096 })
        });
        if (!r.ok) throw new Error(`${provider} API error: ${r.status} ${await r.text()}`);
        const data = await r.json();

        totalInputTokens  += data.usage?.prompt_tokens     || 0;
        totalOutputTokens += data.usage?.completion_tokens || 0;

        const choice = data.choices?.[0];
        if (!choice) break;

        if (choice.message?.content) resultBuffer += choice.message.content;
        if (!choice.message?.tool_calls?.length) break;

        messages.push({ role: 'assistant', content: choice.message.content || null, tool_calls: choice.message.tool_calls });

        for (const tc of choice.message.tool_calls) {
          let toolResultContent;
          try {
            const input = JSON.parse(tc.function.arguments);
            const result = await executeTool(tc.function.name, input, user);
            toolResultContent = JSON.stringify(result).slice(0, 80000);
          } catch(e) {
            toolResultContent = JSON.stringify({ error: e.message });
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent });
        }
        toolRound++;
      }
    }

    // コスト計上（実際に使ったモデル＝フォールバック後は OSS 料金）
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      recordUsage(ownerEmail, '', totalInputTokens, totalOutputTokens, actualModel, 'scheduled_task');
    }

    db.prepare(`UPDATE task_runs SET status=?, result=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run('done', resultBuffer.slice(0, 2000), runId);
    audit(ownerEmail, '', 'scheduled_task.ran', { skillName: task.skill_name, runId, model: actualModel });
    // Hooks: post_run
    const skillInfo = { id: task.skill_id, title: task.skill_title || task.skill_name };
    executeHooks('post_run', skillInfo, ownerEmail, resultBuffer).catch(() => {});
    notifyTaskResult(ownerEmail, task.skill_title || task.skill_name, 'done', resultBuffer).catch(() => {});
    if (usedFallback) notifyFallback(ownerEmail, task.skill_title || task.skill_name).catch(() => {});
    return { ok: true, runId, resultBuffer };
  } catch(e) {
    db.prepare(`UPDATE task_runs SET status=?, result=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run('error', e.message.slice(0, 2000), runId);
    notifyTaskResult(ownerEmail, task.skill_title || task.skill_name, 'error', e.message).catch(() => {});
    return { ok: false, error: e.message, runId };
  }
}

async function notifyFallback(ownerEmail, taskName) {
  const sysToken   = process.env.CHATWORK_SYSTEM_TOKEN;
  const notifyRoom = process.env.TASK_NOTIFY_CW_ROOM_ID;
  if (!sysToken || !notifyRoom) return;
  const jst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const msg = `[info][title]⚠️ OSSフォールバック: ${taskName}[/title]担当者: ${ownerEmail}\n実行日時: ${jst} (JST)\n\nClaude API が過負荷のため、Qwen3-235B (OpenRouter) で代替実行しました。\n結果は管理画面でご確認ください。\n\n[管理画面](https://d2jjp21sq86i80.cloudfront.net/manage)[/info]`;
  await fetch(`${CW_BASE}/rooms/${notifyRoom}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': sysToken, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: msg }).toString()
  });
}

async function notifyTaskResult(ownerEmail, taskName, status, result) {
  const jst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const icon = status === 'done' ? '✅' : '❌';
  const statusLabel = status === 'done' ? '成功' : 'エラー';
  const shortResult = (result || '').slice(0, 500);

  // ── Chatwork 通知（エラー時は常に・成功時は TASK_NOTIFY_SUCCESS=1 の場合） ──
  const sysToken  = process.env.CHATWORK_SYSTEM_TOKEN;
  const notifyRoom = process.env.TASK_NOTIFY_CW_ROOM_ID;
  const notifySuccess = process.env.TASK_NOTIFY_SUCCESS === '1';
  if (sysToken && notifyRoom && (status === 'error' || notifySuccess)) {
    const cwMsg = status === 'error'
      ? `[info][title]${icon} AIタスクエラー: ${taskName}[/title]担当者: ${ownerEmail}\n実行日時: ${jst} (JST)\n\n${shortResult}\n\n[管理画面](https://d2jjp21sq86i80.cloudfront.net/manage)[/info]`
      : `[info][title]${icon} AIタスク完了: ${taskName}[/title]担当者: ${ownerEmail} / ${jst}\n${shortResult.slice(0, 200)}[/info]`;
    fetch(`${CW_BASE}/rooms/${notifyRoom}/messages`, {
      method: 'POST',
      headers: { 'X-ChatWorkToken': sysToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: cwMsg }).toString()
    }).catch(e => console.error('[notify] Chatwork送信失敗:', e.message));
  }

  // ── メール通知 ──
  if (!process.env.SES_FROM) return;
  try {
    await getSesTransport().sendMail({
      from: process.env.SES_FROM || 'info@acrovision.co.jp',
      to: ownerEmail,
      subject: `${icon} [AIエージェント] タスク${statusLabel}: ${taskName}`,
      text: `タスク実行結果のお知らせ\n\nタスク名: ${taskName}\nステータス: ${statusLabel}\n実行日時: ${jst} (JST)\n\n--- 結果 ---\n${shortResult}\n\n管理画面: https://d2jjp21sq86i80.cloudfront.net/manage`
    });
  } catch(e) {
    console.error('[notify] メール送信失敗:', e.message);
  }
}

// ── Scheduler (1分ごとにポーリング・SQLite) ──
function runScheduler() {
  try {
    const now = toUtcStr(Date.now());
    const due = db.prepare(
      "SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at <= ?"
    ).all(now);

    for (const task of due) {
      // 先に更新して二重実行を防ぐ
      if (task.task_type === 'once') {
        db.prepare(
          "UPDATE scheduled_tasks SET enabled=0, last_run_at=?, last_status='running' WHERE id=?"
        ).run(now, task.id);
      } else {
        const nextRun = calcNextRunAt(task);
        db.prepare(
          "UPDATE scheduled_tasks SET next_run_at=?, last_run_at=?, last_status='running' WHERE id=?"
        ).run(nextRun, now, task.id);
      }

      runSkillBackground(task, task.owner_email).then(result => {
        db.prepare("UPDATE scheduled_tasks SET last_status=?, last_result=? WHERE id=?")
          .run(result.ok ? 'done' : 'error', result.error || null, task.id);
        // Loop: ループ残回数があれば次回を設定
        if (task.loop_enabled && task.loop_remaining > 0) {
          const nextLoopAt = toUtcStr(Date.now() + (task.loop_interval_min || 60) * 60 * 1000);
          db.prepare("UPDATE scheduled_tasks SET enabled=1, next_run_at=?, loop_remaining=loop_remaining-1, loop_count=loop_count+1 WHERE id=?")
            .run(nextLoopAt, task.id);
          console.log(`[loop] task ${task.id} (${task.skill_name}) → next at ${nextLoopAt}, remaining: ${task.loop_remaining - 1}`);
        }
      }).catch(e => {
        db.prepare("UPDATE scheduled_tasks SET last_status='error', last_result=? WHERE id=?")
          .run(e.message.slice(0, 500), task.id);
      });
    }
  } catch(e) {
    console.error('[scheduler] error:', e.message);
  }
}

setInterval(runScheduler, 60 * 1000);
console.log('[scheduler] started');

app.listen(PORT, '0.0.0.0', () => console.log(`Claude Agent Web: http://0.0.0.0:${PORT}`));
