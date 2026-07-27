/**
 * Focused regression: expired registered deposit must allow a fresh redeposit attempt.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { handlePaymentRegistrationQr } from '../src/telegram/registrationQrSend.js';
import { processPaymentWindowExpiryTick } from '../src/telegram/paymentWindowExpiryWorker.js';
import { shouldUseRegistrationBot } from '../src/telegram/chatbotProcessor.js';
import {
  beginRegisteredDeposit,
  clearStaleDepositSessionFields,
  isGenuinelyActiveDepositWindow
} from '../src/telegram/registeredDepositFlow.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';
import { isEligibleActivePaymentWindow } from '../src/payments/paymentWindowMatcher.js';

async function applyDecision(store, contactId, decision) {
  if (!decision?.statePatch) return;
  await store.updateAutomationState(contactId, decision.statePatch);
  if (decision.statePatch.registrationInfo && !decision.replaceRegistrationInfo) {
    await store.updateRegistrationInfo(contactId, decision.statePatch.registrationInfo, 'Chatbot');
  }
}

function botStub(messageId) {
  return {
    telegram: {
      async sendPhoto() { return { message_id: messageId }; },
      async sendMessage() { return { message_id: messageId + 1 }; }
    }
  };
}

async function ensurePaymentFixtures(store, now) {
  let method = await store.db.prepare(
    'SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id LIMIT 1'
  ).get();
  if (!method) {
    const m = await store.db.prepare(`
      INSERT INTO payment_methods (name, key, is_active, display_order, created_at, updated_at)
      VALUES ('Chime', 'chime', 1, 1, ?, ?)
    `).run(now, now);
    method = { id: m.lastInsertRowid, name: 'Chime' };
  }

  const tmpQr = path.join('data', 'media', 'payment-qr', 'redeposit-regression.png');
  fs.mkdirSync(path.dirname(tmpQr), { recursive: true });
  if (!fs.existsSync(tmpQr)) fs.writeFileSync(tmpQr, Buffer.from('89504e470d0a1a0a', 'hex'));

  let qr = await store.db.prepare(
    'SELECT id, file_path FROM payment_qr_codes WHERE payment_method_id = ? AND is_active = 1 LIMIT 1'
  ).get(method.id);
  if (!qr) {
    const q = await store.db.prepare(`
      INSERT INTO payment_qr_codes (payment_method_id, file_path, is_active, is_default, created_at, updated_at)
      VALUES (?, ?, 1, 1, ?, ?)
    `).run(method.id, tmpQr.replace(/\\/g, '/'), now, now);
    qr = { id: q.lastInsertRowid, file_path: tmpQr };
  }

  store.getActivePaymentQrForRegistration = async () => ({ id: qr.id, file_path: qr.file_path || tmpQr });
  store.getActiveDefaultPaymentQr = async () => ({ id: qr.id, file_path: qr.file_path || tmpQr });
  return { method, qr, tmpQr };
}

async function createRegisteredContact(store, { telegramId, now, name = 'Amy Field' }) {
  const insert = await store.db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, last_name, display_name, registration_status,
      appbeg_account_id, appbeg_link_status, is_bot, first_seen, last_seen, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Registered', ?, 'linked', 0, ?, ?, ?)
  `).run(
    telegramId,
    `user_${telegramId}`,
    'Amy',
    'Field',
    name,
    `player_${telegramId}`,
    now,
    now,
    now
  );
  const contactId = insert.lastInsertRowid;
  await store.db.prepare(`
    INSERT INTO contact_automation_state (
      telegram_user_id, current_flow, current_step, registration_info_json, updated_at
    ) VALUES (?, NULL, NULL, ?, ?)
  `).run(
    contactId,
    JSON.stringify({
      payment_display_name: name,
      payment_name: name,
      appbeg_player_uid: `player_${telegramId}`,
      appbeg_creation_complete: true
    }),
    now
  );
  return store.getUserProfile(contactId);
}

async function run() {
  assert.equal(
    isGenuinelyActiveDepositWindow({
      status: 'active',
      flow_type: 'deposit',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      matched_payment_event_id: null
    }),
    false,
    'past expires_at is not active'
  );
  assert.equal(
    isGenuinelyActiveDepositWindow({
      status: 'expired',
      flow_type: 'deposit',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      matched_payment_event_id: null
    }),
    false,
    'expired status is not active'
  );
  assert.equal(
    isGenuinelyActiveDepositWindow({
      status: 'completed',
      flow_type: 'deposit',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      matched_payment_event_id: 1
    }),
    false,
    'completed is not active'
  );
  const cleaned = clearStaleDepositSessionFields({
    payment_display_name: 'Amy Field',
    deposit_in_progress: true,
    deposit_awaiting_payment: true,
    deposit_requested_amount: 25,
    deposit_payment_window_id: 9,
    payment_window_id: 9,
    payment_window_expires_at: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(cleaned.payment_display_name, 'Amy Field');
  assert.equal(cleaned.deposit_payment_window_id, undefined);
  assert.equal(cleaned.payment_window_id, undefined);
  console.log('ok active-window helpers reject expired/completed and clear stale session fields');

  assert.equal(
    shouldUseRegistrationBot(
      { job_type: 'inbound_message', input_text: '40' },
      {
        current_flow: null,
        current_step: null,
        registration_info: { deposit_in_progress: true, payment_display_name: 'Amy Field' }
      },
      { registration_status: 'Registered' }
    ),
    true,
    'amount entry must stay on deposit bot when deposit_in_progress survives a wiped flow'
  );
  console.log('ok shouldUseRegistrationBot keeps deposit amount entry after stale flow wipe');

  const store = await createDataStore();
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const { method, qr } = await ensurePaymentFixtures(store, now);

  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUid(uid) {
      return { uid, status: 'active', username: 'AmyVip01' };
    }
  };

  const contact = await createRegisteredContact(store, {
    telegramId: Date.now(),
    now,
    name: 'Amy Field'
  });
  const contactId = contact.id;

  // --- Attempt A ---
  const startA = await decideBotReply({ store, contact, action: 'menu:deposit' });
  assert.equal(startA.kind, 'deposit_ask_amount');
  assert.equal(startA.statePatch.currentStep, 'deposit_amount');
  assert.match(startA.replies[0].text, /Deposit for payment name: Amy Field/);
  await applyDecision(store, contactId, startA);
  const stateAmount = await store.getAutomationState(contactId);
  assert.equal(stateAmount.current_flow, 'registered_deposit');
  assert.equal(stateAmount.current_step, 'deposit_amount');
  assert.equal(stateAmount.registration_info.deposit_in_progress, true);
  assert.equal(stateAmount.registration_info.deposit_awaiting_payment, false);
  console.log('ok Deposit persists deposit_amount session before amount prompt');

  const amountA = await decideBotReply({ store, contact, messageText: '25' });
  assert.equal(amountA.kind, 'registration_send_payment_qr');
  await applyDecision(store, contactId, amountA);
  const qrA = await handlePaymentRegistrationQr({
    store,
    contact,
    sendPaymentQr: amountA.sendPaymentQr,
    bot: botStub(500)
  });
  assert.equal(qrA.ok, true);
  assert.equal(qrA.windowCreated, true);
  const windowA = qrA.paymentWindow.id;
  assert.equal(qrA.paymentWindow.flow_type, PAYMENT_WINDOW_FLOW.DEPOSIT);
  assert.equal(isEligibleActivePaymentWindow(qrA.paymentWindow), true);
  console.log('ok initial deposit creates attempt A');

  // Force expiry of A
  await store.db.prepare('UPDATE registration_payment_windows SET expires_at = ? WHERE id = ?')
    .run(past, windowA);
  const tick = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async () => ({ queued: true })
  });
  assert.ok(tick.expired >= 1);
  const expiredA = await store.getRegistrationPaymentWindow(windowA);
  assert.equal(expiredA.status, 'expired');
  assert.equal(isEligibleActivePaymentWindow(expiredA), false);
  const afterExpiry = await store.getAutomationState(contactId);
  assert.equal(afterExpiry.current_flow, null);
  assert.equal(afterExpiry.current_step, null);
  assert.equal(afterExpiry.registration_info.deposit_payment_window_id, undefined);
  assert.equal(afterExpiry.registration_info.payment_window_id, undefined);
  console.log('ok attempt A expires and stale session deposit fields are cleared');

  // Soft-expired session stuck at await_payment must restart on Deposit
  const softContact = await createRegisteredContact(store, {
    telegramId: Date.now() + 1,
    now,
    name: 'Soft Expiry'
  });
  const softWin = await store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, expected_payment_cents,
      flow_type, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Soft Expiry', 25, 2500, 'deposit', 'active', ?, ?, ?)
  `).run(softContact.id, String(softContact.telegram_id), method.id, qr.id, past, now, now);
  await store.updateAutomationState(softContact.id, {
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_await_payment',
    registrationInfo: {
      payment_display_name: 'Soft Expiry',
      payment_name: 'Soft Expiry',
      appbeg_player_uid: softContact.appbeg_account_id,
      appbeg_creation_complete: true,
      deposit_in_progress: true,
      deposit_awaiting_payment: true,
      deposit_requested_amount: 25,
      deposit_payment_window_id: softWin.lastInsertRowid,
      payment_window_id: softWin.lastInsertRowid,
      payment_window_expires_at: past
    }
  });
  const softDeposit = await decideBotReply({ store, contact: softContact, action: 'menu:deposit' });
  assert.equal(softDeposit.kind, 'deposit_ask_amount');
  assert.equal(softDeposit.statePatch.currentStep, 'deposit_amount');
  const softWindowRow = await store.getRegistrationPaymentWindow(softWin.lastInsertRowid);
  assert.equal(softWindowRow.status, 'expired');
  console.log('ok Deposit after soft-expiry resets session and marks old window expired');

  // --- Redeposit attempt B for contact A ---
  const startB = await decideBotReply({ store, contact, action: 'menu:deposit' });
  assert.equal(startB.kind, 'deposit_ask_amount');
  assert.equal(startB.statePatch.currentStep, 'deposit_amount');
  await applyDecision(store, contactId, startB);

  const amountB = await decideBotReply({ store, contact, messageText: '40' });
  assert.equal(amountB.kind, 'registration_send_payment_qr');
  assert.equal(amountB.sendPaymentQr.firstDepositAmount, 40);
  await applyDecision(store, contactId, amountB);
  const qrB = await handlePaymentRegistrationQr({
    store,
    contact,
    sendPaymentQr: amountB.sendPaymentQr,
    bot: botStub(600)
  });
  assert.equal(qrB.ok, true);
  assert.equal(qrB.windowCreated, true);
  const windowB = qrB.paymentWindow.id;
  assert.notEqual(windowB, windowA);
  const stillA = await store.getRegistrationPaymentWindow(windowA);
  assert.equal(stillA.status, 'expired');
  assert.equal(qrB.paymentWindow.status, 'active');
  assert.equal(isEligibleActivePaymentWindow(qrB.paymentWindow), true);
  console.log('ok amount after expiry creates attempt B with a new id; A stays expired');

  const activeWindows = await store.db.prepare(`
    SELECT id FROM registration_payment_windows
    WHERE contact_id = ? AND status = 'active' AND flow_type = 'deposit' AND expires_at > ?
  `).all(contactId, new Date().toISOString());
  assert.equal(activeWindows.length, 1);
  assert.equal(Number(activeWindows[0].id), Number(windowB));
  console.log('ok only one active deposit attempt exists');

  // Duplicate amount message while B is active should resume B, not create C
  await store.updateAutomationState(contactId, {
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount',
    registrationInfo: {
      ...(await store.getAutomationState(contactId)).registration_info,
      deposit_in_progress: true,
      deposit_awaiting_payment: false
    }
  });
  const dupAmount = await decideBotReply({ store, contact, messageText: '40' });
  assert.equal(dupAmount.kind, 'deposit_waiting_payment');
  assert.ok(!dupAmount.sendPaymentQr);
  const afterDup = await store.db.prepare(`
    SELECT COUNT(*) AS count FROM registration_payment_windows
    WHERE contact_id = ? AND flow_type = 'deposit'
  `).get(contactId);
  assert.equal(Number(afterDup.count), 2);
  console.log('ok duplicate amount message does not create attempt C');

  // Cancelled attempt must not block redeposit
  const cancelContact = await createRegisteredContact(store, {
    telegramId: Date.now() + 2,
    now,
    name: 'Cancel Case'
  });
  const cancelWin = await store.createRegistrationPaymentWindow({
    contactId: cancelContact.id,
    telegramUserId: cancelContact.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: qr.id,
    paymentDisplayName: 'Cancel Case',
    firstDepositAmount: 15,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
  });
  await store.expireRegistrationPaymentWindow(cancelWin.id, { suppressNotification: true });
  await store.updateAutomationState(cancelContact.id, {
    currentFlow: null,
    currentStep: null,
    registrationInfo: clearStaleDepositSessionFields({
      payment_display_name: 'Cancel Case',
      payment_name: 'Cancel Case',
      appbeg_player_uid: cancelContact.appbeg_account_id,
      appbeg_creation_complete: true,
      deposit_payment_window_id: cancelWin.id
    })
  });
  const afterCancel = await beginRegisteredDeposit(
    store,
    cancelContact,
    (await store.getAutomationState(cancelContact.id)).registration_info
  );
  assert.equal(afterCancel.kind, 'deposit_ask_amount');
  console.log('ok cancelled attempts do not block redeposit');

  // Completed attempt must not block redeposit
  const doneContact = await createRegisteredContact(store, {
    telegramId: Date.now() + 3,
    now,
    name: 'Done Case'
  });
  const doneWinInsert = await store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, expected_payment_cents,
      flow_type, status, expires_at, completed_at, matched_payment_event_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Done Case', 20, 2000, 'deposit', 'completed', ?, ?, 999001, ?, ?)
  `).run(
    doneContact.id,
    String(doneContact.telegram_id),
    method.id,
    qr.id,
    new Date(Date.now() + 60_000).toISOString(),
    now,
    now,
    now
  );
  await store.updateAutomationState(doneContact.id, {
    currentFlow: null,
    currentStep: null,
    registrationInfo: {
      payment_display_name: 'Done Case',
      payment_name: 'Done Case',
      appbeg_player_uid: doneContact.appbeg_account_id,
      appbeg_creation_complete: true,
      last_deposit_window_id: doneWinInsert.lastInsertRowid
    }
  });
  const afterDone = await beginRegisteredDeposit(
    store,
    doneContact,
    (await store.getAutomationState(doneContact.id)).registration_info
  );
  assert.equal(afterDone.kind, 'deposit_ask_amount');
  console.log('ok completed attempts do not block redeposit');

  // Different amount while active must create a new window (never reuse expired/mismatched)
  await applyDecision(store, contactId, {
    statePatch: {
      currentFlow: 'registered_deposit',
      currentStep: 'deposit_amount',
      registrationInfo: {
        ...(await store.getAutomationState(contactId)).registration_info,
        deposit_in_progress: true
      }
    }
  });
  // Ensure B still active
  const stillActiveB = await store.getActiveRegistrationPaymentWindow(contactId, {
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
  });
  assert.equal(Number(stillActiveB.id), Number(windowB));
  const amountDifferent = await decideBotReply({ store, contact, messageText: '55' });
  assert.equal(amountDifferent.kind, 'registration_send_payment_qr');
  await applyDecision(store, contactId, amountDifferent);
  const qrDifferent = await handlePaymentRegistrationQr({
    store,
    contact,
    sendPaymentQr: amountDifferent.sendPaymentQr,
    bot: botStub(700)
  });
  assert.equal(qrDifferent.windowCreated, true);
  assert.notEqual(qrDifferent.paymentWindow.id, windowB);
  const oldB = await store.getRegistrationPaymentWindow(windowB);
  assert.equal(oldB.status, 'expired');
  console.log('ok amount change expires prior active attempt and creates a new matchable window');

  console.log('All expired-redeposit regression checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
