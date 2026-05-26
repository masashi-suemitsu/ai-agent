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
