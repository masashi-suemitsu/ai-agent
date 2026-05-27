# ai-agent プロジェクト

社内向け AI エージェント Web アプリ（acrovision.co.jp 専用）。  
Claude API + Claude Agent SDK を使い、チャットから業務を自動化する。

## 開発ルール（必ず守ること）

### Git 同期ルール
**GitHub を唯一の正解とする。ローカル・サーバーどちらで編集しても必ず GitHub を経由して同期する。**

```
ローカル ←── push/pull ──→ GitHub ←── push/pull ──→ サーバー
```

| タイミング | やること |
|-----------|---------|
| 編集を**始める前** | `git pull` で最新を取得 |
| 編集が**終わったら** | `git commit` + `git push` |
| 別の場所に反映するとき | `git pull` + 必要なら `pm2 restart all` |

### どこで編集しても同じ手順

```bash
# 編集前（必須）
git pull

# 編集・動作確認

# 編集後（必須）
git add <files>
git commit -m "feat/fix/ops: 変更内容"
git push origin main
```

> サーバーで直接編集して動作確認した場合も、サーバー上で `git commit && git push` してからローカルで `git pull` する。SCP での直接転送はこのルールが整うまでの暫定手段。

## 構成

```
home/ec2-user/claude-agent-web/   ← ローカルのパスが EC2 の実パスに対応
├── server.js                      → EC2: ~/claude-agent-web/server.js
├── public/
│   ├── index.html                 → EC2: ~/claude-agent-web/public/index.html
│   ├── manage.html
│   ├── feedback.html / feedback-detail.html / feedback-admin.html
│   ├── about.html / login.html
│   └── assets/
├── audit.db        # SQLite（監査ログ・スキル・タスク・会話履歴）
└── sessions.db     # セッションストア
```

## 本番環境

| 項目 | 値 |
|------|-----|
| EC2 IP | `52.68.18.9` |
| CloudFront | `https://d2jjp21sq86i80.cloudfront.net` |
| SSH エイリアス | `claude-agent`（`~/.ssh/config` に設定済み） |
| SSH キー | `C:/Users/masas/OneDrive/AWS/claude-agent-key.pem` |
| プロセス管理 | PM2（アプリ名: `claude-agent-web`） |

> **注意**: EC2 は git リポジトリではない。ファイルは SCP で転送する。

## リリース手順

### 1. コード修正 → コミット → プッシュ

```bash
git add <files>
git commit -m "feat/fix/ops: 変更内容"
git push origin main
```

### 2. EC2 にファイルを転送（SCP）

変更したファイルに応じて実行：

```bash
# server.js を変更した場合
scp home/ec2-user/claude-agent-web/server.js \
    claude-agent:~/claude-agent-web/server.js

# public/ 以下の HTML/CSS/JS を変更した場合
scp home/ec2-user/claude-agent-web/public/index.html \
    home/ec2-user/claude-agent-web/public/manage.html \
    claude-agent:~/claude-agent-web/public/

# まとめて全部送る場合（node_modules・db 除外）
rsync -av --exclude='node_modules' --exclude='*.db' --exclude='*.log' \
    home/ec2-user/claude-agent-web/ \
    claude-agent:~/claude-agent-web/
```

### 3. PM2 再起動（server.js を変更した場合のみ必須）

```bash
ssh claude-agent "pm2 restart all"
```

HTML/CSS/JS のみの変更は再起動不要（静的ファイルは即反映）。

### 4. 動作確認

```
https://d2jjp21sq86i80.cloudfront.net
https://d2jjp21sq86i80.cloudfront.net/manage
```

### 5. タグを打って記録

```bash
git tag v$(date +%Y.%m.%d)
git push origin --tags
```

### まとめて実行するワンライナー（server.js + HTML 変更時）

```bash
scp home/ec2-user/claude-agent-web/server.js claude-agent:~/claude-agent-web/server.js && \
scp home/ec2-user/claude-agent-web/public/index.html \
    home/ec2-user/claude-agent-web/public/manage.html \
    claude-agent:~/claude-agent-web/public/ && \
ssh claude-agent "pm2 restart all"
```

## ロールバック

```bash
# 直前バージョンのファイルを git から取り出して再デプロイ
git show HEAD~1:home/ec2-user/claude-agent-web/server.js > /tmp/server.js.bak
scp /tmp/server.js.bak claude-agent:~/claude-agent-web/server.js
ssh claude-agent "pm2 restart all"
```

## ログ確認

```bash
ssh claude-agent "pm2 logs --lines 50 --nostream"
```

## コミットメッセージ規則

```
feat: 新機能
fix:  バグ修正
ops:  インフラ・設定変更
docs: ドキュメント
```

## DB テーブル（SQLite: audit.db）

| テーブル | 用途 |
|---------|------|
| `audit_logs` | 全操作ログ |
| `user_skills` | スキル（`shared=1` で全ユーザーに公開） |
| `scheduled_tasks` | 定期・単発タスク |
| `conversations` / `messages` | 会話履歴 |
| `task_runs` | スキル実行履歴 |
| `user_roles` | ロール管理（DB 優先、env フォールバック） |
| `user_settings` | 個人ルール |

## セキュリティ注意

- corp MySQL アクセス可能テーブルは7つのみ（allowlist）→ `SECURITY.md` 参照
- `users` / `attendance_posts` 等は AI から参照不可
- Chatwork 送信は必ずユーザー確認（`send_system_notification` のみ確認不要）
