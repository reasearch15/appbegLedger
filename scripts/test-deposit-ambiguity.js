import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { markPaymentAppBegOwned, rejectAmbiguousPaymentCandidates, routePaymentEvent } from '../src/payments/router.js';
import { PAYMENT_WINDOW_FLOW, ROUTING_STATUS } from '../src/payments/constants.js';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-deposit-ambiguity-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 'test.sqlite') });
  const creditCalls = [];
  store.creditRegisteredDeposit = async (payload) => {
    creditCalls.push(payload);
    return { ok: true, status: creditCalls.filter((call) => call.paymentEventId === payload.paymentEventId).length === 1 ? 'credited' : 'already_credited' };
  };
  const botSends = [];
  const bot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        botSends.push({ chatId, text, options });
        return { message_id: 9000 + botSends.length, reply_markup: options.reply_markup || null };
      }
    }
  };
  return { store, dir, creditCalls, botSends, bot };
}

async function cleanup(ctx) {
  await ctx.store.db?.close?.();
  await fs.rm(ctx.dir, { recursive: true, force: true });
}

async function createContact(store, telegramId, name) {
  const contact = await store.upsertTelegramUser({
    id: telegramId,
    first_name: name,
    username: `${name.toLowerCase()}_vip`,
    is_bot: false
  });
  await store.updateRegistrationStatus(contact.id, 'Registered', 'Test');
  await store.updateRegistrationInfo(contact.id, {
    appbeg_player_uid: `player_${telegramId}`,
    payment_name: name,
    payment_display_name: name
  }, 'Test');
  return await store.getUserProfile(contact.id);
}

async function createDepositWindow(store, contact, { name, amount }) {
  return await store.createRegistrationPaymentWindow({
    contactId: contact.id,
    telegramUserId: contact.telegram_id,
    paymentMethodId: null,
    paymentDisplayName: name,
    firstDepositAmount: amount,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    windowMinutes: 7
  });
}

async function createPayment(store, { messageId, name, amount }) {
  const now = new Date().toISOString();
  const result = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, sender_name, message_text, raw_payload_json,
      processing_status, routing_status, parsed_amount, parsed_sender_name, parsed_payment_app,
      message_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'Parsed', 'unrouted', ?, ?, 'Chime', ?, ?, ?)
  `).run(
    messageId,
    -100444,
    name,
    [`You received $${amount} from ${name}`, '3:00 PM - 12 Jul 2026'].join('\n'),
    '{}',
    amount,
    name,
    now,
    now,
    now
  );
  return Number(result.lastInsertRowid);
}

async function testSingleCandidateMatchesNormally() {
  const ctx = await makeStore();
  try {
    const user = await createContact(ctx.store, 80101, 'Amy Field');
    const other = await createContact(ctx.store, 80102, 'Amy Field');
    const selectedWindow = await createDepositWindow(ctx.store, user, { name: 'Amy Field', amount: 12.34 });
    await createDepositWindow(ctx.store, other, { name: 'Amy Field', amount: 12.50 });
    const paymentId = await createPayment(ctx.store, { messageId: 1, name: 'Amy Field', amount: 12.34 });

    const result = await routePaymentEvent(ctx.store, paymentId, { bot: ctx.bot });
    assert.equal(result.outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    assert.equal(ctx.creditCalls.length, 1);
    assert.equal(ctx.creditCalls[0].windowId, selectedWindow.id);
    const payment = await ctx.store.getPaymentEvent(paymentId);
    assert.equal(Number(payment.registration_payment_window_id), Number(selectedWindow.id));
  } finally {
    await cleanup(ctx);
  }
}

async function testAmbiguousDepositWindowsHoldAndNotifyOnce() {
  const ctx = await makeStore();
  try {
    const userA = await createContact(ctx.store, 80201, 'Sam Lee');
    const userB = await createContact(ctx.store, 80202, 'Sam Lee');
    const windowA = await createDepositWindow(ctx.store, userA, { name: 'Sam Lee', amount: 18.88 });
    const windowB = await createDepositWindow(ctx.store, userB, { name: 'Sam Lee', amount: 18.88 });
    const paymentId = await createPayment(ctx.store, { messageId: 2, name: 'Sam Lee', amount: 18.88 });

    const result = await routePaymentEvent(ctx.store, paymentId, { bot: ctx.bot });
    assert.equal(result.outcome, ROUTING_STATUS.MANUAL_REVIEW);
    assert.equal(ctx.creditCalls.length, 0);
    assert.equal(ctx.botSends.length, 2);
    assert.match(ctx.botSends[0].text, /needs staff verification/);
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowA.id)).status, 'manual_review');
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowB.id)).status, 'manual_review');

    const repeat = await routePaymentEvent(ctx.store, paymentId, { bot: ctx.bot });
    assert.equal(repeat.outcome, ROUTING_STATUS.MANUAL_REVIEW);
    assert.equal(ctx.botSends.length, 2);
    return { ctx, paymentId, windowA, windowB };
  } catch (error) {
    await cleanup(ctx);
    throw error;
  }
}

async function testStaffSelectsOneCandidateIdempotently() {
  const { ctx, paymentId, windowA, windowB } = await testAmbiguousDepositWindowsHoldAndNotifyOnce();
  try {
    await markPaymentAppBegOwned(ctx.store, paymentId, {
      contactId: windowA.contact_id,
      registrationPaymentWindowId: windowA.id,
      staffName: 'Staff',
      bot: ctx.bot
    });
    await markPaymentAppBegOwned(ctx.store, paymentId, {
      contactId: windowA.contact_id,
      registrationPaymentWindowId: windowA.id,
      staffName: 'Staff',
      bot: ctx.bot
    });
    assert.equal(ctx.creditCalls.length, 1);
    assert.equal(ctx.creditCalls[0].windowId, windowA.id);
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowA.id)).status, 'matched');
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowB.id)).status, 'cancelled');
    assert.equal(ctx.botSends.filter((send) => /did not match your deposit request/.test(send.text)).length, 1);
  } finally {
    await cleanup(ctx);
  }
}

async function testRejectAllCandidates() {
  const { ctx, paymentId, windowA, windowB } = await testAmbiguousDepositWindowsHoldAndNotifyOnce();
  try {
    await rejectAmbiguousPaymentCandidates(ctx.store, paymentId, { staffName: 'Staff', bot: ctx.bot });
    await ctx.store.markPaymentIgnored(paymentId, { staffName: 'Staff' });
    assert.equal(ctx.creditCalls.length, 0);
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowA.id)).status, 'cancelled');
    assert.equal((await ctx.store.getRegistrationPaymentWindow(windowB.id)).status, 'cancelled');
    assert.equal(ctx.botSends.filter((send) => /did not match your deposit request/.test(send.text)).length, 2);
  } finally {
    await cleanup(ctx);
  }
}

async function testSameAmountDifferentNamesIsNotAmbiguous() {
  const ctx = await makeStore();
  try {
    const userA = await createContact(ctx.store, 80301, 'Nora Hill');
    const userB = await createContact(ctx.store, 80302, 'Mina Hill');
    const windowA = await createDepositWindow(ctx.store, userA, { name: 'Nora Hill', amount: 22.22 });
    await createDepositWindow(ctx.store, userB, { name: 'Mina Hill', amount: 22.22 });
    const paymentId = await createPayment(ctx.store, { messageId: 3, name: 'Nora Hill', amount: 22.22 });
    const result = await routePaymentEvent(ctx.store, paymentId, { bot: ctx.bot });
    assert.equal(result.outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    assert.equal(ctx.creditCalls.length, 1);
    assert.equal(ctx.creditCalls[0].windowId, windowA.id);
  } finally {
    await cleanup(ctx);
  }
}

await testSingleCandidateMatchesNormally();
await testAmbiguousDepositWindowsHoldAndNotifyOnce().then(({ ctx }) => cleanup(ctx));
await testStaffSelectsOneCandidateIdempotently();
await testRejectAllCandidates();
await testSameAmountDifferentNamesIsNotAmbiguous();
console.log('ok deposit ambiguity handling');
