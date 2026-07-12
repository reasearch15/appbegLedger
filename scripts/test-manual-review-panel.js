/**
 * Manual Review panel separation + message classification tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { routePaymentEvent } from '../src/payments/router.js';
import {
  classifyPaymentGroupMessage,
  manualReviewReasonLabel,
  shouldAutoIgnore
} from '../src/payments/messageClassifier.js';
import { MATCHING_STATUS, deriveMatchingStatus } from '../src/payments/constants.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-manual-review-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');

async function insertRaw(store, {
  id,
  text,
  routingStatus = 'unrouted',
  unmatchedReason = null,
  freezeAt = null
}) {
  const now = new Date().toISOString();
  await store.db.prepare(`
    INSERT INTO payment_events (
      id, telegram_message_id, telegram_group_id, telegram_group_title,
      sender_name, message_text, raw_payload_json, processing_status,
      message_date, freeze_at, routing_status, unmatched_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'New', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    9000 + id,
    -1001,
    'Payments Group',
    'Sender',
    text,
    now,
    freezeAt,
    routingStatus,
    unmatchedReason,
    now,
    now
  );
}

async function run() {
  // Classifier unit checks
  assert.equal(classifyPaymentGroupMessage('!').kind, 'non_payment');
  assert.equal(classifyPaymentGroupMessage('/OUT 40').kind, 'cashout');
  assert.equal(classifyPaymentGroupMessage('This one too.').kind, 'non_payment');
  assert.equal(shouldAutoIgnore(classifyPaymentGroupMessage('/OUT 40')), true);
  assert.equal(
    manualReviewReasonLabel('ambiguous_match'),
    'Multiple active matching windows'
  );
  assert.equal(
    manualReviewReasonLabel('cashout_message'),
    'Cashout message detected'
  );

  const chime = [
    'Hi $tag',
    'You received $25.00 from Alice Smith',
    '3:15 PM - 12 Jul 2026'
  ].join('\n');
  assert.equal(classifyPaymentGroupMessage(chime).kind, 'payment');

  process.env.DATABASE_PATH = dbPath;
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  // Seed rows
  await insertRaw(store, { id: 1, text: '!', routingStatus: 'parse_failed', unmatchedReason: 'non_payment_message' });
  await insertRaw(store, { id: 2, text: '/OUT 40', routingStatus: 'parse_failed' });
  await insertRaw(store, {
    id: 3,
    text: chime,
    routingStatus: 'searching',
    freezeAt: new Date(Date.now() + 60_000).toISOString()
  });
  await insertRaw(store, {
    id: 4,
    text: chime,
    routingStatus: 'manual_review',
    unmatchedReason: 'ambiguous_match'
  });
  await insertRaw(store, {
    id: 5,
    text: 'You received $10 from Bob',
    routingStatus: 'parse_failed',
    unmatchedReason: 'malformed_payment_message'
  });

  // Route cashout / chatter → ignored (not manual review)
  {
    await insertRaw(store, { id: 10, text: '/OUT 40', routingStatus: 'unrouted' });
    const result = await routePaymentEvent(store, 10, { force: true });
    assert.equal(result.outcome, 'ignored');
    assert.equal(result.payment.matching_status, MATCHING_STATUS.IGNORED);
  }
  {
    await insertRaw(store, { id: 11, text: '!', routingStatus: 'unrouted' });
    const result = await routePaymentEvent(store, 11, { force: true });
    assert.equal(result.outcome, 'ignored');
  }

  // Payments queue excludes manual_review / parse_failed
  {
    const payments = await store.listPaymentEvents({ queue: 'payments', matchingStatus: 'All', limit: 100 });
    assert.ok(payments.every((p) => p.matching_status !== MATCHING_STATUS.MANUAL_REVIEW));
    assert.ok(payments.every((p) => p.matching_status !== MATCHING_STATUS.IGNORED));
    assert.ok(payments.some((p) => Number(p.id) === 3));
    assert.ok(!payments.some((p) => Number(p.id) === 4));
    assert.ok(!payments.some((p) => Number(p.id) === 5));
    console.log('✓ Payments All excludes manual_review rows');
  }

  // Manual Review queue includes ambiguous + malformed only (not ignored cashout)
  {
    const reviews = await store.listPaymentEvents({ queue: 'manual_review', reviewFilter: 'All', limit: 100 });
    assert.ok(reviews.every((p) => p.matching_status === MATCHING_STATUS.MANUAL_REVIEW));
    assert.ok(reviews.some((p) => Number(p.id) === 4));
    assert.ok(reviews.some((p) => Number(p.id) === 5));
    assert.ok(!reviews.some((p) => Number(p.id) === 10));
    assert.ok(!reviews.some((p) => Number(p.id) === 11));
    console.log('✓ Manual Review includes only review rows');
  }

  // Ambiguous filter
  {
    const reviews = await store.listPaymentEvents({
      queue: 'manual_review',
      reviewFilter: 'ambiguous',
      limit: 100
    });
    assert.ok(reviews.every((p) => p.unmatched_reason === 'ambiguous_match'));
    console.log('✓ Ambiguous filter works');
  }

  // Stats
  {
    const paymentStats = await store.getPaymentStats();
    const reviewStats = await store.getManualReviewStats();
    assert.ok(Number(paymentStats.waiting) >= 1);
    assert.ok(Number(reviewStats.unresolved) >= 1);
    assert.ok(Number(reviewStats.ambiguous) >= 1);
    console.log('✓ Payment and Manual Review stats separate');
  }

  // Ignore idempotent + audit
  {
    const first = await store.markPaymentIgnored(5, { staffName: 'Tester' });
    assert.equal(first.routing_status, 'ignored');
    const second = await store.markPaymentIgnored(5, { staffName: 'Tester' });
    assert.equal(second.routing_status, 'ignored');
    const logs = await store.listPaymentRoutingLogs(5, 20);
    assert.ok(logs.some((l) => String(l.step || l.event_type || '').includes('ignored')));
    console.log('✓ Ignore is idempotent and audited');
  }

  // Staff freeze from MR
  {
    await insertRaw(store, {
      id: 20,
      text: chime,
      routingStatus: 'manual_review',
      unmatchedReason: 'ambiguous_match'
    });
    const frozen = await store.markPaymentFrozenByStaff(20, { staffName: 'Tester' });
    assert.equal(frozen.routing_status, 'frozen');
    assert.equal(deriveMatchingStatus(frozen), MATCHING_STATUS.FROZEN);
    const payments = await store.listPaymentEvents({ queue: 'payments', matchingStatus: 'frozen', limit: 100 });
    assert.ok(payments.some((p) => Number(p.id) === 20));
    const reviews = await store.listPaymentEvents({ queue: 'manual_review', limit: 100 });
    assert.ok(!reviews.some((p) => Number(p.id) === 20));
    console.log('✓ Resolved review moves to Frozen on Payments');
  }

  console.log('\nAll manual-review separation tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
