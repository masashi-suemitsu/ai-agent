#!/bin/bash
# preflight.sh - サーバー起動前のセーフティチェック
#
# 目的: pm2 restart で本番に反映する前に、すべての require が解決できる事を確認する。
# 過去事例 (2026-05-28): 別ブランチで `web-push` を追加 → EC2 で npm install が走らず
#   → server.js 起動時に MODULE_NOT_FOUND → pm2 unstable_restarts (16) で停止 → 502 連発。
#
# 使い方:
#   ssh claude-agent "cd ~/claude-agent-web && git pull && npm install && ./scripts/preflight.sh && pm2 restart all"
#
# このスクリプトが失敗 (exit 1) すると && により後続の pm2 restart が走らないため、安全。

set -e
cd "$(dirname "$0")/.."

echo "[preflight] node syntax check..."
node --check server.js
node --check monitor.js

echo "[preflight] resolve all top-level requires..."
node -e '
const fs = require("fs");
const builtins = new Set(require("node:module").builtinModules);
const files = ["server.js", "monitor.js"];
const all = new Set();
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  // require("xxx") / require("xxx/sub") を全部抽出（相対パスと組み込みは除外）
  for (const m of code.matchAll(/require\(\s*["'"'"']([^"'"'"']+)["'"'"']\s*\)/g)) {
    const name = m[1];
    if (name.startsWith(".") || name.startsWith("/")) continue;
    if (builtins.has(name) || builtins.has(name.split("/")[0])) continue;
    all.add(name);
  }
}
const missing = [];
for (const m of all) {
  try { require.resolve(m); }
  catch(e) { missing.push(m); }
}
if (missing.length) {
  console.error("[preflight] MISSING modules:");
  for (const m of missing) console.error("  -", m);
  console.error("[preflight] 修正: npm install を実行するか package.json を確認");
  process.exit(1);
}
console.log("[preflight] OK: " + all.size + " modules resolved");
'

echo "[preflight] ✓ all checks passed"
