import assert from 'node:assert/strict';

import { appBegFinancialTesting } from '../src/db/appbegStore.js';
import { computeVendorAccountingFromTotals } from '../src/vendors/vendorCashoutAccounting.js';

/**
 * Vendor Total Out regression suite.
 * Rule: Total Out = sum of unique completed cashout financial events (deduped by task id).
 * Net = Total In − Total Out
 */

const PLAYER = 'o6XdSdLND0g8odmeoYaMXyG5uRn2';
const TEST_NOW = new Date('2026-07-28T12:00:00+05:45');

function aggregate(records, uids = [PLAYER]) {
  const activeBounds = appBegFinancialTesting.businessDayBounds(TEST_NOW, 'Asia/Kathmandu');
  return appBegFinancialTesting.aggregateFinancialEventsForUids(uids, records, {
    activeBounds,
    timeZone: activeBounds.timeZone
  });
}

function cashout({
  taskId,
  amount = 50,
  firebaseId = `fe-${taskId}`,
  status,
  reversedAt,
  refundedAt,
  deletedAt,
  meta,
  activityAt = '2026-07-28T10:00:00+05:45'
} = {}) {
  return {
    uid: PLAYER,
    firebase_id: firebaseId,
    event_type: 'cashout',
    amount_npr: amount,
    amount,
    cashout_task_id: taskId,
    status,
    reversed_at: reversedAt,
    refunded_at: refundedAt,
    deleted_at: deletedAt,
    meta,
    activity_at: activityAt
  };
}

function testOneCompletedCashoutCountsFifty() {
  const { players } = aggregate([cashout({ taskId: 'task-completed-1', amount: 50 })]);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, -50);
}

function testDeclinedCashoutWithRefundCountsZero() {
  const taskId = 'task-declined-1';
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      event_type: 'cashout_request_deduct',
      amount_npr: 50,
      cashout_task_id: taskId,
      activity_at: '2026-07-28T09:00:00+05:45'
    },
    {
      uid: PLAYER,
      event_type: 'cashout_decline_refund',
      amount_npr: 50,
      cashout_task_id: taskId,
      activity_at: '2026-07-28T09:10:00+05:45'
    }
  ]);
  assert.equal(players[0].total_out, 0);
  assert.equal(players[0].net, 0);
  assert.equal(counts.excluded_type, 2);
}

function testDeclinedThenCompletedCountsFiftyOnly() {
  // Mirrors Amyfi02 production shape: declined attempt + completed attempt + game redeem.
  const declinedId = 'd184949a-377e-4674-8bf8-76e3a1ed8e15';
  const completedId = '83292c9f-279d-40e3-b7d6-1c3a98276540';
  const { players } = aggregate([
    {
      uid: PLAYER,
      event_type: 'redeem',
      amount_npr: 50,
      request_id: '5539b427-7fb5-4904-99b1-9db86d153a19',
      source: 'authority_game_request_complete',
      activity_at: '2026-07-28T09:32:58+05:45'
    },
    {
      uid: PLAYER,
      event_type: 'cashout_request_deduct',
      amount_npr: 50,
      cashout_task_id: declinedId,
      activity_at: '2026-07-28T10:07:16+05:45'
    },
    {
      uid: PLAYER,
      event_type: 'cashout_decline_refund',
      amount_npr: 50,
      cashout_task_id: declinedId,
      activity_at: '2026-07-28T10:25:24+05:45'
    },
    {
      uid: PLAYER,
      event_type: 'cashout_request_deduct',
      amount_npr: 50,
      cashout_task_id: completedId,
      activity_at: '2026-07-28T10:49:51+05:45'
    },
    cashout({
      taskId: completedId,
      amount: 50,
      firebaseId: '39998162-5f3b-46aa-9e02-55d6f5aecf92',
      activityAt: '2026-07-28T10:50:18+05:45'
    })
  ]);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, -50);
}

function testTwoSeparateCompletedCashoutsCountOneHundred() {
  const { players } = aggregate([
    cashout({ taskId: 'task-a', amount: 50, firebaseId: 'fe-a' }),
    cashout({ taskId: 'task-b', amount: 50, firebaseId: 'fe-b' })
  ]);
  assert.equal(players[0].total_out, 100);
}

function testCompletedCashoutMultipleFinancialEventsCountsOnce() {
  const taskId = 'task-multi-events';
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      event_type: 'cashout_request_deduct',
      amount_npr: 50,
      cashout_task_id: taskId,
      activity_at: '2026-07-28T10:00:00+05:45'
    },
    cashout({ taskId, amount: 50, firebaseId: 'fe-complete-1' }),
    cashout({ taskId, amount: 50, firebaseId: 'fe-complete-duplicate' })
  ]);
  assert.equal(players[0].total_out, 50);
  assert.equal(counts.deduped, 1);
}

function testCompletedCashoutDuplicateVendorJoinRowsCountsOnce() {
  // Simulates duplicate event rows that a bad ownership join might surface twice.
  const taskId = 'task-dup-join';
  const row = cashout({ taskId, amount: 50, firebaseId: 'fe-join-1' });
  const { players, counts } = aggregate([row, { ...row }, { ...row, firebase_id: 'fe-join-2' }]);
  assert.equal(players[0].total_out, 50);
  assert.equal(counts.deduped, 2);
}

function testPendingOrClaimedCashoutNotCounted() {
  const { players, counts } = aggregate([
    cashout({ taskId: 'task-pending', amount: 50, status: 'pending' }),
    cashout({ taskId: 'task-claimed', amount: 50, status: 'claimed' }),
    {
      uid: PLAYER,
      event_type: 'cashout_request_deduct',
      amount_npr: 50,
      cashout_task_id: 'task-pending-deduct',
      activity_at: '2026-07-28T10:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_out, 0);
  assert.ok(counts.excluded_status >= 2);
}

function testCancelledCashoutWithoutCompletedStatusNotCounted() {
  const { players, counts } = aggregate([
    cashout({ taskId: 'task-cancelled', amount: 50, status: 'cancelled' }),
    cashout({ taskId: 'task-rejected', amount: 50, status: 'rejected' }),
    cashout({ taskId: 'task-expired', amount: 50, status: 'expired' })
  ]);
  assert.equal(players[0].total_out, 0);
  assert.equal(counts.excluded_status, 3);
}

function testRefundReversalAfterCompletedExcluded() {
  const { players, counts } = aggregate([
    cashout({
      taskId: 'task-reversed',
      amount: 50,
      reversedAt: '2026-07-28T11:00:00+05:45'
    }),
    cashout({
      taskId: 'task-refunded',
      amount: 50,
      refundedAt: '2026-07-28T11:00:00+05:45'
    }),
    cashout({
      taskId: 'task-deleted',
      amount: 50,
      meta: { deletedAt: '2026-07-28T11:00:00+05:45' }
    }),
    cashout({ taskId: 'task-still-good', amount: 50 })
  ]);
  assert.equal(players[0].total_out, 50);
  assert.equal(counts.excluded_type, 3);
}

function testTotalInNetSettlementReceivableRemainCorrect() {
  const { players } = aggregate([
    {
      uid: PLAYER,
      event_type: 'deposit',
      amount_npr: 200,
      status: 'completed',
      dedupe_key: 'dep-1',
      activity_at: '2026-07-28T08:00:00+05:45'
    },
    {
      uid: PLAYER,
      event_type: 'redeem',
      amount_npr: 50,
      request_id: 'redeem-1',
      activity_at: '2026-07-28T09:00:00+05:45'
    },
    cashout({ taskId: 'task-out', amount: 50 })
  ]);
  assert.equal(players[0].total_in, 200);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, 150);

  const accounting = computeVendorAccountingFromTotals({
    totalIn: players[0].total_in,
    totalOut: players[0].total_out,
    commissionPercentage: 20,
    settlementTotal: 10
  });
  // Net = Total In − Total Out; receivable = net × commission%
  assert.equal(accounting.net, 150);
  assert.equal(accounting.totalOut, 50);
  assert.equal(accounting.receivable, 30);
  assert.equal(accounting.outstanding, 20);
}

function testGameRedeemAloneDoesNotCountAsTotalOut() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      event_type: 'redeem',
      amount_npr: 50,
      request_id: 'redeem-only',
      source: 'authority_game_request_complete',
      activity_at: '2026-07-28T09:32:58+05:45'
    }
  ]);
  assert.equal(players[0].total_out, 0);
  assert.equal(counts.excluded_type, 1);
}

function main() {
  testOneCompletedCashoutCountsFifty();
  testDeclinedCashoutWithRefundCountsZero();
  testDeclinedThenCompletedCountsFiftyOnly();
  testTwoSeparateCompletedCashoutsCountOneHundred();
  testCompletedCashoutMultipleFinancialEventsCountsOnce();
  testCompletedCashoutDuplicateVendorJoinRowsCountsOnce();
  testPendingOrClaimedCashoutNotCounted();
  testCancelledCashoutWithoutCompletedStatusNotCounted();
  testRefundReversalAfterCompletedExcluded();
  testTotalInNetSettlementReceivableRemainCorrect();
  testGameRedeemAloneDoesNotCountAsTotalOut();
  console.log('vendor total-out cashout regressions: ok');
}

main();
