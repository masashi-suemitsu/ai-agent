# ai-agent EC2 への IAM Role セットアップ手順

以下2つの用途のために必要:
- `backup-to-s3.sh` (cron 03:15 JST 日次) が S3 にアップロードする
- `server.js` の SES メール送信（IAM Role + AWS SDK 経由、corp-dev-ec2 と同じパターン）

## 1. IAM Policy を作成

AWS Console → IAM → ポリシー → 「ポリシーの作成」→ JSON タブ:

### 1-A. S3 バックアップ用

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AiAgentBackupWrite",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::mysql-backup-ap-northeast-1/ai-agent/*"
    },
    {
      "Sid": "AiAgentBackupList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::mysql-backup-ap-northeast-1",
      "Condition": {
        "StringLike": { "s3:prefix": ["ai-agent/*", "ai-agent"] }
      }
    }
  ]
}
```

ポリシー名: `ai-agent-s3-backup-write`

> `ListBucket` は `ai-agent/` プレフィックスのみに condition で絞り込み（他プレフィックスは見えない）。これで `aws s3 ls s3://mysql-backup-ap-northeast-1/ai-agent/` がエラーなく実行できる。

### 1-B. SES メール送信用

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AiAgentSesSend",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    }
  ]
}
```

ポリシー名: `ai-agent-ses-send`

> SES のサンドボックス制限が外れていない場合、Resource を `arn:aws:ses:us-west-2:<account>:identity/info@acrovision.co.jp` のように送信元 identity に絞ることも可能。社内利用なら `"*"` で運用上問題ない。

## 2. IAM Role を作成

AWS Console → IAM → ロール → 「ロールの作成」:

- 信頼されたエンティティ: **AWS のサービス → EC2**
- アクセス許可ポリシー: `ai-agent-s3-backup-write` と `ai-agent-ses-send` の両方を選択
- ロール名: `ai-agent-ec2-role`

既に `ai-agent-ec2-role` が S3 用で存在する場合は、IAM → ロール → `ai-agent-ec2-role` → 「許可を追加」→ `ai-agent-ses-send` をアタッチ。

## 3. EC2 インスタンスに Role をアタッチ

AWS Console → EC2 → インスタンス `i-04565e35c477db224` 選択 → 「アクション」→ 「セキュリティ」→ 「IAM ロールを変更」→ `ai-agent-ec2-role` を選択。

## 4. 動作確認

SSH で接続して:

```bash
aws sts get-caller-identity
# → 期待: "Arn": "arn:aws:sts::845852308938:assumed-role/ai-agent-ec2-role/..."

# S3 バックアップ
bash /home/ec2-user/claude-agent-web/backup-to-s3.sh
# → 期待: 末尾に "uploaded to s3://mysql-backup-ap-northeast-1/ai-agent/..."

aws s3 ls s3://mysql-backup-ap-northeast-1/ai-agent/ --recursive | tail -5

# SES 送信
aws ses send-email \
  --from info@acrovision.co.jp \
  --destination 'ToAddresses=suemitsu@acrovision.co.jp' \
  --message 'Subject={Data=IAM Role Test,Charset=UTF-8},Body={Text={Data=IAM Role test from EC2,Charset=UTF-8}}' \
  --region us-west-2
# → 期待: { "MessageId": "..." }
```

ロールアタッチ後は `pm2 restart claude-agent-web` で `getSesClient()` のキャッシュを再生成（再起動不要だが、念のため）。

## 5. (任意) ライフサイクル

S3 バケット `mysql-backup-ap-northeast-1` のライフサイクルルールで `ai-agent/` プレフィックスを 90日後削除に設定すると、長期保管コストを抑えられる。
