import assert from 'node:assert/strict';

import { appBegFinancialTesting } from '../src/db/appbegStore.js';
import { computeVendorAccountingFromTotals } from '../src/vendors/vendorCashoutAccounting.js';

/**
 * Vendor Total In = real money from a player:
 *   - ledger_deposit_credit / authority_ledger_deposit_credit
 *   - coadmin_coin_add / authority_balance_adjust / coadmin (Add coin)
 *   - staff_wallet_coin_load / authority_staff_wallet_load / staff (Load Coins)
 * Free Play, bonus, game deposits, transfers, refunds never count.
 */

const PLAYER = 'o6XdSdLND0g8odmeoYaMXyG5uRn2';
const TEST_NOW = new Date('2026-07-30T12:00:00+05:45');

function aggregate(records, uids = [PLAYER]) {
  const activeBounds = appBegFinancialTesting.businessDayBounds(TEST_NOW, 'Asia/Kathmandu');
  return appBegFinancialTesting.aggregateFinancialEventsForUids(uids, records, {
    activeBounds,
    timeZone: activeBounds.timeZone
  });
}

function ledgerCredit({
  amount,
  sourceFlow,
  firebaseId = `fe-${sourceFlow}-${amount}`,
  source = 'authority_ledger_deposit_credit',
  type = 'ledger_deposit_credit',
  activityAt = '2026-07-27T13:00:00+05:45',
  paymentEventId = `pay-${firebaseId}`
} = {}) {
  return {
    uid: PLAYER,
    firebase_id: firebaseId,
    event_type: type,
    amount_npr: amount,
    amount,
    source,
    actor_uid: 'appbeg_ledger',
    actor_role: 'ledger',
    meta: {
      sourceFlow,
      paymentEventId,
      externalReference: `appbegledger-payment-event:${paymentEventId}`
    },
    activity_at: activityAt
  };
}

function coadminAddCoin({
  amount = 10,
  firebaseId = `coadmin-add-${amount}`,
  source = 'authority_balance_adjust',
  actorRole = 'coadmin',
  activityAt = '2026-06-14T15:17:36+05:45'
} = {}) {
  return {
    uid: PLAYER,
    firebase_id: firebaseId,
    event_type: 'coadmin_coin_add',
    amount_npr: amount,
    amount,
    source,
    actor_uid: 'coadmin-actor-1',
    actor_role: actorRole,
    activity_at: activityAt
  };
}

function staffLoadCoins({
  amount = 10,
  firebaseId = `staff-load-${amount}`,
  source = 'authority_staff_wallet_load',
  actorRole = 'staff',
  activityAt = '2026-07-30T18:31:29+05:45'
} = {}) {
  return {
    uid: PLAYER,
    firebase_id: firebaseId,
    event_type: 'staff_wallet_coin_load',
    amount_npr: amount,
    amount,
    source,
    actor_uid: 'staff-actor-1',
    actor_role: actorRole,
    activity_at: activityAt
  };
}

function gameDeposit({ amount, firebaseId, activityAt = '2026-07-28T08:35:00+05:45' }) {
  return {
    uid: PLAYER,
    firebase_id: firebaseId,
    event_type: 'deposit',
    amount_npr: amount,
    amount,
    source: 'authority_game_request_complete',
    activity_at: activityAt
  };
}

function testLedgerDepositCreditCounts() {
  const { players, counts } = aggregate([
    ledgerCredit({ amount: 6, sourceFlow: 'registration_initial_deposit', firebaseId: 'reg-6' }),
    ledgerCredit({ amount: 5, sourceFlow: 'registered_user_deposit', firebaseId: 'user-5' })
  ]);
  assert.equal(players[0].total_in, 11);
  assert.equal(counts.included, 2);
  assert.equal(appBegFinancialTesting.isExternalDepositCreditIn(
    ledgerCredit({ amount: 6, sourceFlow: 'registration_initial_deposit' })
  ), true);
}

function testCoadminPaidCoinLoadCounts() {
  const row = coadminAddCoin({
    amount: 10,
    firebaseId: 'd7243aaf-6e8e-4d10-b1c8-6a44e1b383b4'
  });
  const { players, counts } = aggregate([row]);
  assert.equal(players[0].total_in, 10);
  assert.equal(counts.included, 1);
  assert.equal(appBegFinancialTesting.isExternalDepositCreditIn(row), true);
}

function testStaffPaidCoinLoadCounts() {
  const row = staffLoadCoins({
    amount: 10,
    firebaseId: '3044827e-36e2-464c-b140-91041f8b1be8'
  });
  const { players, counts } = aggregate([row]);
  assert.equal(players[0].total_in, 10);
  assert.equal(counts.included, 1);
  assert.equal(appBegFinancialTesting.isExternalDepositCreditIn(row), true);
}

function testCoadminCoinAddWrongSourceDoesNotCount() {
  const { players, counts } = aggregate([
    coadminAddCoin({ amount: 50, firebaseId: 'wrong-src', source: 'authority_promo_credit' })
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testStaffWalletCoinLoadWrongSourceDoesNotCount() {
  const { players, counts } = aggregate([
    staffLoadCoins({ amount: 20, firebaseId: 'wrong-staff-src', source: 'authority_balance_adjust' })
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testCoadminCashAddDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'cash-add-1',
      event_type: 'coadmin_cash_add',
      amount_npr: 12,
      source: 'authority_balance_adjust',
      actor_role: 'coadmin',
      activity_at: '2026-07-01T12:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testCoadminCoinDeductDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'coin-deduct-1',
      event_type: 'coadmin_coin_deduct',
      amount_npr: 5,
      source: 'authority_balance_adjust',
      actor_role: 'coadmin',
      activity_at: '2026-07-01T12:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testFreeplayDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: '1e668ff8-dc54-4185-ba6e-f425b76cec8b',
      event_type: 'freeplay',
      amount_npr: 3,
      source: 'authority_freeplay_claim',
      actor_role: 'player',
      activity_at: '2026-07-29T22:20:31+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testBonusDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'bonus-1',
      event_type: 'bonus',
      amount_npr: 100,
      source: 'authority_bonus_initiate_play',
      activity_at: '2026-07-27T03:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testGameDepositDoesNotCount() {
  const { players, counts } = aggregate([
    gameDeposit({ amount: 10, firebaseId: 'game-dep-10' }),
    gameDeposit({ amount: 2, firebaseId: 'game-dep-2' })
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 2);
}

function testRedeemDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'redeem-1',
      event_type: 'redeem',
      amount_npr: 50,
      source: 'authority_game_request_complete',
      activity_at: '2026-07-28T09:32:58+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(players[0].total_out, 0);
  assert.equal(counts.excluded_type, 1);
}

function testRechargeDeductAndRefundDoNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'recharge-deduct-1',
      event_type: 'recharge_request_deduct',
      amount_npr: 10,
      source: 'authority_recharge_create',
      activity_at: '2026-07-28T08:33:00+05:45'
    },
    {
      uid: PLAYER,
      firebase_id: 'recharge-refund-1',
      event_type: 'recharge_refund',
      amount_npr: 1,
      source: 'authority_dismiss_recharge',
      activity_at: '2026-07-29T20:50:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 2);
}

function testInternalTransferDoesNotCount() {
  const { players, counts } = aggregate([
    {
      uid: PLAYER,
      firebase_id: 'transfer-1',
      event_type: 'cash_to_coin_transfer',
      amount_npr: 25,
      source: 'authority_transfer',
      activity_at: '2026-07-28T12:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 0);
  assert.equal(counts.excluded_type, 1);
}

function testOneAutomaticDepositThenMultipleGameRechargesCountsOnce() {
  const { players, counts } = aggregate([
    ledgerCredit({
      amount: 50,
      sourceFlow: 'registered_user_deposit',
      firebaseId: 'real-dep-50',
      paymentEventId: '1279'
    }),
    {
      uid: PLAYER,
      firebase_id: 'recharge-deduct-a',
      event_type: 'recharge_request_deduct',
      amount_npr: 20,
      source: 'authority_recharge_create',
      activity_at: '2026-07-28T09:00:00+05:45'
    },
    gameDeposit({ amount: 20, firebaseId: 'game-load-20a', activityAt: '2026-07-28T09:01:00+05:45' }),
    gameDeposit({ amount: 15, firebaseId: 'game-load-15b', activityAt: '2026-07-28T10:01:00+05:45' }),
    {
      uid: PLAYER,
      firebase_id: 'freeplay-after',
      event_type: 'freeplay',
      amount_npr: 3,
      source: 'authority_freeplay_claim',
      activity_at: '2026-07-28T11:00:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 50);
  assert.equal(counts.included, 1);
  assert.equal(counts.excluded_type, 4);
}

function testOneCoadminPaidLoadThenGameRechargesCountsOnce() {
  const { players, counts } = aggregate([
    coadminAddCoin({ amount: 10, firebaseId: 'coadmin-once' }),
    gameDeposit({ amount: 5, firebaseId: 'after-coadmin-1' }),
    gameDeposit({ amount: 5, firebaseId: 'after-coadmin-2' })
  ]);
  assert.equal(players[0].total_in, 10);
  assert.equal(counts.included, 1);
  assert.equal(counts.excluded_type, 2);
}

function testOneStaffPaidLoadThenGameRechargesCountsOnce() {
  const { players, counts } = aggregate([
    staffLoadCoins({ amount: 10, firebaseId: 'staff-once' }),
    gameDeposit({ amount: 4, firebaseId: 'after-staff-1' }),
    gameDeposit({ amount: 6, firebaseId: 'after-staff-2' })
  ]);
  assert.equal(players[0].total_in, 10);
  assert.equal(counts.included, 1);
  assert.equal(counts.excluded_type, 2);
}

function testCompletedCashoutStillCountsAsTotalOut() {
  const { players } = aggregate([
    ledgerCredit({ amount: 16, sourceFlow: 'registration_initial_deposit', firebaseId: 'in-16' }),
    staffLoadCoins({ amount: 10, firebaseId: 'staff-for-out' }),
    {
      uid: PLAYER,
      firebase_id: 'cashout-complete-1',
      event_type: 'cashout',
      amount_npr: 50,
      cashout_task_id: 'task-completed-out',
      source: 'authority_cashout_complete',
      activity_at: '2026-07-28T10:35:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 26);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, -24);
}

function testNetAndReceivableUseCorrectedTotalIn() {
  const { players } = aggregate([
    ledgerCredit({ amount: 6, sourceFlow: 'registration_initial_deposit', firebaseId: 'r-6' }),
    ledgerCredit({ amount: 5, sourceFlow: 'registered_user_deposit', firebaseId: 'r-5a' }),
    ledgerCredit({ amount: 5, sourceFlow: 'registered_user_deposit', firebaseId: 'r-5b' }),
    staffLoadCoins({ amount: 10, firebaseId: 'r-staff-10' }),
    gameDeposit({ amount: 10, firebaseId: 'r-game' }),
    {
      uid: PLAYER,
      firebase_id: 'r-cashout',
      event_type: 'cashout',
      amount_npr: 50,
      cashout_task_id: 'r-task',
      activity_at: '2026-07-28T10:35:00+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 26);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, -24);
  const accounting = computeVendorAccountingFromTotals({
    totalIn: players[0].total_in,
    totalOut: players[0].total_out,
    commissionPercentage: 20
  });
  assert.equal(accounting.net, -24);
  assert.equal(accounting.receivable, -4.8);
}

function testCharlieShapeWithStaffLoad() {
  const { players } = aggregate([
    ledgerCredit({
      amount: 6,
      sourceFlow: 'registration_initial_deposit',
      firebaseId: 'f8c3f020-16b7-4b6f-ad67-e33654a80240',
      paymentEventId: '1278'
    }),
    ledgerCredit({
      amount: 5,
      sourceFlow: 'registered_user_deposit',
      firebaseId: '709df010-29ea-43c1-9d5f-0039989a6039',
      paymentEventId: '1279'
    }),
    ledgerCredit({
      amount: 5,
      sourceFlow: 'registered_user_deposit',
      firebaseId: 'ffb52ab5-bf66-4499-a8c6-98abb7d10948',
      paymentEventId: '1280'
    }),
    staffLoadCoins({
      amount: 10,
      firebaseId: '3044827e-36e2-464c-b140-91041f8b1be8'
    }),
    gameDeposit({ amount: 10, firebaseId: '95c79b93-254e-4e0c-b7ef-91263b87de1d' }),
    {
      uid: PLAYER,
      firebase_id: '1e668ff8-dc54-4185-ba6e-f425b76cec8b',
      event_type: 'freeplay',
      amount_npr: 3,
      source: 'authority_freeplay_claim',
      actor_role: 'player',
      activity_at: '2026-07-29T22:20:31+05:45'
    },
    {
      uid: PLAYER,
      firebase_id: '39998162-5f3b-46aa-9e02-55d6f5aecf92',
      event_type: 'cashout',
      amount_npr: 50,
      cashout_task_id: '83292c9f-279d-40e3-b7d6-1c3a98276540',
      source: 'authority_cashout_complete',
      activity_at: '2026-07-28T10:35:18+05:45'
    }
  ]);
  assert.equal(players[0].total_in, 26);
  assert.equal(players[0].total_out, 50);
  assert.equal(players[0].net, -24);
}

function main() {
  testLedgerDepositCreditCounts();
  testCoadminPaidCoinLoadCounts();
  testStaffPaidCoinLoadCounts();
  testCoadminCoinAddWrongSourceDoesNotCount();
  testStaffWalletCoinLoadWrongSourceDoesNotCount();
  testCoadminCashAddDoesNotCount();
  testCoadminCoinDeductDoesNotCount();
  testFreeplayDoesNotCount();
  testBonusDoesNotCount();
  testGameDepositDoesNotCount();
  testRedeemDoesNotCount();
  testRechargeDeductAndRefundDoNotCount();
  testInternalTransferDoesNotCount();
  testOneAutomaticDepositThenMultipleGameRechargesCountsOnce();
  testOneCoadminPaidLoadThenGameRechargesCountsOnce();
  testOneStaffPaidLoadThenGameRechargesCountsOnce();
  testCompletedCashoutStillCountsAsTotalOut();
  testNetAndReceivableUseCorrectedTotalIn();
  testCharlieShapeWithStaffLoad();
  console.log('vendor total-in coadmin/staff paid loads: ok');
}

main();
