---
name: release
description: 変更を commit / GitHub push し、EC2 (~/claude-agent-web) に git pull + pm2 restart で反映する標準リリース手順。/release で起動。
---

# release — ai-agent デプロイスキル

CLAUDE.md の「リリース手順」を実行する。

## 実行手順

### 1. 事前チェック
- `git status` と `git diff`（必要なら `git diff --cached`）で変更内容を確認
- ステージ済み・未ステージ・未追跡ファイルをユーザーに提示
- 変更がない場合は「リリースする変更がない」と報告して中止
- 機密ファイル（`.env`, `*.pem`, `credentials.json`, `*.db`）が含まれていないか確認。あれば警告

### 2. コミットメッセージ提案
- 変更内容から prefix を自動判定:
  - 新機能 → `feat:`
  - バグ修正 → `fix:`
  - インフラ・設定変更 → `ops:`
  - ドキュメントのみ → `docs:`
- メッセージ案をユーザーに提示し確認を取る
- ユーザーが書き直したい場合は新しいメッセージで進める

### 3. コミット & push
- 対象ファイルを **個別に** `git add <files>`（`git add -A` / `git add .` は使わない）
- `git commit -m "..."`（HEREDOC で複数行も可）
- `git push origin main`
- `--no-verify` / `--force` は禁止。push 失敗時は原因を調査して報告

### 4. EC2 へ反映
まず alias を試す:
```bash
ssh claude-agent "cd ~/claude-agent-web && git pull && npm install && pm2 restart all"
```

ホスト名が解決できない場合のフォールバック（key パスはユーザー環境に合わせて調整）:
```bash
ssh -i "<SSH key path>" -o StrictHostKeyChecking=no ec2-user@52.68.18.9 \
  "cd ~/claude-agent-web && git pull && npm install && pm2 restart all"
```

既知の key パス候補:
- `/c/Users/masashi suemitsu/OneDrive/AWS/claude-agent-key.pem`（masashi のローカル）
- `C:/Users/masas/OneDrive/AWS/claude-agent-key.pem`（CLAUDE.md 記載）

出力末尾の pm2 テーブルで `status: online` を確認する。

### 5. 報告
1 行で以下をまとめて報告:
- コミット SHA（短縮）
- pm2 再起動結果（online / エラー）
- 確認 URL: `https://d2jjp21sq86i80.cloudfront.net/manage`

## 禁止事項
- `--no-verify`, `--force`, `git push --force-with-lease` の使用
- SCP / rsync での直接転送（EC2 の git 状態を壊す）
- `git add -A` / `git add .`（機密ファイル混入の原因）
- `audit.db` / `sessions.db` のコミット（git 管理外）

## ロールバック
本番で問題が出た場合:
```bash
ssh claude-agent "cd ~/claude-agent-web && git revert HEAD --no-edit && pm2 restart all"
```
