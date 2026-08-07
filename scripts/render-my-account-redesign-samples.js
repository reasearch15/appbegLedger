import fs from 'node:fs';
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

// Known live Amyfi02 platforms (verified earlier against AppBeg); passwords redacted for evidence.
const accounts = [
  { key: 'orion_stars', label: 'Orion Stars', username: 'amyniv_0OS', password: '[stored]' },
  { key: 'fire_kirin', label: 'Fire Kirin', username: 'amyqxb_0FK', password: '[stored]' },
  { key: 'juwa', label: 'Juwa', username: 'amydon_0JW', password: '[stored]' },
  { key: 'juwa2', label: 'Juwa2', username: 'amyoiyju', password: '[stored]' },
  { key: 'ultra_panda', label: 'Ultra Panda', username: 'amy7vo0UP', password: '[stored]' },
  { key: 'vb_link', label: 'VB Link', username: 'amy8eqVB', password: '[stored]' },
  { key: 'mafia', label: 'Mafia', username: 'amy1iy0MF', password: '[stored]' },
  { key: 'cash_frenzy', label: 'Cash Frenzy', username: 'amy7220CF', password: '[stored]' },
  { key: 'vegas_sweeps', label: 'Vegas Sweeps', username: 'amyxlo_0VS', password: '[stored]' },
  { key: 'milky_way', label: 'Milky Way', username: 'amygmy_0MW', password: '[stored]' },
  { key: 'game_vault', label: 'Game Vault', username: 'amyjbv_0GV', password: '[stored]' }
];

const credentials = {
  ok: true,
  username: 'Amyfi02',
  password: 'demo-royal-pass',
  linkedUid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2'
};
const token = createAccountViewToken();
const mainText = buildMyAccountMainText(credentials);
const mainButtons = buildMyAccountButtons(token, {
  gameAccounts: accounts,
  includeHide: true,
  mode: 'main'
});
const detailText = buildGameAccountDetailText(accounts[0]);
const detailButtons = buildGameDetailButtons(token, { includeHide: true, mode: 'game' });

fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/my-account-main.txt', mainText);
fs.writeFileSync('evidence/my-account-game-detail.txt', detailText);

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
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1220; border-radius: 12px; padding: 14px; margin: 0 0 12px; line-height: 1.45; min-height: 160px; }
    .buttons { display: flex; flex-direction: column; gap: 8px; }
    .btn { background: #334155; border-radius: 12px; padding: 10px 12px; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <h1>Telegram My Account redesign — Amyfi02</h1>
  <div class="grid">
    ${renderCard('1. Main My Account (game buttons)', mainText, mainButtons)}
    ${renderCard('2. After tapping Orion Stars', detailText, detailButtons)}
  </div>
</body>
</html>`;

fs.writeFileSync('evidence/my-account-redesign-samples.html', html);
console.log(mainText);
console.log('---');
console.log(mainButtons.flat().map((button) => button.text).join('\n'));
console.log('---');
console.log(detailText);
