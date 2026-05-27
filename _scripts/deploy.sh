#!/bin/bash
# EC2 へのデプロイ: git push → EC2 git pull → 必要なら pm2 restart
set -e

EC2_HOST="claude-agent"
EC2_DIR="~/claude-agent-web"
APP_URL="https://d2jjp21sq86i80.cloudfront.net"

echo "=== デプロイ開始 ==="

# 1. GitHub にプッシュ
echo "→ GitHub にプッシュ..."
git push origin main

# 2. EC2 で git pull（出力を保持して server.js 変更を検知）
echo "→ EC2 で git pull..."
PULL_OUTPUT=$(ssh "$EC2_HOST" "cd $EC2_DIR && git pull origin main")
echo "$PULL_OUTPUT"

# 3. server.js が変わった場合のみ PM2 再起動
if echo "$PULL_OUTPUT" | grep -q "server.js"; then
  echo "→ server.js 変更を検知。PM2 を再起動..."
  ssh "$EC2_HOST" "pm2 restart claude-agent-web"
  echo "✓ デプロイ完了（PM2 再起動済み）"
else
  echo "✓ デプロイ完了（静的ファイルのみ・PM2 再起動なし）"
fi

echo "→ $APP_URL"
