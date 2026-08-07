import 'dotenv/config';
import fs from 'node:fs';
import { createAppBegStore } from '../src/db/appbegStore.js';
import {
  buildGameAccountDetailText,
  buildGameDetailButtons,
  buildMyAccountButtons,
  buildMyAccountMainText,
  createAccountViewToken
} from '../src/telegram/accountView.js';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderCard(title, text, buttons) {
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
const mainText = buildMyAccountMainText(credentials);
const mainButtons = buildMyAccountButtons(token, { gameAccounts: accounts, includeHide: true, mode: 'main' });
const sampleAccount = accounts[0];
const detailText = buildGameAccountDetailText({
  ...sampleAccount,
  password: sampleAccount?.password ? '[stored-password]' : null
});
const detailButtons = buildGameDetailButtons(token, { includeHide: true, mode: 'game' });
const hiddenDetail = buildGameAccountDetailText(sampleAccount, { hidePassword: true });

fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/my-account-main.txt', mainText);
fs.writeFileSync('evidence/my-account-game-detail.txt', detailText);
fs.writeFileSync('evidence/my-account-game-hidden.txt', hiddenDetail);
fs.writeFileSync('evidence/my-account-live.json', JSON.stringify({
  player: player.username,
  uid: player.uid,
  accountCount: accounts.length,
  platforms: accounts.map((account) => ({
    key: account.key,
    label: account.label,
    username: account.username,
    hasPassword: Boolean(account.password)
  })),
  mainButtons: mainButtons.flat().map((button) => button.text),
  detailButtons: detailButtons.flat().map((button) => button.text),
  sendMessageCountExpected: 1,
  editsExpected: ['game open', 'hide', 'back to games']
}, null, 2));

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>My Account Redesign Samples</title>
  <style>
    body { font-family: Segoe UI, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 16px; }
    .card h2 { margin: 0 0 12px; font-size: 15px; color: #93c5fd; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1220; border-radius: 12px; padding: 14px; margin: 0 0 12px; line-height: 1.45; min-height: 180px; }
    .buttons { display: flex; flex-direction: column; gap: 8px; }
    .btn { background: #334155; border-radius: 12px; padding: 10px 12px; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <h1>Telegram My Account redesign — ${escapeHtml(player.username)}</h1>
  <div class="grid">
    ${renderCard('1. Main My Account (game buttons)', mainText, mainButtons)}
    ${renderCard(`2. After tapping ${sampleAccount?.label || 'game'}`, detailText, detailButtons)}
    ${renderCard('3. After Hide Details on game', hiddenDetail, buildGameDetailButtons(token, { includeHide: false, mode: 'game_hidden' }))}
  </div>
</body>
</html>`;
fs.writeFileSync('evidence/my-account-redesign-samples.html', html);

console.log(JSON.stringify({
  ok: true,
  player: player.username,
  accountCount: accounts.length,
  sampleGame: sampleAccount?.label || null,
  mainButtonCount: mainButtons.flat().length
}, null, 2));
console.log('--- MAIN ---');
console.log(mainText);
console.log('--- BUTTONS ---');
console.log(mainButtons.flat().map((button) => button.text).join('\n'));

await store.close();
