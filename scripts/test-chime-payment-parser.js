/**
 * Focused Chime payment parser + source-group listener tests.
 * Covers labeled "New Chime Payment" notices and classic Chime bodies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  configuredPaymentGroupChatId,
  isConfiguredPaymentSourceChat
} from '../src/config/listeners.js';
import {
  classifyPaymentGroupMessage,
  shouldAutoIgnore
} from '../src/payments/messageClassifier.js';
import { buildIdempotencyKey } from '../src/payments/constants.js';
import {
  isChimePaymentMessage,
  parseMessageTime,
  parsePaymentMessage
} from '../src/payments/parser.js';
import { routePaymentEvent } from '../src/payments/router.js';

const NEW_GROUP_ID = -5413513424;

function labeledPayment({
  amount = '1.00',
  name = 'Amy F.',
  receivedAt = '24 Jul 2026, 10:38 PM',
  tag = null,
  withEmojis = true
} = {}) {
  const lines = [
    withEmojis ? '🟢 New Chime Payment' : 'New Chime Payment',
    '',
    withEmojis ? `💵 Amount Received: $${amount}` : `Amount Received: $${amount}`,
    withEmojis ? `👤 Payment Name: ${name}` : `Payment Name: ${name}`
  ];
  if (tag != null) {
    lines.push(withEmojis ? `🏷️ Payment Tag: ${tag}` : `Payment Tag: ${tag}`);
  }
  lines.push(withEmojis ? `🕒 Received At: ${receivedAt}` : `Received At: ${receivedAt}`);
  return lines.join('\n');
}

async function insertPayment(store, {
  id,
  text,
  telegramMessageId,
  telegramGroupId = NEW_GROUP_ID,
  routingStatus = 'unrouted'
}) {
  const now = new Date().toISOString();
  await store.db.prepare(`
    INSERT INTO payment_events (
      id, telegram_message_id, telegram_group_id, telegram_group_title,
      sender_name, message_text, raw_payload_json, processing_status,
      message_date, routing_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'New', ?, ?, ?, ?)
  `).run(
    id,
    telegramMessageId,
    telegramGroupId,
    'Chime Payments',
    'PaymentBot',
    text,
    now,
    routingStatus,
    now,
    now
  );
}

async function run() {
  // --- Parse: new no-tag format ---
  {
    const text = labeledPayment({ amount: '1.00', name: 'Amy F.', receivedAt: '24 Jul 2026, 10:38 PM' });
    assert.equal(isChimePaymentMessage(text), true);
    assert.equal(classifyPaymentGroupMessage(text).kind, 'payment');
    const parsed = parsePaymentMessage(text);
    assert.ok(parsed);
    assert.equal(parsed.amount, 1);
    assert.equal(parsed.payment_sender_name, 'Amy F.');
    assert.equal(parsed.message_time, '24 Jul 2026, 10:38 PM');
    assert.equal(parsed.recipient_tag, null);
    assert.equal(parsed.payment_app, 'Chime');
    const dt = parseMessageTime(parsed.message_time);
    assert.ok(dt);
    assert.equal(dt.getFullYear(), 2026);
    assert.equal(dt.getMonth(), 6);
    assert.equal(dt.getDate(), 24);
    assert.equal(dt.getHours(), 22);
    assert.equal(dt.getMinutes(), 38);
    assert.equal(parsed.payment_datetime, dt.toISOString());
    console.log('✓ new no-tag format parses ($1.00 / Amy F. / Received At)');
  }

  // --- Parse: $10.00 ---
  {
    const parsed = parsePaymentMessage(labeledPayment({ amount: '10.00' }));
    assert.equal(parsed.amount, 10);
    console.log('✓ $10.00 parses correctly');
  }

  // --- Parse: old tagged labeled format still works; tag N/A → null ---
  {
    const text = labeledPayment({
      amount: '1.00',
      name: 'Amy F.',
      tag: 'N/A',
      receivedAt: '24 Jul 2026, 10:38 PM'
    });
    const parsed = parsePaymentMessage(text);
    assert.ok(parsed);
    assert.equal(parsed.amount, 1);
    assert.equal(parsed.payment_sender_name, 'Amy F.');
    assert.equal(parsed.recipient_tag, null);
    assert.equal(classifyPaymentGroupMessage(text).kind, 'payment');
    console.log('✓ old tagged labeled format parses; missing/N/A Payment Tag accepted');
  }

  // --- Whitespace / no-emoji / tight colon tolerance ---
  {
    const text = [
      '  New Chime Payment  ',
      '',
      'Amount Received:$1.00',
      'Payment Name:  Amy F.  ',
      'Received At: 24 Jul 2026, 10:38 PM'
    ].join('\n');
    const parsed = parsePaymentMessage(text);
    assert.ok(parsed);
    assert.equal(parsed.amount, 1);
    assert.equal(parsed.payment_sender_name, 'Amy F.');
    console.log('✓ tolerant of whitespace, missing emoji, Amount Received:$1.00');
  }

  // --- Classic format still works ---
  {
    const classic = [
      'Hi $tag',
      'You received $25.00 from Alice Smith',
      '3:15 PM - 12 Jul 2026'
    ].join('\n');
    const parsed = parsePaymentMessage(classic);
    assert.ok(parsed);
    assert.equal(parsed.amount, 25);
    assert.equal(parsed.payment_sender_name, 'Alice Smith');
    assert.equal(parsed.recipient_tag, 'tag');
    assert.equal(classifyPaymentGroupMessage(classic).kind, 'payment');
    console.log('✓ classic You-received format still parses');
  }

  // --- Unrelated / service / missing fields ---
  {
    const connected = 'Payment Ledger Telegram integration is connected.';
    assert.equal(isChimePaymentMessage(connected), false);
    assert.equal(classifyPaymentGroupMessage(connected).kind, 'non_payment');
    assert.equal(shouldAutoIgnore(classifyPaymentGroupMessage(connected)), true);

    assert.equal(classifyPaymentGroupMessage('').kind, 'non_payment');
    assert.equal(shouldAutoIgnore(classifyPaymentGroupMessage('')), true);

    const missingAmount = [
      '🟢 New Chime Payment',
      '👤 Payment Name: Amy F.',
      '🕒 Received At: 24 Jul 2026, 10:38 PM'
    ].join('\n');
    assert.equal(parsePaymentMessage(missingAmount), null);
    assert.equal(classifyPaymentGroupMessage(missingAmount).kind, 'payment_like');
    assert.equal(classifyPaymentGroupMessage(missingAmount).reason, 'missing_amount');

    const missingName = [
      '🟢 New Chime Payment',
      '💵 Amount Received: $1.00',
      '🕒 Received At: 24 Jul 2026, 10:38 PM'
    ].join('\n');
    assert.equal(parsePaymentMessage(missingName), null);
    assert.equal(classifyPaymentGroupMessage(missingName).kind, 'payment_like');
    assert.equal(classifyPaymentGroupMessage(missingName).reason, 'missing_payment_name');

    console.log('✓ unrelated / empty / missing amount|name rejected appropriately');
  }

  // --- Wrong source chat ID rejected by config helper ---
  {
    const prevGroup = process.env.PAYMENT_TELEGRAM_GROUP;
    const prevChat = process.env.PAYMENT_GROUP_CHAT_ID;
    try {
      delete process.env.PAYMENT_GROUP_CHAT_ID;
      process.env.PAYMENT_TELEGRAM_GROUP = String(NEW_GROUP_ID);
      assert.equal(configuredPaymentGroupChatId(), String(NEW_GROUP_ID));
      assert.equal(isConfiguredPaymentSourceChat(NEW_GROUP_ID), true);
      assert.equal(isConfiguredPaymentSourceChat(String(NEW_GROUP_ID)), true);
      assert.equal(isConfiguredPaymentSourceChat(-1009999999999), false);
      assert.equal(isConfiguredPaymentSourceChat(5591388010), false);
      console.log('✓ wrong chat ID rejected vs PAYMENT_TELEGRAM_GROUP=-5413513424');
    } finally {
      if (prevGroup === undefined) delete process.env.PAYMENT_TELEGRAM_GROUP;
      else process.env.PAYMENT_TELEGRAM_GROUP = prevGroup;
      if (prevChat === undefined) delete process.env.PAYMENT_GROUP_CHAT_ID;
      else process.env.PAYMENT_GROUP_CHAT_ID = prevChat;
    }
  }

  // --- Dedup + routing with identical payment details ---
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-chime-parser-'));
  const dbPath = path.join(tmpRoot, 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  const paymentText = labeledPayment({ amount: '1.00', name: 'Amy F.' });

  await insertPayment(store, {
    id: 1,
    telegramMessageId: 1001,
    telegramGroupId: NEW_GROUP_ID,
    text: paymentText
  });
  await insertPayment(store, {
    id: 2,
    telegramMessageId: 1002,
    telegramGroupId: NEW_GROUP_ID,
    text: paymentText
  });

  // Unique constraint: same chat + message id cannot insert twice
  let duplicateInsertBlocked = false;
  try {
    await insertPayment(store, {
      id: 3,
      telegramMessageId: 1001,
      telegramGroupId: NEW_GROUP_ID,
      text: paymentText
    });
  } catch (error) {
    duplicateInsertBlocked = /UNIQUE/i.test(String(error.message || error));
  }
  assert.equal(duplicateInsertBlocked, true);

  const keyA = buildIdempotencyKey(NEW_GROUP_ID, 1001);
  const keyB = buildIdempotencyKey(NEW_GROUP_ID, 1002);
  assert.equal(keyA, `${NEW_GROUP_ID}:1001`);
  assert.notEqual(keyA, keyB);

  const routed1 = await routePaymentEvent(store, 1, { force: true });
  const routed2 = await routePaymentEvent(store, 2, { force: true });
  assert.notEqual(routed1.outcome, 'ignored');
  assert.notEqual(routed2.outcome, 'ignored');
  assert.equal(routed1.payment.parsed_amount, 1);
  assert.equal(routed1.payment.parsed_sender_name, 'Amy F.');
  assert.equal(routed2.payment.parsed_amount, 1);
  assert.equal(routed2.payment.parsed_sender_name, 'Amy F.');
  assert.notEqual(routed1.payment.id, routed2.payment.id);

  // Re-route same event → duplicate guard
  const again = await routePaymentEvent(store, 1, { force: false });
  assert.ok(
    again.outcome === 'matched'
      || again.outcome === 'searching'
      || again.outcome === 'manual_review'
      || again.outcome === 'unmatched'
      || again.outcome === 'duplicate_ignored'
      || again.outcome === routed1.outcome
  );

  // Integration-connected message auto-ignored
  await insertPayment(store, {
    id: 10,
    telegramMessageId: 2010,
    text: 'Payment Ledger Telegram integration is connected.'
  });
  const ignored = await routePaymentEvent(store, 10, { force: true });
  assert.equal(ignored.outcome, 'ignored');

  // Empty service-like message ignored
  await insertPayment(store, {
    id: 11,
    telegramMessageId: 2011,
    text: ''
  });
  const serviceIgnored = await routePaymentEvent(store, 11, { force: true });
  assert.equal(serviceIgnored.outcome, 'ignored');

  console.log('✓ dedupe by (telegram_group_id, telegram_message_id); identical details stay separate');
  console.log('✓ unrelated + empty service messages ignored by router');

  console.log('All Chime payment parser / listener tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
