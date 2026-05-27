#!/usr/bin/env node
// /home/ec2-user/claude-agent-web/monitor.js
// Health checker: hit local nginx, alert on consecutive failures via SES.
const http = require('http');
const fs = require('fs');
const nodemailer = require('nodemailer');

// Load .env manually (no dotenv dependency)
const ENV_PATH = '/home/ec2-user/claude-agent-web/.env';
if (fs.existsSync(ENV_PATH)) {
  for (const ln of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const STATE_FILE = '/tmp/claude-agent-monitor-state';
const SECRET = '48fd61e4704a9f597a109489c99325fe1d4f6a1db1f3f37a7b401781a26791c6';
const NOTIFY_TO = process.env.MONITOR_NOTIFY_TO || 'marketing@acrovision.co.jp';
const ALERT_AFTER = 2;

function check() {
  return new Promise((resolve) => {
    const req = http.request({
      host: 'localhost', port: 80, path: '/', method: 'GET',
      headers: { 'X-CloudFront-Secret': SECRET },
      timeout: 10000
    }, (res) => {
      const ok = res.statusCode < 500;
      resolve({ ok, code: res.statusCode });
      res.resume();
    });
    req.on('error', (e) => resolve({ ok: false, code: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 0, err: 'timeout' }); });
    req.end();
  });
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { fails: 0, alerted: false }; } }
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }

async function sendMail(subject, text) {
  const transporter = nodemailer.createTransport({
    host: process.env.SES_HOST || 'email-smtp.us-west-2.amazonaws.com',
    port: parseInt(process.env.SES_PORT || '587'),
    secure: false,
    auth: { user: process.env.SES_USER, pass: process.env.SES_SECRET }
  });
  await transporter.sendMail({
    from: process.env.SES_FROM || 'info@acrovision.co.jp',
    to: NOTIFY_TO, subject, text
  });
}

(async () => {
  const r = await check();
  const state = readState();
  const now = new Date().toISOString();

  if (r.ok) {
    if (state.alerted) {
      try { await sendMail('[ai-agent] サイト復旧', `${now}\nstatus=${r.code} で復旧しました。\nhttps://d2jjp21sq86i80.cloudfront.net/`); }
      catch(e) { console.error('mail err', e.message); }
    }
    writeState({ fails: 0, alerted: false });
    process.exit(0);
  }

  state.fails = (state.fails || 0) + 1;
  console.error(`[${now}] FAIL #${state.fails} code=${r.code} err=${r.err || ''}`);

  if (state.fails >= ALERT_AFTER && !state.alerted) {
    try {
      await sendMail(
        '[ai-agent] サイトダウン検知',
        `${now}\nlocalhost ヘルスチェック ${state.fails}回連続失敗。\ncode=${r.code} err=${r.err || ''}\n\n` +
        `確認: ssh ec2-user@52.68.18.9 で pm2 status / sudo systemctl status nginx\n` +
        `公開URL: https://d2jjp21sq86i80.cloudfront.net/`
      );
      state.alerted = true;
    } catch (e) { console.error('mail err', e.message); }
  }
  writeState(state);
  process.exit(1);
})();