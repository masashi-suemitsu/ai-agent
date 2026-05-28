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

> サーバーで直接編集して動作確認した場合も、サーバー上で `git commit && git push` してからローカルで `git pull` する。**SCP での直接転送は禁止**（EC2 の git 状態が壊れる原因になる）。

## 構成

```
ai-agent/  （リポジトリルート = EC2の ~/claude-agent-web/ に対応）
├── server.js
├── public/
│   ├── index.html
│   ├── manage.html
│   ├── feedback.html / feedback-detail.html / feedback-admin.html
│   ├── about.html / login.html
│   └── assets/
├── package.json
├── monitor.js
├── CLAUDE.md
└── memo/
```

EC2 上での実パス：`~/claude-agent-web/`（git clone 先）  
データファイル（audit.db / sessions.db）は git 管理外・EC2 上に保持。

## 本番環境

| 項目 | 値 |
|------|-----|
| EC2 IP | `52.68.18.9` |
| CloudFront | `https://d2jjp21sq86i80.cloudfront.net` |
| SSH エイリアス | `claude-agent`（`~/.ssh/config` に設定済み） |
| SSH キー | `C:/Users/masas/OneDrive/AWS/claude-agent-key.pem` |
| プロセス管理 | PM2（アプリ名: `claude-agent-web`） |

## リリース手順

### ローカルで編集したとき

```bash
# 編集前
git pull

# 編集・動作確認（ローカル）

# 編集後
git add <files>
git commit -m "feat/fix/ops: 変更内容"
git push origin main

# サーバーに反映（npm install は常に実行 — package.json 変更がなくても冪等で安全）
ssh claude-agent "cd ~/claude-agent-web && git pull && npm install && pm2 restart all"
```

> **再発防止: post-merge フック**  
> EC2 の `~/claude-agent-web/.git/hooks/post-merge` で、`git pull` 後に `package.json` / `package-lock.json` が変わっていれば自動で `npm install` が走る（2026-05-28 設置）。`git pull` だけで終わって 502 になる事故を防ぐためのセーフティネット。  
> `pm2 restart` は自動化していない（古いコードのまま動かす状態は事故にならないため）。CIから戻すには明示的に `pm2 restart all`。
> 
> フックは git 管理外。万一消えたら以下で再設置:
> ```bash
> cat > ~/claude-agent-web/.git/hooks/post-merge << 'EOF'
> #!/bin/bash
> changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null)
> if echo "$changed" | grep -qE "^package(-lock)?\.json$"; then
>   cd "$(git rev-parse --show-toplevel)" || exit 0
>   echo "[post-merge] package.json changed → npm install"
>   npm install 2>&1
> fi
> EOF
> chmod +x ~/claude-agent-web/.git/hooks/post-merge
> ```

### サーバーで直接編集・動作確認したとき

```bash
# サーバー上で
cd ~/claude-agent-web
git add <files>
git commit -m "fix: 動作確認済み"
git push origin main

# ローカルで同期
git pull
```

### 動作確認 URL

```
https://d2jjp21sq86i80.cloudfront.net
https://d2jjp21sq86i80.cloudfront.net/manage
```

### タグを打って記録（リリース時）

```bash
git tag v$(date +%Y.%m.%d)
git push origin --tags
```

## ロールバック

```bash
# サーバー上で
cd ~/claude-agent-web
git revert HEAD --no-edit
pm2 restart all
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

- corp MySQL アクセス可能テーブルは8つのみ（allowlist）→ `SECURITY.md` 参照
- `users` / `attendance_posts` 等は AI から参照不可
- Chatwork 送信は必ずユーザー確認（`send_system_notification` のみ確認不要）
