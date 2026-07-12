/**
 * Staff-facing payment matching status derivation + countdown helpers.
 */
import assert from 'node:assert/strict';
import {
  MATCHING_STATUS,
  deriveMatchingStatus,
  remainingSecondsUntil,
  enrichPaymentQueueFields,
  matchingStatusLabel,
  MATCHING_STATUS_SORT_PRIORITY
} from '../src/payments/constants.js';
import {
  formatFreezeCountdown,
  renderPaymentStatusCell,
  resolvePaymentFreezeAt
} from '../public/paymentStatus.js';
import {
  shouldShowPaymentTopScrollbar,
  syncScrollPair
} from '../public/paymentTableScroll.js';

function run() {
  const now = new Date('2026-07-12T12:00:00.000Z');

  // Waiting / searching
  const waiting = enrichPaymentQueueFields({
    routing_status: 'searching',
    freeze_at: '2026-07-12T12:04:38.000Z',
    processing_status: 'Parsed'
  }, now);
  assert.equal(waiting.matching_status, MATCHING_STATUS.SEARCHING);
  assert.equal(waiting.remaining_seconds, 278); // 04:38
  assert.equal(matchingStatusLabel(waiting.matching_status), 'Waiting');
  assert.equal(waiting.freeze_at, '2026-07-12T12:04:38.000Z');
  assert.equal(formatFreezeCountdown(waiting.remaining_seconds), '04:38');

  // Countdown hits zero → Frozen (client/source-of-truth hybrid)
  const expiredSearch = deriveMatchingStatus({
    routing_status: 'searching',
    freeze_at: '2026-07-12T11:59:00.000Z'
  }, now);
  assert.equal(expiredSearch, MATCHING_STATUS.FROZEN);

  // Matched registration
  assert.equal(deriveMatchingStatus({
    routing_status: 'registration_payment_matched',
    processing_status: 'Matched'
  }, now), MATCHING_STATUS.MATCHED);

  // Completed deposit
  assert.equal(deriveMatchingStatus({
    routing_status: 'deposit_window_matched',
    processing_status: 'Completed'
  }, now), MATCHING_STATUS.COMPLETED);

  // Frozen after timeout
  assert.equal(deriveMatchingStatus({
    routing_status: 'frozen',
    unmatched_reason: 'no_active_window'
  }, now), MATCHING_STATUS.FROZEN);

  // Legacy manual_review without ambiguous → Frozen
  assert.equal(deriveMatchingStatus({
    routing_status: 'manual_review',
    unmatched_reason: 'no_active_window'
  }, now), MATCHING_STATUS.FROZEN);

  // Ambiguous → Manual Review
  assert.equal(deriveMatchingStatus({
    routing_status: 'manual_review',
    unmatched_reason: 'ambiguous_match'
  }, now), MATCHING_STATUS.MANUAL_REVIEW);

  // Sort priority
  assert.ok(MATCHING_STATUS_SORT_PRIORITY.searching < MATCHING_STATUS_SORT_PRIORITY.manual_review);
  assert.ok(MATCHING_STATUS_SORT_PRIORITY.manual_review < MATCHING_STATUS_SORT_PRIORITY.frozen);
  assert.ok(MATCHING_STATUS_SORT_PRIORITY.frozen < MATCHING_STATUS_SORT_PRIORITY.matched);
  assert.ok(MATCHING_STATUS_SORT_PRIORITY.matched < MATCHING_STATUS_SORT_PRIORITY.completed);

  assert.equal(remainingSecondsUntil('2026-07-12T12:00:30.000Z', now), 30);
  assert.equal(remainingSecondsUntil('2026-07-12T11:00:00.000Z', now), 0);

  // unrouted should never be staff-facing; maps to Waiting
  assert.equal(deriveMatchingStatus({ routing_status: 'unrouted', freeze_at: '2026-07-12T12:05:00.000Z' }, now), MATCHING_STATUS.SEARCHING);

  // Valid freeze_at renders MM:SS in row cell; sidebar uses same helper
  const payment = {
    id: 42,
    routing_status: 'searching',
    freeze_at: '2026-07-12T12:04:37.000Z'
  };
  const freezeAt = resolvePaymentFreezeAt(payment);
  const remaining = remainingSecondsUntil(freezeAt, now.getTime());
  assert.equal(formatFreezeCountdown(remaining), '04:37');
  const rowHtml = renderPaymentStatusCell(payment, now.getTime());
  assert.match(rowHtml, /04:37/);
  assert.match(rowHtml, /data-freeze-at="2026-07-12T12:04:37\.000Z"/);
  assert.doesNotMatch(rowHtml, /Awaiting deadline/);

  // Missing freeze_at → diagnostic, not endless Waiting countdown
  const brokenHtml = renderPaymentStatusCell({ id: 7, routing_status: 'searching' }, now.getTime());
  assert.match(brokenHtml, /Missing timer data/);
  assert.doesNotMatch(brokenHtml, /Awaiting deadline/);
  assert.doesNotMatch(brokenHtml, /data-freeze-countdown/);

  // Countdown decrements with shared clock
  assert.equal(
    formatFreezeCountdown(remainingSecondsUntil(freezeAt, now.getTime() + 1000)),
    '04:36'
  );

  // Top scrollbar visibility + sync without loops
  assert.equal(shouldShowPaymentTopScrollbar(1200, 800), true);
  assert.equal(shouldShowPaymentTopScrollbar(800, 800), false);
  assert.equal(shouldShowPaymentTopScrollbar(801, 800), false);
  assert.equal(shouldShowPaymentTopScrollbar(802, 800), true);
  const syncA = syncScrollPair({ sourceScrollLeft: 120, syncing: false });
  assert.equal(syncA.peerScrollLeft, 120);
  const syncB = syncScrollPair({ sourceScrollLeft: 200, syncing: true });
  assert.equal(syncB.peerScrollLeft, null);

  console.log('✓ payment matching status helpers');
  console.log('✓ freeze countdown + missing timer diagnostic');
  console.log('✓ payment table horizontal scroll sync helpers');
  console.log('\nAll payment-status tests passed.');
}

run();
