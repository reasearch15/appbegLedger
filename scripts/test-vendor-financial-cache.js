import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireAdmin } from '../src/middleware/auth.js';
import { appBegFinancialTesting } from '../src/db/appbegStore.js';
import { createDataStore } from '../src/db/index.js';
import { registerVendorRoutes } from '../src/routes/vendors.js';

const TEST_NOW = new Date('2026-07-27T12:00:00+05:45');

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function createApp() {
  const routes = {};
  return {
    routes,
    get(pathname, ...handlers) {
      routes[`GET ${pathname}`] = handlers;
    },
    post(pathname, ...handlers) {
      routes[`POST ${pathname}`] = handlers;
    },
    delete(pathname, ...handlers) {
      routes[`DELETE ${pathname}`] = handlers;
    },
    patch(pathname, ...handlers) {
      routes[`PATCH ${pathname}`] = handlers;
    }
  };
}

async function runHandlers(handlers, req = {}) {
  const res = createResponse();
  let index = 0;
  const next = async () => {
    index += 1;
    if (handlers[index]) await handlers[index](req, res, next);
  };
  await handlers[0](req, res, next);
  return res;
}

async function withStore(name, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `appbeg-ledger-${name}-`));
  const store = await createDataStore({
    dialect: 'sqlite',
    databasePath: path.join(dir, 'test.sqlite')
  });
  try {
    await fn(store);
  } finally {
    await store.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeSchemaPool(columns) {
  return {
    async query(sql, params = []) {
      if (/information_schema\.tables/i.test(sql)) {
        return { rows: [{ table_name: 'financial_events_cache' }] };
      }
      if (/information_schema\.columns/i.test(sql)) {
        assert.equal(params[0], 'financial_events_cache');
        return {
          rows: columns.map((column_name) => ({ column_name }))
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

function aggregateReport(records) {
  return {
    async getFinancialReportForPlayerUids(playerUids = []) {
      const uids = [...new Set(playerUids.map((uid) => String(uid || '').trim()).filter(Boolean))];
      const activeBounds = appBegFinancialTesting.businessDayBounds(TEST_NOW, 'Asia/Kathmandu');
      const { players, counts } = appBegFinancialTesting.aggregateFinancialEventsForUids(uids, records, {
        activeBounds,
        timeZone: activeBounds.timeZone
      });
      const summary = players.reduce((acc, player) => {
        acc.total_in += player.total_in;
        acc.total_out += player.total_out;
        if (player.last_activity && (!acc.last_activity || new Date(player.last_activity) > new Date(acc.last_activity))) {
          acc.last_activity = player.last_activity;
        }
        if (player.active_today) acc.active_today = true;
        return acc;
      }, { total_in: 0, total_out: 0, net: 0, last_activity: null, active_today: false });
      summary.net = summary.total_in - summary.total_out;
      return {
        configured: true,
        source: 'financial_events_cache',
        activeDay: {
          timeZone: activeBounds.timeZone,
          start: activeBounds.start.toISOString(),
          end: activeBounds.end.toISOString()
        },
        players,
        summary,
        counts
      };
    }
  };
}

async function createOwnedPlayer(store, vendor, contactId, uid) {
  const contact = await store.upsertTelegramUser({
    id: contactId,
    first_name: `Vendor${contactId}`,
    username: `vendor_${contactId}`,
    is_bot: false
  });
  await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
  const linked = await store.linkVendorPlayerForContact({
    contactId: contact.id,
    appbegPlayerUid: uid,
    actorName: 'Test'
  });
  assert.equal(linked.linked, true);
}

async function testSchemaValidationAllowsAuthoritativeCacheWithoutStatus() {
  const plan = await appBegFinancialTesting.buildFinancialPlan(fakeSchemaPool([
    'player_uid',
    'type',
    'amount_npr',
    'created_at',
    'source',
    'source_flow',
    'external_reference',
    'payment_event_id'
  ]));
  assert.equal(plan.configured, true);
  assert.equal(plan.columns.status, null);
  assert.equal(plan.columns.amount, 'amount_npr');
  assert.equal(plan.columns.sourceFlow, 'source_flow');

  const missing = await appBegFinancialTesting.buildFinancialPlan(fakeSchemaPool([
    'player_uid',
    'type',
    'created_at'
  ]));
  assert.equal(missing.configured, false);
  assert.match(missing.reason, /amount/);
}

async function testRegistrationCreditInclusionAndExclusionRules() {
  const activeBounds = appBegFinancialTesting.businessDayBounds(TEST_NOW, 'Asia/Kathmandu');
  const { players, counts } = appBegFinancialTesting.aggregateFinancialEventsForUids(['linked_uid'], [
    {
      uid: 'linked_uid',
      event_type: 'coadmin_coin_add',
      amount: 25,
      source: 'appbeg_ledger',
      source_flow: 'registration_initial_deposit',
      payment_event_id: '1278',
      dedupe_key: 'appbegledger-payment-event:1278',
      activity_at: '2026-07-27T13:00:00+05:45'
    },
    {
      uid: 'linked_uid',
      event_type: 'coadmin_coin_add',
      amount: 25,
      source: 'appbeg_ledger',
      source_flow: 'registration_initial_deposit',
      payment_event_id: '1278',
      dedupe_key: 'appbegledger-payment-event:1278',
      activity_at: '2026-07-27T13:00:00+05:45'
    },
    { uid: 'linked_uid', event_type: 'cashout', status: 'completed', amount: 5, dedupe_key: 'cashout-1', activity_at: '2026-07-27T02:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'deposit', status: 'completed', amount: 10, dedupe_key: 'deposit-1', activity_at: '2026-07-27T03:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'deposit', status: 'pending', amount: 100, dedupe_key: 'pending-1', activity_at: '2026-07-27T03:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'deposit', status: 'failed', amount: 100, dedupe_key: 'failed-1', activity_at: '2026-07-27T03:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'coadmin_coin_add', amount: 100, dedupe_key: 'manual-1', activity_at: '2026-07-27T03:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'bonus', status: 'completed', amount: 100, dedupe_key: 'bonus-1', activity_at: '2026-07-27T03:00:00+05:45' },
    { uid: 'linked_uid', event_type: 'recharge_refund', status: 'completed', amount: 100, dedupe_key: 'refund-1', activity_at: '2026-07-27T03:00:00+05:45' }
  ], {
    activeBounds,
    timeZone: activeBounds.timeZone
  });
  assert.equal(players[0].total_in, 35);
  assert.equal(players[0].total_out, 5);
  assert.equal(players[0].net, 30);
  assert.equal(players[0].active_today, true);
  assert.equal(counts.included, 3);
  assert.equal(counts.deduped, 1);
  assert.equal(counts.excluded_status, 2);
  assert.equal(counts.excluded_type, 3);
}

async function testVendorDetailUsesRegistrationDepositAndZeroTransactions() {
  await withStore('vendor-financial-cache', async (store) => {
    const vendor = await store.createVendor({ name: 'Charlie', commissionPercentage: 20 });
    await createOwnedPlayer(store, vendor, 7004, 'o6XdSdLND0g8odmeoYaMXyG5uRn2');

    let app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: aggregateReport([
        {
          uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
          event_type: 'coadmin_coin_add',
          amount: 30,
          source: 'appbeg_ledger',
          source_flow: 'registration_initial_deposit',
          payment_event_id: '1278',
          dedupe_key: 'appbegledger-payment-event:1278',
          activity_at: '2026-07-27T01:00:00+05:45'
        }
      ])
    });
    let res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.totalIn, 30);
    assert.equal(res.payload.vendor.totalOut, 0);
    assert.equal(res.payload.vendor.net, 30);
    assert.equal(res.payload.vendor.receivable, 6);
    assert.equal(res.payload.vendor.outstanding, 6);
    assert.equal(res.payload.vendor.financialAvailable, true);

    const zeroVendor = await store.createVendor({ name: 'No Transactions', commissionPercentage: 20 });
    await createOwnedPlayer(store, zeroVendor, 7005, 'zero_tx_uid');
    app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: aggregateReport([]) });
    res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(zeroVendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.financialAvailable, true);
    assert.equal(res.payload.vendor.totalIn, 0);
    assert.equal(res.payload.vendor.totalOut, 0);
    assert.equal(res.payload.vendor.net, 0);
    assert.equal(res.payload.vendor.receivable, 0);
  });
}

async function testMissingRequiredSchemaStaysUnavailable() {
  await withStore('vendor-financial-unavailable', async (store) => {
    const vendor = await store.createVendor({ name: 'Schema Missing', commissionPercentage: 20 });
    await createOwnedPlayer(store, vendor, 7010, 'schema_missing_uid');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: {
        async getFinancialReportForPlayerUids(playerUids = []) {
          return {
            configured: false,
            reason: 'AppBeg financial events cache is missing required amount column(s).',
            source: 'financial_events_cache',
            players: playerUids.map((uid) => ({ uid, financial_available: false })),
            summary: null
          };
        }
      }
    });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.financialAvailable, false);
    assert.equal(res.payload.vendor.totalIn, null);
    assert.equal(res.payload.vendor.receivable, null);
    assert.match(res.payload.vendor.financialUnavailableReason, /amount column/);
  });
}

async function main() {
  await testSchemaValidationAllowsAuthoritativeCacheWithoutStatus();
  await testRegistrationCreditInclusionAndExclusionRules();
  await testVendorDetailUsesRegistrationDepositAndZeroTransactions();
  await testMissingRequiredSchemaStaysUnavailable();
  console.log('Vendor financial cache tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
