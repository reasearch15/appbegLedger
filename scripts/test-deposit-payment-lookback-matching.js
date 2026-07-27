import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import {
  computePaymentFreezeAt,
  PAYMENT_WINDOW_FLOW,
  ROUTING_STATUS,
  UNMATCHED_REASON
} from '../src/payments/constants.js';
import { matchEligiblePaymentsForWindow, routePaymentEvent } from '../src/payments/router.js';

function paymentText(name = 'Amy Field', amount = 5) {
  return [
    `You received $${amount.toFixed(2)} from ${name}`,
    '9:10 PM - 27 Jul 2026'
  ].join('\n');
}

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-deposit-lookback-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 'test.sqlite') });
  store.__dir = dir;
  store.__credits = [];
  store.creditRegisteredDeposit = async (payload) => {
    store.__credits.push(payload);
    return { ok: true, status: 'credited' };
  };
  store.getAutoRegistrationBotSettings = async () => ({ enabled: false });
  return store;
}

async function closeStore(store) {
  store.db?.close?.();
  await fs.rm(store.__dir, { recursive: true, force: true });
}

async function makeContact(store, suffix = '') {
  const contact = await store.upsertTelegramUser({
    id: Number(`7700${suffix || '1'}`),
    first_name: 'Amy',
    last_name: `Field${suffix}`,
    username: `amy_field_${suffix || 'base'}`,
    is_bot: false
  });
  await store.updateAutomationState(contact.id, {
    currentFlow: 'registered_deposit',
    currentStep: 'waiting_for_payment',
    registrationInfo: {
      appbeg_player_uid: `player_${contact.id}`,
      deposit_in_progress: true,
      deposit_awaiting_payment: true
    }
  });
  return contact;
}

async function makeWindow(store, contact, overrides = {}) {
  const window = await store.createRegistrationPaymentWindow({
    contactId: contact.id,
    telegramUserId: contact.telegram_id,
    paymentMethodId: null,
    paymentDisplayName: overrides.paymentDisplayName || 'Amy Field',
    firstDepositAmount: overrides.amount ?? 5,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    windowMinutes: 7
  });
  if (overrides.expiresAt) {
    await store.db.prepare('UPDATE registration_payment_windows SET expires_at = ? WHERE id = ?')
      .run(overrides.expiresAt, window.id);
    return store.getRegistrationPaymentWindow(window.id);
  }
  return window;
}

async function makePayment(store, {
  id = null,
  name = 'Amy Field',
  amount = 5,
  minutesAgo = 1,
  status = ROUTING_STATUS.SEARCHING,
  parsed = true,
  registrationPaymentWindowId = null
} = {}) {
  const received = new Date(Date.now() - minutesAgo * 60 * 1000);
  const result = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, sender_name, message_text, raw_payload_json,
      processing_status, parsed_amount, parsed_sender_name, parsed_payment_app,
      routing_status, registration_payment_window_id, message_date, freeze_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id || Math.floor(Math.random() * 1000000),
    -100100,
    name,
    paymentText(name, amount),
    '{}',
    parsed ? 'Parsed' : 'New',
    parsed ? amount : null,
    parsed ? name : null,
    parsed ? 'Chime' : null,
    status,
    registrationPaymentWindowId,
    received.toISOString(),
    computePaymentFreezeAt(received),
    received.toISOString(),
    received.toISOString()
  );
  return store.getPaymentEvent(result.lastInsertRowid);
}

async function testPaymentFirstMatchesLaterDeposit() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '11');
    const payment = await makePayment(store, { minutesAgo: 6 });
    const window = await makeWindow(store, contact);
    const result = await matchEligiblePaymentsForWindow(store, window.id);
    assert.equal(result.outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    const matchedPayment = await store.getPaymentEvent(payment.id);
    const matchedWindow = await store.getRegistrationPaymentWindow(window.id);
    const state = await store.getAutomationState(contact.id);
    assert.equal(Number(matchedPayment.registration_payment_window_id), Number(window.id));
    assert.equal(matchedWindow.status, 'matched');
    assert.equal(state.current_flow, null);
    assert.equal(state.registration_info.deposit_in_progress, undefined);
    assert.equal(store.__credits.length, 1);
  } finally {
    await closeStore(store);
  }
}

async function testDepositFirstMatchesIncomingPayment() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '12');
    const window = await makeWindow(store, contact);
    const payment = await makePayment(store, { status: ROUTING_STATUS.UNROUTED, parsed: false, minutesAgo: 0 });
    const result = await routePaymentEvent(store, payment.id);
    assert.equal(result.outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    assert.equal((await store.getRegistrationPaymentWindow(window.id)).status, 'matched');
    assert.equal(store.__credits.length, 1);
  } finally {
    await closeStore(store);
  }
}

async function testOutsideLookbackDoesNotMatch() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '13');
    await makePayment(store, { minutesAgo: 20 });
    const window = await makeWindow(store, contact);
    const result = await matchEligiblePaymentsForWindow(store, window.id);
    assert.equal(result.outcome, 'no_eligible_payment');
    assert.equal((await store.getRegistrationPaymentWindow(window.id)).status, 'active');
    assert.equal(store.__credits.length, 0);
  } finally {
    await closeStore(store);
  }
}

async function testAlreadyMatchedCannotBeReused() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '14');
    const firstWindow = await makeWindow(store, contact);
    const payment = await makePayment(store);
    assert.equal((await matchEligiblePaymentsForWindow(store, firstWindow.id)).outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    const secondWindow = await makeWindow(store, contact);
    const second = await matchEligiblePaymentsForWindow(store, secondWindow.id);
    assert.equal(second.outcome, 'no_eligible_payment');
    assert.equal(Number((await store.getPaymentEvent(payment.id)).registration_payment_window_id), Number(firstWindow.id));
    assert.equal(store.__credits.length, 1);
  } finally {
    await closeStore(store);
  }
}

async function testTwoDepositsCompeteForOnePayment() {
  const store = await makeStore();
  try {
    const contactA = await makeContact(store, '15');
    const contactB = await makeContact(store, '16');
    await makePayment(store);
    const windowA = await makeWindow(store, contactA);
    const windowB = await makeWindow(store, contactB);
    assert.equal((await matchEligiblePaymentsForWindow(store, windowA.id)).outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    assert.equal((await matchEligiblePaymentsForWindow(store, windowB.id)).outcome, 'no_eligible_payment');
    assert.equal((await store.getRegistrationPaymentWindow(windowA.id)).status, 'matched');
    assert.equal((await store.getRegistrationPaymentWindow(windowB.id)).status, 'active');
    assert.equal(store.__credits.length, 1);
  } finally {
    await closeStore(store);
  }
}

async function testIdenticalPaymentsGoManualReview() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '17');
    const first = await makePayment(store, { id: 701001 });
    const second = await makePayment(store, { id: 701002 });
    const window = await makeWindow(store, contact);
    const result = await matchEligiblePaymentsForWindow(store, window.id);
    assert.equal(result.outcome, ROUTING_STATUS.MANUAL_REVIEW);
    assert.equal((await store.getRegistrationPaymentWindow(window.id)).status, 'manual_review');
    assert.equal(store.__credits.length, 0);
    assert.equal((await store.getPaymentEvent(first.id)).unmatched_reason, UNMATCHED_REASON.AMBIGUOUS_MATCH);
    assert.equal((await store.getPaymentEvent(second.id)).unmatched_reason, UNMATCHED_REASON.AMBIGUOUS_MATCH);
  } finally {
    await closeStore(store);
  }
}

async function testExpiryCannotExpireMatchedWindow() {
  const store = await makeStore();
  try {
    const contact = await makeContact(store, '18');
    await makePayment(store);
    const window = await makeWindow(store, contact);
    await matchEligiblePaymentsForWindow(store, window.id);
    await store.db.prepare('UPDATE registration_payment_windows SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), window.id);
    const expired = await store.expireRegistrationPaymentWindowIfDue(window.id);
    assert.equal(expired, null);
    assert.equal((await store.getRegistrationPaymentWindow(window.id)).status, 'matched');
  } finally {
    await closeStore(store);
  }
}

await testPaymentFirstMatchesLaterDeposit();
await testDepositFirstMatchesIncomingPayment();
await testOutsideLookbackDoesNotMatch();
await testAlreadyMatchedCannotBeReused();
await testTwoDepositsCompeteForOnePayment();
await testIdenticalPaymentsGoManualReview();
await testExpiryCannotExpireMatchedWindow();
console.log('ok deposit payment lookback matching regressions');
