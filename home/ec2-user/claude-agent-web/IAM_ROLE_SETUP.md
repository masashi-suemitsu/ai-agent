# ai-agent EC2 への IAM Role セットアップ手順

`backup-to-s3.sh` (cron 03:15 JST 日次) が S3 にアップロードするために必要。

## 1. IAM Policy を作成

AWS Console → IAM → ポリシー → 「ポリシーの作成」→ JSON タブ:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AiAgentBackupWrite",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::mysql-backup-ap-northeast-1/ai-agent/*"
    }
  ]
}
```

ポリシー名: `ai-agent-s3-backup-write`

## 2. IAM Role を作成

AWS Console → IAM → ロール → 「ロールの作成」:

- 信頼されたエンティティ: **AWS のサービス → EC2**
- アクセス許可ポリシー: `ai-agent-s3-backup-write` を選択
- ロール名: `ai-agent-ec2-role`

## 3. EC2 インスタンスに Role をアタッチ

AWS Console → EC2 → インスタンス `i-04565e35c477db224` 選択 → 「アクション」→ 「セキュリティ」→ 「IAM ロールを変更」→ `ai-agent-ec2-role` を選択。

## 4. 動作確認

SSH で接続して:

```bash
aws sts get-caller-identity
# → 期待: "Arn": "arn:aws:sts::845852308938:assumed-role/ai-agent-ec2-role/..."

bash /home/ec2-user/claude-agent-web/backup-to-s3.sh
# → 期待: 末尾に "uploaded to s3://mysql-backup-ap-northeast-1/ai-agent/..."

aws s3 ls s3://mysql-backup-ap-northeast-1/ai-agent/ --recursive | tail -5
```

## 5. (任意) ライフサイクル

S3 バケット `mysql-backup-ap-northeast-1` のライフサイクルルールで `ai-agent/` プレフィックスを 90日後削除に設定すると、長期保管コストを抑えられる。
