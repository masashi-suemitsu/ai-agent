# セキュリティ設計

AI Agent (claude-agent-web) における corp_acro_jp データベース・社内API へのアクセス制御方針。

最終更新: 2026-05-27

---

## 全体方針

AIエージェントからアクセスできるデータは **アロウリスト方式** で明示的に許可されたものだけ。
未指定のテーブル・アクション・経路はすべて拒否する。

---

## DB アロウリスト

### 許可テーブル（6個）

ファイル: `home/ec2-user/claude-agent-web/server.js` (`DB_ALLOWED_TABLES`)

| テーブル | 用途 |
|---|---|
| `kintone_employees` | 社員マスタ |
| `kintone_contract` | 契約データ |
| `kintone_anken_eigyo` | 案件データ |
| `geppo_data` | 月報データ |
| `kintone_customers` | 顧客データ |
| `kintone_seikyu` | 請求データ |

これ以外のテーブル（`users` / `attendance_posts` / `king_of_time_attendance` / `jinji_employee_profiles` / `in_member_evaluations` / `in_member_evaluation_results` / `recruit_ats_*` / `follow_signal_pool` など）への AI 経由の照会はすべて拒否される。

### キーワードブロック

`INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|DESCRIBE|SHOW` を含む SQL は無条件で拒否。SELECT のみ許可。

### 適用範囲（AI から corp DB へ到達可能な経路すべて）

| 経路 | 場所 | 状態 |
|---|---|---|
| `query_corp_db` ツール | `executeTool('query_corp_db')` | ✅ アロウリスト適用 |
| `/api/db/query` エンドポイント | UI 経由の SQL 実行 | ✅ アロウリスト適用 |
| `/api/db/tables` エンドポイント | テーブル一覧表示 | ✅ アロウリスト内のみ返却 |
| `fetch_corp_api(action=query)` ツール | corp 経由の SQL | 🚫 ツール定義から削除済み（後述） |

### 多層防御

corp 側 PHP (`/api/agent.php` の `case 'query'`) にも **同じアロウリスト** を実装。
ファイル: `corp-dev-ec2/home/acrovision/www/corp.acrovision.jp/api/agent.php` (`$ALLOWED_TABLES`)

→ CORP_AGENT_TOKEN が万一漏洩しても、corp 側で機密テーブルアクセスが遮断される。

⚠️ **同期注意**: Node 側と corp 側のアロウリストは同一に保つこと。両ファイルにクロス参照コメントを記載済み。

---

## corp API ロール権限

ファイル: `server.js` (`CORP_API_ALLOWED`)

| ロール | 許可アクション |
|---|---|
| admin | cases / contracts / geppo / query |
| gyoumu | contracts / geppo / query |
| eigyo | cases / geppo |
| recruit | (なし) |
| user | (なし) |

`employees` / `candidates` / `follow_signals` / `attendance` アクションは **全ロールから除外**。
（対応テーブルがアロウリスト外 + users JOIN による個人情報漏洩経路を塞ぐため）

---

## corp サーバー側 API ゲートウェイ（現在閉鎖中）

`/api/agent.php` は `http_response_code(503); exit;` で **全リクエスト 503 返却中**。
→ `fetch_corp_api` / `fetch_corp_page` は呼んでも届かない。

このため Node 側ではこれらのツール定義を **コメントアウトで削除**。再開時は git history から復元可能。

復元参考コミット: `ec7d66c7` (corp-dev-ec2) / `7251ba0` 以前 (ai-agent)

---

## 監査ログ

すべてのアクセス試行と拒否を `audit_logs` テーブル (SQLite) に記録。

### 拒否ログのアクション名

| action | 発生箇所 |
|---|---|
| `tool.db.denied` | `query_corp_db` ツールでロール違反/キーワード違反/テーブル違反 |
| `db.query.denied` | `/api/db/query` エンドポイントで違反 |
| `tool.corp_api.denied` | `fetch_corp_api` でアクション違反/SQL違反（現在は無効化中） |

### 拒否理由 (`details.reason`)

- `role`: DB照会権限なし
- `keyword`: INSERT/UPDATE/DELETE/SHOW/DESCRIBE 等
- `table`: アロウリスト外のテーブル
- `action`: 許可されていない corp API アクション

### 確認方法

```sql
SELECT ts, email, action, details FROM audit_logs
WHERE action LIKE '%.denied'
ORDER BY ts DESC LIMIT 50;
```

---

## DB レベルの権限（多層防御の限界）

`agent_readonly` MySQL ユーザーは **SELECT 専用** （INSERT/UPDATE/DELETE/DROP 等の権限なし）。
→ アプリ層を完全に迂回されても DB 改竄は不可能。

ただし、`agent_readonly` は **アロウリスト外の機密テーブルにも SELECT 権限を持つ**:
- `users`, `follow_signal_pool`, `jinji_employee_profiles`, `in_member_evaluation*`,
  `king_of_time_attendance`, `kinmu_daily_attendance`, `monthly_attendance_summary`,
  `recruit_ats_*` など

**運用判断（2026-05-27）**: アプリ層のアロウリストのみで運用。DB 権限の更なる絞り込みは未実施。

将来 SQL インジェクションや正規表現迂回が発見された場合、DB 側で `REVOKE SELECT ON corp_acro_jp.users FROM agent_readonly@%` 等を実行することで多層防御を強化できる。

---

## ログイン処理（影響なし）

ユーザー認証は Google OAuth 経由で、セッションはローカル SQLite (`sessions.db`) に保存。
**corp の `users` テーブルには一切アクセスしない**。アロウリストは認証経路に影響しない。

---

## アロウリスト変更手順

テーブルを追加・削除する場合は **必ず以下2ファイル両方** を同時に更新する:

1. `ai-agent/home/ec2-user/claude-agent-web/server.js`
   - `DB_ALLOWED_TABLES` Set
2. `corp-dev-ec2/home/acrovision/www/corp.acrovision.jp/api/agent.php`
   - `case 'query'` 内の `$ALLOWED_TABLES` 配列

更新後の動作確認:
```bash
node --check home/ec2-user/claude-agent-web/server.js
php -l home/acrovision/www/corp.acrovision.jp/api/agent.php
```

---

## 関連コミット履歴

| コミット | 概要 | リポジトリ |
|---|---|---|
| `ac123cf` | DBアクセスをアロウリスト方式に変更、機密テーブル遮断 | ai-agent |
| `336878c` | 拒否アクセス監査ログ、.gitignore整理 | ai-agent |
| `7251ba0` | クロス参照コメント追加 | ai-agent |
| `ec7d66c7` | corp 側 PHP に多層防御アロウリスト実装 | corp-dev-ec2 |
| `5dce5403` | corp 側にもクロス参照コメント | corp-dev-ec2 |
