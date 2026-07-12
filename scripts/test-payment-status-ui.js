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

function run() {
  const now = new Date('2026-07-12T12:00:00.000Z');

  // Waiting / searching
  const waiting = enrichPaymentQueueFields({
    routing_status: 'searching',
    freeze_at: '2026-07-12T12:04:38.000Z',
    processing_status: 'Parsed'
  }, now);
  assert.equal(waiting.matching_status, MATCHING_STATUS.SEARCHING);
  assert.equal(waiting.remaining_seconds, 278);
  assert.equal(matchingStatusLabel(waiting.matching_status), 'Waiting');

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

  console.log('✓ payment matching status helpers');
  console.log('\nAll payment-status tests passed.');
}

run();
