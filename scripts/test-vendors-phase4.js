import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireAdmin } from '../src/middleware/auth.js';
import { createDataStore } from '../src/db/index.js';
import { registerVendorRoutes } from '../src/routes/vendors.js';

const BUSINESS_TIME_ZONE = 'Asia/Kathmandu';
const TEST_NOW = new Date('2026-07-27T12:00:00+05:45');
const ACTIVE_START = new Date('2026-07-26T18:15:00.000Z');
const ACTIVE_END = new Date('2026-07-27T18:15:00.000Z');

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

function isActiveTimestamp(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date >= ACTIVE_START && date < ACTIVE_END;
}

function fakeFinancialStore(records = []) {
  return {
    calls: [],
    async getFinancialReportForPlayerUids(playerUids = []) {
      const uids = [...new Set(playerUids.map((uid) => String(uid || '').trim()).filter(Boolean))];
      this.calls.push(uids);
      const completed = new Set(['completed']);
      const inTypes = new Set(['deposit', 'recharge']);
      const outTypes = new Set(['cashout', 'redeem']);
      const includedTypes = new Set([...inTypes, ...outTypes]);
      const players = uids.map((uid) => {
        const seen = new Set();
        const totals = records
          .filter((record) => String(record.uid) === uid)
          .reduce((acc, record, index) => {
            const type = String(record.type || '').toLowerCase();
            const status = String(record.status || '').toLowerCase();
            const key = `${type}:${record.external_reference || record.idempotency_key || record.id || `row-${index}`}`;
            if (!completed.has(status) || !includedTypes.has(type) || seen.has(key)) return acc;
            seen.add(key);
            const amount = Math.abs(Number(record.amount || 0));
            if (inTypes.has(type)) acc.total_in += amount;
            if (outTypes.has(type)) acc.total_out += amount;
            if (record.created_at && (!acc.last_activity || new Date(record.created_at) > new Date(acc.last_activity))) {
              acc.last_activity = record.created_at;
            }
            if (isActiveTimestamp(record.created_at)) acc.active_today = true;
            return acc;
          }, { uid, total_in: 0, total_out: 0, last_activity: null, active_today: false });
        totals.net = totals.total_in - totals.total_out;
        return totals;
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
          timeZone: BUSINESS_TIME_ZONE,
          start: ACTIVE_START.toISOString(),
          end: ACTIVE_END.toISOString()
        },
        players,
        summary
      };
    }
  };
}

function unavailableFinancialStore() {
  return {
    async getFinancialReportForPlayerUids(playerUids = []) {
      return {
        configured: false,
        reason: 'Financial reporting unavailable',
        source: null,
        players: playerUids.map((uid) => ({ uid, financial_available: false })),
        summary: null
      };
    }
  };
}

async function createOwnedPlayer(store, vendor, contactId, uid, firstName = 'Player', username = null) {
  const contact = await store.upsertTelegramUser({
    id: contactId,
    first_name: firstName,
    username: username || `${firstName.toLowerCase()}_${contactId}`,
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

function adminReq(query = {}) {
  return {
    ledgerUser: { role: 'admin', username: 'admin' },
    query
  };
}

function register(store, appbegStore) {
  const app = createApp();
  registerVendorRoutes(app, { store, requireAdmin, appbegStore });
  return app;
}

async function list(app, query = {}) {
  return runHandlers(app.routes['GET /api/vendors'], adminReq(query));
}

async function detail(app, id) {
  return runHandlers(app.routes['GET /api/vendors/:id'], {
    ledgerUser: { role: 'admin', username: 'admin' },
    params: { id: String(id) }
  });
}

async function testDashboardSummaryAndListDetailParity() {
  await withStore('vendor-phase4-parity', async (store) => {
    const low = await store.createVendor({ name: 'Low Net', commissionPercentage: 10, linkedStaffUid: 'staff-low' });
    const high = await store.createVendor({ name: 'High Net', commissionPercentage: 20, linkedStaffUid: 'staff-high' });
    await createOwnedPlayer(store, low, 4101, 'low_uid');
    await createOwnedPlayer(store, high, 4102, 'high_uid_a');
    await createOwnedPlayer(store, high, 4103, 'high_uid_b');
    await store.createVendorSettlement(high.id, { amount: 25.5, settlementDate: '2026-06-01', createdBy: 'Admin' });
    await store.createVendorSettlement(high.id, { amount: 15.25, settlementDate: '2026-06-10', createdBy: 'Admin' });

    const app = register(store, fakeFinancialStore([
      { uid: 'low_uid', type: 'deposit', status: 'completed', amount: 100, created_at: '2026-07-27T03:00:00+05:45' },
      { uid: 'low_uid', type: 'cashout', status: 'completed', amount: 50, created_at: '2026-07-27T04:00:00+05:45' },
      { uid: 'high_uid_a', type: 'deposit', status: 'completed', amount: 400, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'high_uid_b', type: 'recharge', status: 'completed', amount: 200, created_at: '2026-07-27T02:00:00+05:45' },
      { uid: 'high_uid_b', type: 'redeem', status: 'completed', amount: 100, created_at: '2026-07-27T02:30:00+05:45' }
    ]));

    const listRes = await list(app);
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.payload.financial.activeDay.timeZone, BUSINESS_TIME_ZONE);
    assert.equal(listRes.payload.financial.activeDay.start, ACTIVE_START.toISOString());
    assert.equal(listRes.payload.financial.activeDay.end, ACTIVE_END.toISOString());
    assert.equal(listRes.payload.vendors[0].name, 'High Net');
    assert.equal(listRes.payload.vendors[0].activePlayersToday, 2);
    assert.equal(listRes.payload.vendors[0].totalIn, 600);
    assert.equal(listRes.payload.vendors[0].totalOut, 100);
    assert.equal(listRes.payload.vendors[0].net, 500);
    assert.equal(listRes.payload.vendors[0].receivable, 100);
    assert.equal(listRes.payload.vendors[0].outstanding, 59.25);
    assert.equal(listRes.payload.vendors[0].latestSettlementAmount, 15.25);
    assert.equal(listRes.payload.vendors[0].latestSettlementDate, '2026-06-10');
    assert.equal(listRes.payload.vendors[1].hasSettlements, false);
    assert.equal(listRes.payload.vendors[1].latestSettlementAmount, null);

    const detailRes = await detail(app, high.id);
    for (const field of ['playerCount', 'totalIn', 'totalOut', 'net', 'commissionPercentage', 'receivable', 'outstanding', 'latestSettlementAmount', 'latestSettlementDate']) {
      assert.equal(detailRes.payload.vendor[field], listRes.payload.vendors[0][field], field);
    }
  });
}

async function testSearchFilterAndSorting() {
  await withStore('vendor-phase4-search-filter-sort', async (store) => {
    const alpha = await store.createVendor({ name: 'alpha Partner', linkedStaffUid: 'staff-secret' });
    const beta = await store.createVendor({ name: 'Beta Partner' });
    const gamma = await store.createVendor({ name: 'Gamma Partner', commissionPercentage: 50 });
    await createOwnedPlayer(store, alpha, 4201, 'alpha_uid', 'Needle Player', 'player_needle');
    await createOwnedPlayer(store, beta, 4202, 'beta_uid');
    await createOwnedPlayer(store, gamma, 4203, 'gamma_uid');
    await store.createVendorSettlement(gamma.id, { amount: 20, settlementDate: '2026-06-01', createdBy: 'Admin' });
    await store.createVendorSettlement(beta.id, { amount: 5, settlementDate: '2026-07-01', createdBy: 'Admin' });
    await store.db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run('suspended', beta.id);

    const app = register(store, fakeFinancialStore([
      { uid: 'alpha_uid', type: 'deposit', status: 'completed', amount: 20, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'beta_uid', type: 'deposit', status: 'completed', amount: 100, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'gamma_uid', type: 'cashout', status: 'completed', amount: 30, created_at: '2026-07-27T01:00:00+05:45' }
    ]));

    assert.deepEqual((await list(app, { query: `  ${alpha.vendor_code.toLowerCase()}  ` })).payload.vendors.map((vendor) => vendor.name), ['alpha Partner']);
    assert.deepEqual((await list(app, { query: 'ALPHA' })).payload.vendors.map((vendor) => vendor.name), ['alpha Partner']);
    assert.deepEqual((await list(app, { query: 'Needle' })).payload.vendors.map((vendor) => vendor.name), []);
    assert.deepEqual((await list(app, { query: 'staff-secret' })).payload.vendors.map((vendor) => vendor.name), []);
    assert.deepEqual((await list(app, { query: '%' })).payload.vendors.map((vendor) => vendor.name), []);
    assert.deepEqual((await list(app, { status: 'active', sort: 'name', dir: 'asc' })).payload.vendors.map((vendor) => vendor.name), ['alpha Partner', 'Gamma Partner']);
    assert.deepEqual((await list(app, { status: 'suspended' })).payload.vendors.map((vendor) => vendor.name), ['Beta Partner']);
    assert.equal((await list(app, { status: 'unexpected' })).payload.vendors.length, 3);
    assert.deepEqual((await list(app, { sort: 'unknown' })).payload.vendors.map((vendor) => vendor.name), ['Beta Partner', 'alpha Partner', 'Gamma Partner']);
    assert.deepEqual((await list(app, { sort: 'total_in', dir: 'desc' })).payload.vendors.map((vendor) => vendor.name), ['Beta Partner', 'alpha Partner', 'Gamma Partner']);
    assert.deepEqual((await list(app, { sort: 'net', dir: 'asc' })).payload.vendors.map((vendor) => vendor.name), ['Gamma Partner', 'alpha Partner', 'Beta Partner']);
    assert.deepEqual((await list(app, { sort: 'outstanding', dir: 'asc' })).payload.vendors.map((vendor) => vendor.name), ['Gamma Partner', 'Beta Partner', 'alpha Partner']);
    assert.deepEqual((await list(app, { sort: 'name', dir: 'asc' })).payload.vendors.map((vendor) => vendor.name), ['alpha Partner', 'Beta Partner', 'Gamma Partner']);
    assert.deepEqual((await list(app, { sort: 'latest_settlement_date', dir: 'desc' })).payload.vendors.map((vendor) => vendor.name), ['Beta Partner', 'Gamma Partner', 'alpha Partner']);
  });
}

async function testStableSortingAndNoSettlementOrdering() {
  await withStore('vendor-phase4-stable-sort', async (store) => {
    const first = await store.createVendor({ name: 'Equal One' });
    const second = await store.createVendor({ name: 'Equal Two' });
    const app = register(store, fakeFinancialStore([]));
    const res = await list(app, { sort: 'net', dir: 'desc' });
    assert.deepEqual(res.payload.vendors.map((vendor) => vendor.vendorCode), [first.vendor_code, second.vendor_code]);

    const noSettlementRes = await list(app, { sort: 'latest_settlement_date', dir: 'desc' });
    assert.deepEqual(noSettlementRes.payload.vendors.map((vendor) => vendor.vendorCode), [first.vendor_code, second.vendor_code]);
    assert.equal(noSettlementRes.payload.vendors[0].hasSettlements, false);
  });
}

async function testActivePlayersTodayBoundariesAndEventFiltering() {
  await withStore('vendor-phase4-active-today', async (store) => {
    const vendor = await store.createVendor({ name: 'Active Vendor' });
    await createOwnedPlayer(store, vendor, 4301, 'multi_uid');
    await createOwnedPlayer(store, vendor, 4302, 'before_uid');
    await createOwnedPlayer(store, vendor, 4303, 'start_uid');
    await createOwnedPlayer(store, vendor, 4304, 'end_uid');
    await createOwnedPlayer(store, vendor, 4305, 'ignored_uid');

    const app = register(store, fakeFinancialStore([
      { uid: 'multi_uid', type: 'deposit', status: 'completed', amount: 10, created_at: '2026-07-27T00:10:00+05:45', id: 'a' },
      { uid: 'multi_uid', type: 'cashout', status: 'completed', amount: 5, created_at: '2026-07-27T10:00:00+05:45', id: 'b' },
      { uid: 'before_uid', type: 'deposit', status: 'completed', amount: 10, created_at: '2026-07-26T18:14:59.999Z' },
      { uid: 'start_uid', type: 'recharge', status: 'completed', amount: 10, created_at: '2026-07-26T18:15:00.000Z' },
      { uid: 'end_uid', type: 'redeem', status: 'completed', amount: 10, created_at: '2026-07-27T18:15:00.000Z' },
      { uid: 'ignored_uid', type: 'deposit', status: 'pending', amount: 10, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'ignored_uid', type: 'deposit', status: 'failed', amount: 10, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'ignored_uid', type: 'cashout', status: 'cancelled', amount: 10, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'ignored_uid', type: 'refund', status: 'completed', amount: 10, created_at: '2026-07-27T01:00:00+05:45' },
      { uid: 'ignored_uid', type: 'deposit', status: 'completed', amount: 10, created_at: 'not-a-date' },
      { uid: 'ignored_uid', type: 'deposit', status: 'completed', amount: 10, created_at: null }
    ]));

    const res = await list(app);
    assert.equal(res.payload.vendors[0].activePlayersToday, 2);
    assert.equal(res.payload.vendors[0].totalIn, 50);
    assert.equal(res.payload.vendors[0].totalOut, 15);
  });
}

async function testUnavailableFinancialAndSettlementFailure() {
  await withStore('vendor-phase4-unavailable', async (store) => {
    const vendor = await store.createVendor({ name: 'Unavailable Vendor' });
    await createOwnedPlayer(store, vendor, 4401, 'unavailable_uid');

    const unavailableApp = register(store, unavailableFinancialStore());
    const unavailableRes = await list(unavailableApp);
    assert.equal(unavailableRes.statusCode, 200);
    assert.equal(unavailableRes.payload.vendors[0].financialAvailable, false);
    assert.equal(unavailableRes.payload.vendors[0].totalIn, null);
    assert.equal(unavailableRes.payload.vendors[0].receivable, null);
    assert.equal(unavailableRes.payload.vendors[0].outstanding, null);
    assert.equal(unavailableRes.payload.vendors[0].activePlayersToday, null);

    const originalListSettlements = store.listAllVendorSettlements;
    store.listAllVendorSettlements = async () => {
      throw new Error('SELECT password FROM vendor_settlements');
    };
    const settlementFailureApp = register(store, fakeFinancialStore([
      { uid: 'unavailable_uid', type: 'deposit', status: 'completed', amount: 100, created_at: '2026-07-27T01:00:00+05:45' }
    ]));
    const settlementFailureRes = await list(settlementFailureApp);
    assert.equal(settlementFailureRes.statusCode, 200);
    assert.equal(settlementFailureRes.payload.settlementReporting.configured, false);
    assert.equal(settlementFailureRes.payload.vendors[0].settlementAvailable, false);
    assert.equal(settlementFailureRes.payload.vendors[0].hasSettlements, null);
    assert.equal(settlementFailureRes.payload.vendors[0].outstanding, null);
    assert.equal(settlementFailureRes.payload.vendors[0].receivable, 0);
    assert.doesNotMatch(settlementFailureRes.payload.settlementReporting.reason, /SELECT|password|vendor_settlements/i);
    store.listAllVendorSettlements = originalListSettlements;
  });
}

async function testLargeUidListUsesSingleBulkRouteCall() {
  await withStore('vendor-phase4-large-bulk', async (store) => {
    const vendor = await store.createVendor({ name: 'Bulk Vendor' });
    for (let index = 0; index < 30; index += 1) {
      await createOwnedPlayer(store, vendor, 4500 + index, `bulk_uid_${index}`);
    }
    const financialStore = fakeFinancialStore([]);
    const app = register(store, financialStore);
    const res = await list(app);
    assert.equal(res.statusCode, 200);
    assert.equal(financialStore.calls.length, 1);
    assert.equal(financialStore.calls[0].length, 30);
  });
}

async function testDashboardRequiresAdmin() {
  await withStore('vendor-phase4-admin', async (store) => {
    await store.createVendor({ name: 'Protected Vendor' });
    const app = register(store, fakeFinancialStore([]));
    const res = await runHandlers(app.routes['GET /api/vendors'], { query: {} });
    assert.equal(res.statusCode, 401);
  });
}

async function main() {
  assert.equal(TEST_NOW.toISOString(), '2026-07-27T06:15:00.000Z');
  await testDashboardSummaryAndListDetailParity();
  await testSearchFilterAndSorting();
  await testStableSortingAndNoSettlementOrdering();
  await testActivePlayersTodayBoundariesAndEventFiltering();
  await testUnavailableFinancialAndSettlementFailure();
  await testLargeUidListUsesSingleBulkRouteCall();
  await testDashboardRequiresAdmin();
  console.log('Vendor Phase 4 dashboard tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
