/**
 * Payment freeze worker + freeze_at backfill tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { computePaymentFreezeAt, ROUTING_STATUS, UNMATCHED_REASON } from '../src/payments/constants.js';
import { processPaymentFreezeTick, startPaymentFreezeWorker } from '../src/payments/paymentFreezeWorker.js';
import { remainingSecondsUntil, formatFreezeCountdown, deriveMatchingStatus, MATCHING_STATUS } from '../public/paymentStatus.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-payment-freeze-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');

async function insertPayment(store, {
  id,
  routingStatus = 'searching',
  messageDate = new Date().toISOString(),
  freezeAt = null,
  unmatchedReason = null,
  windowId = null,
  processingStatus = 'Parsed',
  parsedAmount = 9,
  parsedSenderName = 'Amy Fei',
  parsedPaymentApp = 'Chime'
}) {
  const now = new Date().toISOString();
  await store.db.prepare(`
    INSERT INTO payment_events (
      id, telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      message_date, freeze_at, unmatched_reason, registration_payment_window_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    1000 + id,
    -100,
    'Payments',
    'You received $9 from Amy Fei',
    processingStatus,
    routingStatus,
    parsedAmount,
    parsedSenderName,
    parsedPaymentApp,
    messageDate,
    freezeAt,
    unmatchedReason,
    windowId,
    now,
    now
  );
}

async function run() {
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  const now = new Date('2026-07-12T15:00:00.000Z');

  // New payment gets freeze_at = received + 15 minutes
  {
    const received = new Date('2026-07-12T14:55:00.000Z').toISOString();
    const expected = computePaymentFreezeAt(received);
    await insertPayment(store, { id: 1, routingStatus: 'unrouted', messageDate: received, freezeAt: null });
    const ensured = await store.ensurePaymentSearchDeadline(1, { receivedAt: received });
    assert.equal(ensured.freeze_at, expected);
    assert.ok(ensured.matching_status === 'searching' || ensured.routing_status === 'unrouted');
    console.log('✓ new payment gets freeze_at = received_at + 15 minutes');
  }

  // Searching before deadline stays searching
  {
    const received = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
    const freezeAt = computePaymentFreezeAt(received);
    await insertPayment(store, { id: 2, routingStatus: 'searching', messageDate: received, freezeAt });
    const result = await store.freezeOverdueSearchingPayments({ now });
    const still = await store.getPaymentEvent(2);
    assert.equal(still.routing_status, 'searching');
    assert.ok(!result.frozen.some((p) => Number(p.id) === 2));
    console.log('✓ searching payment before deadline stays searching');
  }

  // Overdue searching becomes frozen
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    const freezeAt = computePaymentFreezeAt(received);
    await insertPayment(store, { id: 3, routingStatus: 'searching', messageDate: received, freezeAt });
    const result = await store.freezeOverdueSearchingPayments({ now });
    assert.ok(result.frozen.some((p) => Number(p.id) === 3));
    const frozen = await store.getPaymentEvent(3);
    assert.equal(frozen.routing_status, ROUTING_STATUS.FROZEN);
    assert.ok(frozen.frozen_at);
    assert.equal(frozen.unmatched_reason, UNMATCHED_REASON.NO_ACTIVE_WINDOW);
    assert.equal(frozen.matching_status, 'frozen');
    console.log('✓ overdue searching payment becomes frozen');
  }

  // Old searching with null freeze_at is backfilled then frozen if overdue
  {
    const received = new Date('2026-07-08T10:00:00.000Z').toISOString();
    await insertPayment(store, { id: 4, routingStatus: 'searching', messageDate: received, freezeAt: null });
    const result = await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(4);
    assert.ok(payment.freeze_at);
    assert.equal(payment.freeze_at, computePaymentFreezeAt(received));
    assert.equal(payment.routing_status, ROUTING_STATUS.FROZEN);
    assert.ok(result.backfilled >= 1);
    console.log('✓ old searching payment with null freeze_at is backfilled and frozen');
  }

  // Empty-string freeze_at is treated as missing and healed to a real timestamp
  {
    const received = new Date('2026-07-08T11:00:00.000Z').toISOString();
    await insertPayment(store, { id: 44, routingStatus: 'searching', messageDate: received, freezeAt: '' });
    const result = await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(44);
    assert.equal(payment.freeze_at, computePaymentFreezeAt(received));
    assert.equal(payment.routing_status, ROUTING_STATUS.FROZEN);
    assert.ok(result.backfilled >= 1);
    console.log('ok empty freeze_at is stored/healed as a missing timestamp');
  }

  // Routing updates normalize empty timestamp strings to NULL
  {
    await insertPayment(store, { id: 45, routingStatus: 'searching', freezeAt: computePaymentFreezeAt(now) });
    await store.updatePaymentRouting(45, { freeze_at: '', frozen_at: '', matched_at: '', routed_at: '' });
    const payment = await store.getPaymentEvent(45);
    assert.equal(payment.freeze_at, null);
    assert.equal(payment.frozen_at, null);
    assert.equal(payment.matched_at, null);
    assert.equal(payment.routed_at, null);
    console.log('ok empty routing timestamp updates are normalized to NULL');
  }

  // Overdue unparsed searching gets a deadline but does not freeze via background scan
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 46,
      routingStatus: 'searching',
      messageDate: received,
      freezeAt: null,
      processingStatus: 'New',
      parsedAmount: null,
      parsedSenderName: null,
      parsedPaymentApp: null
    });
    const result = await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(46);
    assert.equal(payment.freeze_at, computePaymentFreezeAt(received));
    assert.equal(payment.routing_status, 'searching');
    assert.equal(payment.processing_status, 'New');
    assert.ok(!result.frozen.some((p) => Number(p.id) === 46));

    const tick = await processPaymentFreezeTick({ store, io: null, now });
    const afterTick = await store.getPaymentEvent(46);
    assert.equal(afterTick.routing_status, 'searching');
    assert.ok(!tick.frozen.some((p) => Number(p.id) === 46));
    console.log('ok overdue unparsed payment is backfilled but not frozen by background scan');
  }

  // Same overdue payment can freeze after a valid parse result is populated
  {
    await store.db.prepare(`
      UPDATE payment_events
      SET processing_status = 'Parsed',
          parsed_amount = 9,
          parsed_sender_name = 'Amy Fei',
          parsed_payment_app = 'Chime',
          updated_at = ?
      WHERE id = 46
    `).run(new Date().toISOString());
    const result = await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(46);
    assert.ok(result.frozen.some((p) => Number(p.id) === 46));
    assert.equal(payment.routing_status, ROUTING_STATUS.FROZEN);
    assert.equal(payment.processing_status, 'Parsed');
    console.log('ok overdue payment freezes after valid parse fields are populated');
  }

  // Parsed status without complete parse fields still does not freeze
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 47,
      routingStatus: 'unrouted',
      messageDate: received,
      freezeAt: computePaymentFreezeAt(received),
      processingStatus: 'Parsed',
      parsedAmount: null,
      parsedSenderName: null,
      parsedPaymentApp: null
    });
    const result = await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(47);
    assert.equal(payment.routing_status, 'unrouted');
    assert.ok(!result.frozen.some((p) => Number(p.id) === 47));
    console.log('ok parsed status without parse fields is not frozen');
  }

  // Matched never freezes
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 5,
      routingStatus: 'registration_payment_matched',
      messageDate: received,
      freezeAt: computePaymentFreezeAt(received),
      windowId: 99
    });
    await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(5);
    assert.equal(payment.routing_status, 'registration_payment_matched');
    console.log('✓ matched payment never freezes');
  }

  // Manual review never freezes via worker
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 6,
      routingStatus: 'manual_review',
      messageDate: received,
      freezeAt: computePaymentFreezeAt(received),
      unmatchedReason: 'ambiguous_match'
    });
    await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(6);
    assert.equal(payment.routing_status, 'manual_review');
    console.log('✓ manual-review payment never freezes');
  }

  // Completed never freezes
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 7,
      routingStatus: 'deposit_window_matched',
      messageDate: received,
      freezeAt: computePaymentFreezeAt(received),
      windowId: 100
    });
    await store.db.prepare(`UPDATE payment_events SET processing_status = 'Completed' WHERE id = 7`).run();
    await store.freezeOverdueSearchingPayments({ now });
    const payment = await store.getPaymentEvent(7);
    assert.equal(payment.routing_status, 'deposit_window_matched');
    assert.equal(payment.matching_status, 'completed');
    console.log('✓ completed payment never freezes');
  }

  // Idempotent duplicate freeze scans
  {
    const again = await store.freezeOverdueSearchingPayments({ now });
    assert.equal(again.count, 0);
    console.log('✓ duplicate freeze scans are idempotent');
  }

  // Startup tick freezes overdue
  {
    const received = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await insertPayment(store, {
      id: 8,
      routingStatus: 'searching',
      messageDate: received,
      freezeAt: computePaymentFreezeAt(received)
    });
    const tick = await processPaymentFreezeTick({ store, io: null, now });
    assert.ok(tick.count >= 1);
    const payment = await store.getPaymentEvent(8);
    assert.equal(payment.routing_status, 'frozen');
    console.log('✓ startup scan catches overdue payments');
  }

  // API list includes freeze_at for searching
  {
    const received = new Date(Date.now() - 60 * 1000).toISOString();
    const freezeAt = computePaymentFreezeAt(received);
    await insertPayment(store, { id: 9, routingStatus: 'searching', messageDate: received, freezeAt });
    const payments = await store.listPaymentEvents({ matchingStatus: 'searching', limit: 50 });
    const row = payments.find((p) => Number(p.id) === 9);
    assert.ok(row);
    assert.equal(row.freeze_at, freezeAt);
    assert.ok(row.server_now);
    assert.equal(typeof row.remaining_seconds, 'number');
    console.log('✓ searching payment includes freeze_at in list API fields');
  }

  // Stats succeed
  {
    const stats = await store.getPaymentStats();
    assert.ok(typeof stats.waiting === 'number');
    assert.ok(typeof stats.frozen === 'number');
    console.log('✓ payment stats endpoint succeeds');
  }

  // API list heals missing freeze_at for Waiting rows
  {
    const received = new Date(now.getTime() - 90 * 1000).toISOString();
    await insertPayment(store, { id: 10, routingStatus: 'unrouted', messageDate: received, freezeAt: null });
    const payments = await store.listPaymentEvents({ limit: 50 });
    const row = payments.find((p) => Number(p.id) === 10);
    assert.ok(row, 'payment 10 listed');
    assert.ok(row.freeze_at, 'freeze_at healed on list');
    assert.equal(row.freeze_at, computePaymentFreezeAt(received));
    assert.ok(row.matching_status === 'searching' || row.matching_status === 'frozen');
    console.log('✓ listPaymentEvents heals missing freeze_at');
  }

  // Frontend countdown helpers
  {
    const freezeAt = new Date(now.getTime() + 299000).toISOString();
    const remaining = remainingSecondsUntil(freezeAt, now.getTime());
    assert.equal(formatFreezeCountdown(remaining), '04:59');
    assert.equal(formatFreezeCountdown(remainingSecondsUntil(freezeAt, now.getTime() + 1000)), '04:58');
    assert.equal(
      deriveMatchingStatus({ routing_status: 'searching', freeze_at: freezeAt }, now.getTime() + 300000),
      MATCHING_STATUS.FROZEN
    );
    assert.equal(formatFreezeCountdown(null), null);
    console.log('✓ frontend countdown format and zero→Frozen display helper');
  }

  // Worker start/stop
  {
    const worker = startPaymentFreezeWorker({ store, io: null, pollMs: 60000 });
    await worker.stop();
    console.log('✓ freeze worker starts and stops cleanly');
  }

  console.log('\nAll payment-freeze tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
