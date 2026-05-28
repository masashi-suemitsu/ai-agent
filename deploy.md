# AI Agent デプロイ手順

## サーバー情報
- EC2 (claude-agent-server): `52.68.18.9`
- SSH エイリアス: `claude-agent`（`~/.ssh/config` 設定済み）
- SSH キー: `C:\Users\masas\OneDrive\AWS\claude-agent-key.pem`
- アプリディレクトリ: `~/claude-agent-web/`（git リポジトリ）
- CloudFront: `https://d2jjp21sq86i80.cloudfront.net`
- プロセス管理: PM2（アプリ名: `claude-agent-web`）

## リポジトリ構成（2026-05-28 フラット化後）

| ローカル | EC2 | GitHub |
|---|---|---|
| `C:\Users\masas\OneDrive\Dev-gitacro\ai-agent\` | `/home/ec2-user/claude-agent-web/` | `masashi-suemitsu/ai-agent` |

リポジトリルートが EC2 の `~/claude-agent-web/` と 1:1 対応。

```
ai-agent/
├── server.js
├── public/
│   ├── index.html
│   ├── manage.html
│   └── ...
├── audit.db / sessions.db  ← git 管理外・EC2 上に保持
└── node_modules/            ← git 管理外
```

---

## デプロイフロー（git pull 方式）

```bash
# 1. ローカルで編集 → コミット → プッシュ
git add <files>
git commit -m "feat/fix/ops: 変更内容"
git push origin main

# 2. EC2 に反映（server.js 変更あり）
ssh claude-agent "cd ~/claude-agent-web && git pull && npm install && pm2 restart all"

# HTML/CSS のみ変更の場合（pm2 restart 不要）
ssh claude-agent "cd ~/claude-agent-web && git pull"
```

> `npm install` は package.json に変化がなくても冪等なので毎回実行して問題なし。

---

## セキュリティ設定

### CloudFront → Origin 認証
- nginx `/etc/nginx/conf.d/claude-agent.conf` で `X-CloudFront-Secret` ヘッダ照合（不一致は 444 silent close）
- シークレット値は `.claude/projects/.../memory/reference_cloudfront_secret.md` 参照
- 直接 `http://52.68.18.9/` は通らない。テストは CloudFront 経由 または `-H "X-CloudFront-Secret: <値>"` 付きで

### SSH 制限
- Security Group `claude-agent-sg` (sg-0034bad266cf52701) で SSH(22) は管理者 IP のみ許可
- 新規 IP からアクセスする場合は AWS Console で SG に追加が必要
- fail2ban (sshd jail, ban=1h) も有効

### サーバー更新運用
- OS: Amazon Linux 2023
- Node: nodejs22 (`/etc/alternatives/node -> node-22`)
- PM2: 7.0.1
