import 'dotenv/config';
import fs from 'node:fs';
import { createAppBegStore } from '../src/db/appbegStore.js';
import {
  buildMyAccountButtons,
  buildMyAccountText,
  createAccountViewToken
} from '../src/telegram/accountView.js';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderTelegramCard(title, text, buttons) {
  const buttonHtml = buttons.flat().map((button) => (
    `<div class="btn">${escapeHtml(button.text)}</div>`
  )).join('');
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <pre>${escapeHtml(text)}</pre>
      <div class="buttons">${buttonHtml}</div>
    </section>
  `;
}

const store = await createAppBegStore();
if (!store.configured) {
  console.error('AppBeg not configured');
  process.exit(1);
}

const listed = await store.listPlayers({ page: 1, limit: 20, showTestData: false });
const player = (listed.players || []).find((row) => row.username === 'Amyfi02') || listed.players?.[0];
if (!player) {
  console.error('No real player found');
  process.exit(1);
}

const accounts = await store.listGameAccountsForPlayer(player.uid);
const credentials = {
  ok: true,
  username: player.username,
  password: 'demo-royal-pass',
  linkedUid: player.uid
};
const token = createAccountViewToken();
const usernames = buildMyAccountText(credentials, accounts, 'usernames');
const revealed = buildMyAccountText(credentials, accounts, 'revealed');
const hidden = buildMyAccountText(credentials, accounts, 'hidden');
const initialButtons = buildMyAccountButtons(token, {
  includeHide: true,
  includeShowGamePasswords: accounts.length > 0
});
const revealedButtons = buildMyAccountButtons(token, {
  includeHide: true,
  includeShowGamePasswords: false
});
const hiddenButtons = buildMyAccountButtons(token, {
  includeHide: false,
  includeShowGamePasswords: accounts.length > 0
});

for (const account of accounts) {
  if (account.password && usernames.includes(account.password)) {
    console.error('LEAK in usernames mode', account.label);
    process.exit(2);
  }
  if (account.password && hidden.includes(account.password)) {
    console.error('LEAK in hidden mode', account.label);
    process.exit(2);
  }
  if (account.password && !revealed.includes(account.password)) {
    console.error('MISSING password in revealed mode', account.label);
    process.exit(3);
  }
}

fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/my-account-usernames.txt', usernames);
fs.writeFileSync('evidence/my-account-revealed.txt', revealed);
fs.writeFileSync('evidence/my-account-hidden.txt', hidden);
fs.writeFileSync('evidence/my-account-live.json', JSON.stringify({
  player: player.username,
  uid: player.uid,
  accountCount: accounts.length,
  platforms: accounts.map((account) => ({
    label: account.label,
    username: account.username,
    hasPassword: Boolean(account.password)
  })),
  initialButtons: initialButtons.flat().map((button) => button.text)
}, null, 2));

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>My Account Telegram Samples</title>
  <style>
    body { font-family: Segoe UI, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
    h1 { margin: 0 0 16px; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 16px; }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: #93c5fd; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1220; border-radius: 12px; padding: 14px; margin: 0 0 12px; line-height: 1.45; }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn { background: #334155; border-radius: 999px; padding: 8px 12px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Telegram My Account — live player ${escapeHtml(player.username)}</h1>
  <div class="grid">
    ${renderTelegramCard('1. Initial (usernames only)', usernames, initialButtons)}
    ${renderTelegramCard('2. After Show Game Passwords', revealed, revealedButtons)}
    ${renderTelegramCard('3. After Hide Details', hidden, hiddenButtons)}
  </div>
</body>
</html>`;
fs.writeFileSync('evidence/my-account-telegram-samples.html', html);

console.log(JSON.stringify({
  ok: true,
  player: player.username,
  accountCount: accounts.length,
  platformsWithPassword: accounts.filter((account) => account.password).length
}, null, 2));
console.log('--- USERNAMES ---');
console.log(usernames);

await store.close();
