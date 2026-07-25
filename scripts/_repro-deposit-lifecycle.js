/**
 * Lifecycle repro: Help→Home→Account→Home→Help→Home→Deposit→"10"
 * Uses a real sqlite store + processBotJob (no eligibility mock).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';
import { shouldUseRegistrationBot } from '../src/telegram/chatbotProcessor.js';

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deposit-lifecycle-'));
const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 't.sqlite') });
const now = new Date().toISOString();

globalThis.appbegStore = {
  configured: true,
  async getPlayerByUid(uid) {
    return { uid: uid || 'playeruid123456', status: 'active', username: 'AmyField' };
  }
};

let mid = 2000;
const outbound = [];
globalThis.telegramBot = {
  telegram: {
    async sendMessage(_c, text, opts = {}) {
      outbound.push({ type: 'text', text: String(text).slice(0, 160) });
      return {
        message_id: ++mid,
        reply_markup: opts.reply_markup || { inline_keyboard: [[{ text: 'x', callback_data: 'x' }]] }
      };
    },
    async editMessageReplyMarkup() {},
    async sendPhoto(_c, _p, opts = {}) {
      outbound.push({ type: 'photo', text: String(opts?.caption || '').slice(0, 160) });
      return { message_id: ++mid };
    }
  }
};

let method = await store.db.prepare(
  'SELECT id FROM payment_methods WHERE is_active = 1 ORDER BY id LIMIT 1'
).get();
if (!method) {
  const inserted = await store.db.prepare(`
    INSERT INTO payment_methods (name, key, is_active, display_order, created_at, updated_at)
    VALUES ('Chime', 'chime', 1, 1, ?, ?)
  `).run(now, now);
  method = { id: inserted.lastInsertRowid };
}
const qrPath = path.join(dir, 'qr.png');
fs.writeFileSync(qrPath, Buffer.from('89504e470d0a1a0a', 'hex'));
let qr = await store.db.prepare(
  'SELECT id, file_path FROM payment_qr_codes WHERE payment_method_id = ? AND is_active = 1 LIMIT 1'
).get(method.id);
if (!qr) {
  const insertedQr = await store.db.prepare(`
    INSERT INTO payment_qr_codes (payment_method_id, file_path, is_active, is_default, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?)
  `).run(method.id, qrPath.replace(/\\/g, '/'), now, now);
  qr = { id: insertedQr.lastInsertRowid, file_path: qrPath };
}
store.getActivePaymentQrForRegistration = async () => ({ id: qr.id, file_path: qr.file_path || qrPath });
store.getActiveDefaultPaymentQr = async () => ({ id: qr.id, file_path: qr.file_path || qrPath });

const u = await store.upsertTelegramUser({
  id: 777001,
  first_name: 'Amy',
  username: 'amy_field',
  is_bot: false
}, now);
await store.ensureBotSession(u.id);
await store.updateRegistrationStatus(u.id, 'Registered', 'Test');
await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
  .run('playeruid123456', 'linked', u.id);
await store.updateAutomationState(u.id, {
  registrationInfo: {
    payment_display_name: 'Amy Field',
    payment_name: 'Amy Field',
    appbeg_player_uid: 'playeruid123456',
    appbeg_creation_complete: true,
    preferred_appbeg_username: 'AmyField',
    appbeg_password: 'Secret123',
    royal_vip_credentials: {
      username: 'AmyField',
      password: 'Secret123',
      player_uid: 'playeruid123456',
      telegram_user_id: String(u.telegram_id)
    }
  }
});

async function storeInbound(text) {
  const telegramMessageId = ++mid;
  const sentAt = new Date().toISOString();
  const conversation = await store.ensureConversation(u.id, sentAt);
  await store.db.prepare(`
    INSERT INTO messages (
      conversation_id, telegram_user_id, telegram_message_id, direction, sender_type,
      message_type, text, payload_json, sent_at
    ) VALUES (?, ?, ?, 'incoming', 'telegram_user', 'text', ?, '{}', ?)
  `).run(conversation.id, u.id, telegramMessageId, text, sentAt);
  return { telegramMessageId, sentAt };
}

async function runStep(label, { action = null, text = '' } = {}) {
  outbound.length = 0;
  let incomingTelegramMessageId = ++mid;
  let messageId = null;
  if (!action && text) {
    const saved = await storeInbound(text);
    incomingTelegramMessageId = saved.telegramMessageId;
    messageId = await store.findLatestIncomingMessageId(u.id, incomingTelegramMessageId);
  }

  const jobType = action ? 'callback_action' : 'inbound_message';
  const job = await store.createBotJob({
    contactId: u.id,
    telegramUserId: u.telegram_id,
    messageId,
    incomingTelegramMessageId,
    jobType,
    inputText: text || '',
    action
  });

  const before = await store.getAutomationState(u.id);
  const sessBefore = await store.getBotSession(u.id);
  const useReg = shouldUseRegistrationBot(job, before, await store.getUserProfile(u.id), sessBefore);
  const eligibility = await store.isIncomingMessageEligibleForAutoBot(u.id, {
    telegramMessageId: incomingTelegramMessageId,
    jobCreatedAt: job.created_at
  });

  console.log(`\n=== ${label} ===`);
  console.log('inbound', { action, text, incomingTelegramMessageId, messageId });
  console.log('before', {
    flow: before.current_flow,
    step: before.current_step,
    dep: before.registration_info?.deposit_in_progress,
    bot: `${sessBefore?.workflow_key}/${sessBefore?.workflow_step}`,
    useReg,
    eligible: eligibility.eligible,
    reason: eligibility.reason
  });

  const result = await processBotJob(store, job, { bot: globalThis.telegramBot });
  const after = await store.getAutomationState(u.id);
  const sessAfter = await store.getBotSession(u.id);
  console.log('after', {
    flow: after.current_flow,
    step: after.current_step,
    dep: after.registration_info?.deposit_in_progress,
    bot: `${sessAfter?.workflow_key}/${sessAfter?.workflow_step}`,
    result,
    outbound: outbound.map((o) => `${o.type}:${o.text.replace(/\n/g, ' | ').slice(0, 100)}`)
  });
  return { result, after, sessAfter, outbound: [...outbound], eligibility, useReg };
}

await runStep('Help', { action: 'bot:how_it_works' });
await runStep('Home', { action: 'bot:main_menu' });
await runStep('Account', { action: 'bot:my_account' });
const token = (await store.getAutomationState(u.id)).registration_info?.account_view_token;
const accountMsgId = (await store.getAutomationState(u.id)).registration_info?.account_view_message_id;
if (token && accountMsgId) {
  // Fresh account back requires matching message id; fall back to main menu.
  await runStep('Home after account', { action: 'bot:main_menu' });
} else {
  await runStep('Home after account', { action: 'bot:main_menu' });
}
await runStep('Help again', { action: 'bot:how_it_works' });
await runStep('Home again', { action: 'bot:main_menu' });
const deposit = await runStep('Deposit', { action: 'menu:deposit' });
assert.match(deposit.outbound[0]?.text || '', /How much would you like to deposit/i);
assert.equal(deposit.after.current_flow, 'registered_deposit');
assert.equal(deposit.sessAfter.workflow_key, 'deposit');
assert.equal(deposit.sessAfter.workflow_step, 'waiting_amount');

const amount = await runStep('Amount 10', { text: '10' });
console.log('\nAMOUNT RESULT', amount.result, amount.eligibility, amount.useReg);
assert.equal(amount.result?.skipped, undefined);
assert.ok(
  amount.outbound.some((o) => o.type === 'photo' || /waiting|verify|QR|payment/i.test(o.text)),
  `expected deposit window / QR after amount, got: ${JSON.stringify(amount.outbound)}`
);
assert.equal(amount.after.registration_info?.deposit_in_progress, true);
console.log('\nPASS: Help→…→Deposit→10 started deposit payment window');
