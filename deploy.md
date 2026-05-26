# AI Agent デプロイ手順

## サーバー情報
- EC2 (claude-agent-server): `52.68.18.9`
- アプリディレクトリ: `/home/ec2-user/claude-agent-web/`
- SSH キー: `C:\Users\masashi suemitsu\OneDrive\AWS\claude-agent-key.pem`

## ローカル ↔ サーバー パス対応

| ローカル | サーバー |
|---|---|
| `home/ec2-user/claude-agent-web/` | `/home/ec2-user/claude-agent-web/` |

---

## デプロイコマンド

### server.js
```
scp -i "C:\Users\masashi suemitsu\OneDrive\AWS\claude-agent-key.pem" "C:\Users\masashi suemitsu\OneDrive\Dev-gitacro\ai-agent\home\ec2-user\claude-agent-web\server.js" ec2-user@52.68.18.9:/home/ec2-user/claude-agent-web/server.js
```
→ pm2 再起動:
```
ssh -i "C:\Users\masashi suemitsu\OneDrive\AWS\claude-agent-key.pem" ec2-user@52.68.18.9 "pm2 restart claude-agent-web"
```

### public/index.html
```
scp -i "C:\Users\masashi suemitsu\OneDrive\AWS\claude-agent-key.pem" "C:\Users\masashi suemitsu\OneDrive\Dev-gitacro\ai-agent\home\ec2-user\claude-agent-web\public\index.html" ec2-user@52.68.18.9:/home/ec2-user/claude-agent-web/public/index.html
```

### public/login.html
```
scp -i "C:\Users\masashi suemitsu\OneDrive\AWS\claude-agent-key.pem" "C:\Users\masashi suemitsu\OneDrive\Dev-gitacro\ai-agent\home\ec2-user\claude-agent-web\public\login.html" ec2-user@52.68.18.9:/home/ec2-user/claude-agent-web/public/login.html
```

---

## 開発フロー

1. `C:\Users\masashi suemitsu\OneDrive\Dev-gitacro\ai-agent\` でファイル編集
2. 上記 SCP コマンドでサーバーに反映（pm2 再起動が必要なファイルは再起動）
3. ブラウザで https://d2jjp21sq86i80.cloudfront.net/ 動作確認
4. `git commit` & `git push origin main`

## Git

- ローカル: `C:\Users\masashi suemitsu\OneDrive\Dev-gitacro\ai-agent\`
- リモート: `https://github.com/masashi-suemitsu/ai-agent`
- ブランチ: `main`

---

## セキュリティ設定 (2026-05-27 ハードニング)

### CloudFront → Origin 認証
- nginx `/etc/nginx/conf.d/claude-agent.conf` で `X-CloudFront-Secret` ヘッダ照合（不一致は 444 silent close）
- シークレット値は `.claude/projects/.../memory/reference_cloudfront_secret.md` 参照
- 直接 `http://52.68.18.9/` を叩いても通らない。テストは CloudFront 経由（`https://d2jjp21sq86i80.cloudfront.net/`）または `-H "X-CloudFront-Secret: <値>"` 付きで

### SSH 制限
- Security Group `claude-agent-sg` (sg-0034bad266cf52701) で SSH(22) は corp 系と同じ管理者 IP リストのみ許可（27件）
- 新規 IP からアクセスする場合は AWS Console で SG に追加が必要
- fail2ban (sshd jail, ban=1h) も有効

### サーバー更新運用
- OS: Amazon Linux 2023, `sudo dnf upgrade --releasever=<次バージョン>` で minor 更新
- Node: nodejs22 がデフォルト alternatives (`/etc/alternatives/node -> node-22`)
- PM2: 7.0.1, Node 22 配下で動作
