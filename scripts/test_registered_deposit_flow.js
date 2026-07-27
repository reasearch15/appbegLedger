import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';
import { validateCallbackFreshness } from '../src/telegram/callbackSafety.js';
import { processPaymentWindowExpiryTick } from '../src/telegram/paymentWindowExpiryWorker.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

async function createHarness(label) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `registered-deposit-${label}-`));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 't.sqlite') });
  const now = new Date().toISOString();
  await store.setAutoRegistrationBotEnabled?.(true, 'Test');

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

  let telegramMessageId = 5000;
  const outbound = [];
  const bot = {
    telegram: {
      async sendMessage(_chatId, text, opts = {}) {
        outbound.push({ type: 'text', text, buttons: opts.reply_markup?.inline_keyboard || [] });
        return { message_id: ++telegramMessageId, reply_markup: opts.reply_markup };
      },
      async sendPhoto(_chatId, _photo, opts = {}) {
        outbound.push({ type: 'photo', text: opts.caption || '', buttons: opts.reply_markup?.inline_keyboard || [] });
        return { message_id: ++telegramMessageId, reply_markup: opts.reply_markup };
      },
      async editMessageReplyMarkup() {},
      async deleteMessage() {},
      async editMessageCaption() {}
    }
  };

  const user = await store.upsertTelegramUser({
    id: 900000 + Math.floor(Math.random() * 100000),
    first_name: 'Amy',
    username: `amy_${label}`,
    is_bot: false
  }, now);
  await store.ensureBotSession(user.id);
  await store.updateRegistrationStatus(user.id, 'Registered', 'Test');
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run(`player-${label}`, 'linked', user.id);
  await store.updateAutomationState(user.id, {
    registrationInfo: {
      payment_display_name: 'Amy Field',
      payment_name: 'Amy Field',
      appbeg_player_uid: `player-${label}`,
      appbeg_creation_complete: true,
      royal_vip_credentials: {
        username: `Amy${label}`,
        password: 'Secret123',
        player_uid: `player-${label}`,
        telegram_user_id: String(user.telegram_id)
      }
    }
  });

  async function storeInbound(text) {
    const sentAt = new Date().toISOString();
    const conversation = await store.ensureConversation(user.id, sentAt);
    const incomingTelegramMessageId = ++telegramMessageId;
    await store.db.prepare(`
      INSERT INTO messages (
        conversation_id, telegram_user_id, telegram_message_id, direction, sender_type,
        message_type, text, payload_json, sent_at
      ) VALUES (?, ?, ?, 'incoming', 'telegram_user', 'text', ?, '{}', ?)
    `).run(conversation.id, user.id, incomingTelegramMessageId, text, sentAt);
    return {
      incomingTelegramMessageId,
      messageId: await store.findLatestIncomingMessageId(user.id, incomingTelegramMessageId)
    };
  }

  async function runJob({ text = '', action = null, messageId = null, incomingTelegramMessageId = null } = {}) {
    outbound.length = 0;
    if (!action && incomingTelegramMessageId == null) {
      const saved = await storeInbound(text);
      messageId = saved.messageId;
      incomingTelegramMessageId = saved.incomingTelegramMessageId;
    }
    if (action && incomingTelegramMessageId == null) {
      incomingTelegramMessageId = ++telegramMessageId;
    }
    const job = await store.createBotJob({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      messageId,
      incomingTelegramMessageId,
      jobType: action ? 'callback_action' : 'inbound_message',
      inputText: text,
      action
    });
    const result = await processBotJob(store, job, { bot });
    return { result, outbound: [...outbound], job };
  }

  async function activeDepositWindows() {
    return store.db.prepare(`
      SELECT *
      FROM registration_payment_windows
      WHERE contact_id = ?
        AND flow_type = ?
        AND status = 'active'
      ORDER BY id
    `).all(user.id, PAYMENT_WINDOW_FLOW.DEPOSIT);
  }

  return { store, user, bot, outbound, runJob, storeInbound, activeDepositWindows };
}

async function testExpiredThenDepositAmountStartsImmediately() {
  const h = await createHarness('expired-redeposit');
  const past = new Date(Date.now() - 60_000).toISOString();
  const now = new Date().toISOString();
  const expiredInsert = await h.store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, flow_type, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, 1, 1, 'Amy Field', 5, ?, 'active', ?, ?, ?)
  `).run(h.user.id, String(h.user.telegram_id), PAYMENT_WINDOW_FLOW.DEPOSIT, past, now, now);
  await h.store.updateAutomationState(h.user.id, {
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_await_payment',
    registrationInfo: {
      payment_display_name: 'Amy Field',
      payment_name: 'Amy Field',
      deposit_in_progress: true,
      deposit_awaiting_payment: true,
      deposit_payment_window_id: expiredInsert.lastInsertRowid,
      payment_window_id: expiredInsert.lastInsertRowid
    }
  });

  await processPaymentWindowExpiryTick({ store: h.store, sendExpiryMessage: async () => ({ queued: true }) });
  const deposit = await h.runJob({ action: 'menu:deposit' });
  assert.match(deposit.outbound[0]?.text || '', /How much would you like to deposit/i);
  const amount = await h.runJob({ text: '5' });
  assert.equal(amount.result.decision.kind, 'registration_send_payment_qr');
  assert.equal((await h.activeDepositWindows()).length, 1);
  console.log('ok expired deposit -> Deposit -> 5 starts payment window immediately');
}

async function testInvalidThenValidAmount() {
  const h = await createHarness('invalid-valid');
  await h.runJob({ action: 'menu:deposit' });
  const invalid = await h.runJob({ text: 'Hello' });
  assert.equal(invalid.result.decision.kind, 'deposit_ask_amount');
  assert.match(invalid.outbound[0]?.text || '', /valid deposit amount/i);
  const valid = await h.runJob({ text: '$5.00' });
  assert.equal(valid.result.decision.kind, 'registration_send_payment_qr');
  assert.equal((await h.activeDepositWindows()).length, 1);
  console.log('ok Hello validates only while waiting; $5.00 then starts payment window');
}

async function testCallbacksStayUsable() {
  const h = await createHarness('callbacks');
  const oldDeposit = await validateCallbackFreshness({
    store: h.store,
    user: h.user,
    action: 'menu:deposit',
    callbackMessageId: 123,
    callbackMessageDate: Math.floor(Date.now() / 1000) - 6 * 60 * 60
  });
  assert.equal(oldDeposit.ok, true);

  await h.runJob({ action: 'menu:deposit' });
  const cancelFreshness = await validateCallbackFreshness({
    store: h.store,
    user: h.user,
    action: 'deposit:cancel',
    callbackMessageId: 999,
    callbackMessageDate: Math.floor(Date.now() / 1000) - 6 * 60
  });
  assert.equal(cancelFreshness.ok, true);
  const cancel = await h.runJob({ action: 'deposit:cancel' });
  assert.equal(cancel.result.decision.kind, 'deposit_cancelled');
  console.log('ok old Deposit remains usable and Cancel works during active flow');
}

async function testExpiryImmediateRedepositWorks() {
  const h = await createHarness('expiry-immediate');
  await h.runJob({ action: 'menu:deposit' });
  await h.runJob({ text: '5' });
  const active = (await h.activeDepositWindows())[0];
  await h.store.db.prepare('UPDATE registration_payment_windows SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), active.id);
  await processPaymentWindowExpiryTick({ store: h.store, sendExpiryMessage: async () => ({ queued: true }) });
  const redeposit = await h.runJob({ action: 'menu:deposit' });
  assert.match(redeposit.outbound[0]?.text || '', /How much would you like to deposit/i);
  const amount = await h.runJob({ text: '5.00' });
  assert.equal(amount.result.decision.kind, 'registration_send_payment_qr');
  assert.equal((await h.activeDepositWindows()).length, 1);
  console.log('ok deposit expiry -> immediate redeposit works');
}

async function testRapidDuplicateMessagesCreateOneWindow() {
  const h = await createHarness('duplicate');
  await h.runJob({ action: 'menu:deposit' });
  const first = await h.storeInbound('5');
  const second = await h.storeInbound('5');
  const job1 = await h.store.createBotJob({
    contactId: h.user.id,
    telegramUserId: h.user.telegram_id,
    messageId: first.messageId,
    incomingTelegramMessageId: first.incomingTelegramMessageId,
    jobType: 'inbound_message',
    inputText: '5'
  });
  const job2 = await h.store.createBotJob({
    contactId: h.user.id,
    telegramUserId: h.user.telegram_id,
    messageId: second.messageId,
    incomingTelegramMessageId: second.incomingTelegramMessageId,
    jobType: 'inbound_message',
    inputText: '5'
  });

  await Promise.all([
    processBotJob(h.store, job1, { bot: h.bot }),
    processBotJob(h.store, job2, { bot: h.bot })
  ]);
  assert.equal((await h.activeDepositWindows()).length, 1);
  console.log('ok rapid duplicate amount messages create one payment window');
}

await testExpiredThenDepositAmountStartsImmediately();
await testInvalidThenValidAmount();
await testCallbacksStayUsable();
await testExpiryImmediateRedepositWorks();
await testRapidDuplicateMessagesCreateOneWindow();
console.log('ALL REGISTERED DEPOSIT FLOW CHECKS PASSED');
