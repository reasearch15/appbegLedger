import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireAdmin } from '../src/middleware/auth.js';
import { createDataStore } from '../src/db/index.js';
import { registerVendorRoutes } from '../src/routes/vendors.js';

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

function fakeFinancialStore(records = []) {
  return {
    configured: true,
    calls: [],
    async getFinancialReportForPlayerUids(playerUids = []) {
      const uids = [...new Set(playerUids.map((uid) => String(uid || '').trim()).filter(Boolean))];
      this.calls.push(uids);
      const completed = new Set(['completed']);
      const inTypes = new Set(['deposit', 'recharge']);
      const outTypes = new Set(['cashout', 'redeem']);
      const players = uids.map((uid) => {
        const seen = new Set();
        const totals = records
          .filter((record) => String(record.uid) === uid && completed.has(String(record.status || '').toLowerCase()))
          .reduce((acc, record, index) => {
            const type = String(record.type || '').toLowerCase();
            const key = `${type}:${record.external_reference || record.idempotency_key || record.id || `row-${index}`}`;
            if (seen.has(key)) return acc;
            seen.add(key);
            const amount = Math.abs(Number(record.amount || 0));
            if (inTypes.has(type)) acc.total_in += amount;
            if (outTypes.has(type)) acc.total_out += amount;
            if ((inTypes.has(type) || outTypes.has(type)) && record.created_at) {
              if (!acc.last_activity || new Date(record.created_at) > new Date(acc.last_activity)) {
                acc.last_activity = record.created_at;
              }
            }
            return acc;
          }, { uid, total_in: 0, total_out: 0, last_activity: null });
        totals.net = totals.total_in - totals.total_out;
        return totals;
      });
      const summary = players.reduce((acc, player) => {
        acc.total_in += player.total_in;
        acc.total_out += player.total_out;
        if (player.last_activity && (!acc.last_activity || new Date(player.last_activity) > new Date(acc.last_activity))) {
          acc.last_activity = player.last_activity;
        }
        return acc;
      }, { total_in: 0, total_out: 0, net: 0, last_activity: null });
      summary.net = summary.total_in - summary.total_out;
      return { configured: true, source: 'financial_events_cache', players, summary };
    }
  };
}

function unavailableFinancialStore(reason = 'Unsupported financial source') {
  return {
    configured: true,
    calls: [],
    async getFinancialReportForPlayerUids(playerUids = []) {
      this.calls.push(playerUids);
      return {
        configured: false,
        reason,
        source: null,
        players: playerUids.map((uid) => ({ uid, financial_available: false })),
        summary: null
      };
    }
  };
}

function failingFinancialStore() {
  return {
    configured: true,
    calls: [],
    async getFinancialReportForPlayerUids(playerUids = []) {
      this.calls.push(playerUids);
      throw new Error('password=secret sql SELECT * FROM financial_events_cache');
    }
  };
}

async function createOwnedPlayer(store, vendor, contactId, uid, firstName = 'Player') {
  const contact = await store.upsertTelegramUser({
    id: contactId,
    first_name: firstName,
    username: `${firstName.toLowerCase()}_${contactId}`,
    is_bot: false
  });
  await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
  const linked = await store.linkVendorPlayerForContact({
    contactId: contact.id,
    appbegPlayerUid: uid,
    actorName: 'Test'
  });
  assert.equal(linked.linked, true);
  return linked.mapping;
}

async function testVendorWithZeroPlayersReportsZero() {
  await withStore('vendor-phase3a-zero-players', async (store) => {
    await store.createVendor({ name: 'Zero Players' });
    const app = createApp();
    const appbegStore = fakeFinancialStore([]);
    registerVendorRoutes(app, { store, requireAdmin, appbegStore });

    const res = await runHandlers(app.routes['GET /api/vendors'], {
      ledgerUser: { role: 'admin' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendors.length, 1);
    assert.equal(res.payload.vendors[0].playerCount, 0);
    assert.equal(res.payload.vendors[0].totalIn, 0);
    assert.equal(res.payload.vendors[0].totalOut, 0);
    assert.equal(res.payload.vendors[0].net, 0);
    assert.equal(res.payload.vendors[0].lastActivity, null);
    assert.equal(appbegStore.calls.length, 0);
  });
}

async function testVendorPlayersWithoutTransactionsReportZero() {
  await withStore('vendor-phase3a-no-transactions', async (store) => {
    const vendor = await store.createVendor({ name: 'No Transactions' });
    await createOwnedPlayer(store, vendor, 501, 'uid_no_txn');
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: fakeFinancialStore([]) });

    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.playerCount, 1);
    assert.equal(res.payload.vendor.totalIn, 0);
    assert.equal(res.payload.vendor.totalOut, 0);
    assert.equal(res.payload.vendor.net, 0);
    assert.equal(res.payload.players[0].totalIn, 0);
    assert.equal(res.payload.players[0].totalOut, 0);
  });
}

async function testMixedCompletedFinancialRecords() {
  await withStore('vendor-phase3a-mixed', async (store) => {
    const firstVendor = await store.createVendor({ name: 'Mixed Vendor' });
    const secondVendor = await store.createVendor({ name: 'Other Vendor' });
    await createOwnedPlayer(store, firstVendor, 601, 'uid_a', 'Alpha');
    await createOwnedPlayer(store, firstVendor, 602, 'uid_b', 'Beta');
    await createOwnedPlayer(store, secondVendor, 603, 'uid_c', 'Gamma');

    const appbegStore = fakeFinancialStore([
      { uid: 'uid_a', type: 'deposit', status: 'completed', amount: 100, created_at: '2026-01-01T00:00:00.000Z' },
      { uid: 'uid_a', type: 'recharge', status: 'completed', amount: 25, created_at: '2026-01-02T00:00:00.000Z' },
      { uid: 'uid_a', type: 'cashout', status: 'completed', amount: 40, created_at: '2026-01-03T00:00:00.000Z' },
      { uid: 'uid_a', type: 'deposit', status: 'pending', amount: 999, created_at: '2026-01-04T00:00:00.000Z' },
      { uid: 'uid_a', type: 'deposit', status: 'failed', amount: 888, created_at: '2026-01-04T00:00:00.000Z' },
      { uid: 'uid_a', type: 'deposit', status: 'cancelled', amount: 777, created_at: '2026-01-04T00:00:00.000Z' },
      { uid: 'uid_a_partial', type: 'deposit', status: 'completed', amount: 555, created_at: '2026-01-04T00:00:00.000Z' },
      { uid: 'UID_A', type: 'deposit', status: 'completed', amount: 444, created_at: '2026-01-04T00:00:00.000Z' },
      { uid: 'uid_b', type: 'redeem', status: 'completed', amount: 10, created_at: '2026-01-05T00:00:00.000Z' },
      { uid: 'uid_b', type: 'cashout', status: 'success', amount: 99, created_at: '2026-01-07T00:00:00.000Z' },
      { uid: 'uid_b', type: 'refund', status: 'completed', amount: 123, created_at: '2026-01-08T00:00:00.000Z' },
      { uid: 'uid_b', type: 'reversal', status: 'completed', amount: 456, created_at: '2026-01-09T00:00:00.000Z' },
      { uid: 'uid_c', type: 'deposit', status: 'completed', amount: 7, created_at: '2026-01-06T00:00:00.000Z' }
    ]);
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore });

    const listRes = await runHandlers(app.routes['GET /api/vendors'], {
      ledgerUser: { role: 'admin' }
    });
    const first = listRes.payload.vendors.find((vendor) => vendor.id === firstVendor.id);
    const second = listRes.payload.vendors.find((vendor) => vendor.id === secondVendor.id);
    assert.equal(first.totalIn, 125);
    assert.equal(first.totalOut, 50);
    assert.equal(first.net, 75);
    assert.equal(first.lastActivity, '2026-01-05T00:00:00.000Z');
    assert.equal(second.totalIn, 7);
    assert.equal(second.totalOut, 0);
    assert.equal(second.net, 7);
    assert.equal(appbegStore.calls.length, 1);

    const detailRes = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(firstVendor.id) }
    });
    assert.equal(detailRes.payload.vendor.totalIn, 125);
    assert.equal(detailRes.payload.vendor.totalOut, 50);
    assert.equal(detailRes.payload.vendor.totalIn, first.totalIn);
    assert.equal(detailRes.payload.vendor.totalOut, first.totalOut);
    assert.equal(detailRes.payload.vendor.net, first.net);
    assert.equal(detailRes.payload.players.find((player) => player.appbegPlayerUid === 'uid_a').totalIn, 125);
    assert.equal(detailRes.payload.players.find((player) => player.appbegPlayerUid === 'uid_b').totalOut, 10);
  });
}

async function testCompletedDepositOnlyAndCompletedCashoutOnly() {
  await withStore('vendor-phase3a-single-types', async (store) => {
    const inVendor = await store.createVendor({ name: 'Deposit Only' });
    const outVendor = await store.createVendor({ name: 'Cashout Only' });
    await createOwnedPlayer(store, inVendor, 701, 'deposit_uid', 'Deposit');
    await createOwnedPlayer(store, outVendor, 702, 'cashout_uid', 'Cashout');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore([
        { uid: 'deposit_uid', type: 'deposit', status: 'completed', amount: 12, created_at: '2026-02-01T00:00:00.000Z' },
        { uid: 'cashout_uid', type: 'cashout', status: 'completed', amount: 5, created_at: '2026-02-02T00:00:00.000Z' }
      ])
    });

    const listRes = await runHandlers(app.routes['GET /api/vendors'], { ledgerUser: { role: 'admin' } });
    const depositOnly = listRes.payload.vendors.find((vendor) => vendor.id === inVendor.id);
    const cashoutOnly = listRes.payload.vendors.find((vendor) => vendor.id === outVendor.id);
    assert.equal(depositOnly.totalIn, 12);
    assert.equal(depositOnly.totalOut, 0);
    assert.equal(depositOnly.net, 12);
    assert.equal(cashoutOnly.totalIn, 0);
    assert.equal(cashoutOnly.totalOut, 5);
    assert.equal(cashoutOnly.net, -5);
  });
}

async function testDuplicateFinancialEventProtection() {
  await withStore('vendor-phase3a-duplicates', async (store) => {
    const vendor = await store.createVendor({ name: 'Duplicate Protection' });
    await createOwnedPlayer(store, vendor, 801, 'dup_uid', 'Dup');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore([
        { uid: 'dup_uid', type: 'deposit', status: 'completed', amount: 20, external_reference: 'same-business-event', created_at: '2026-03-01T00:00:00.000Z' },
        { uid: 'dup_uid', type: 'deposit', status: 'completed', amount: 20, external_reference: 'same-business-event', created_at: '2026-03-01T00:00:00.000Z' }
      ])
    });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.vendor.totalIn, 20);
  });
}

async function testFinancialUnavailableDoesNotReturnFakeZero() {
  await withStore('vendor-phase3a-unavailable', async (store) => {
    const vendor = await store.createVendor({ name: 'Unavailable' });
    await createOwnedPlayer(store, vendor, 901, 'unavailable_uid', 'Unavailable');
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: unavailableFinancialStore('Unsupported financial schema') });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.financial.configured, false);
    assert.equal(res.payload.vendor.financialAvailable, false);
    assert.equal(res.payload.vendor.totalIn, null);
    assert.equal(res.payload.vendor.totalOut, null);
    assert.equal(res.payload.vendor.net, null);
    assert.match(res.payload.vendor.financialUnavailableReason, /Unsupported financial schema/);
  });
}

async function testFinancialQueryFailureIsControlled() {
  await withStore('vendor-phase3a-query-failure', async (store) => {
    const vendor = await store.createVendor({ name: 'Query Failure' });
    await createOwnedPlayer(store, vendor, 911, 'failure_uid', 'Failure');
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: failingFinancialStore() });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.financial.configured, false);
    assert.equal(res.payload.vendor.totalIn, null);
    assert.equal(/password|SELECT|financial_events_cache/i.test(res.payload.vendor.financialUnavailableReason), false);
  });
}

async function testLargePlayerInputUsesChunkedAggregateCalls() {
  await withStore('vendor-phase3a-large-input', async (store) => {
    const vendor = await store.createVendor({ name: 'Large Input' });
    for (let index = 0; index < 25; index += 1) {
      await createOwnedPlayer(store, vendor, 1000 + index, `large_uid_${index}`, `Large${index}`);
    }
    const appbegStore = fakeFinancialStore([]);
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(appbegStore.calls.length, 1);
    assert.equal(appbegStore.calls[0].length, 25);
  });
}

async function testVendorFinancialRoutesRequireAdmin() {
  const app = createApp();
  registerVendorRoutes(app, {
    store: {
      async listVendors() { return []; },
      async listAllVendorPlayers() { return []; },
      async getVendor() { return null; },
      async listVendorPlayers() { return []; }
    },
    requireAdmin,
    appbegStore: fakeFinancialStore([])
  });

  const listRes = await runHandlers(app.routes['GET /api/vendors'], {});
  assert.equal(listRes.statusCode, 401);

  const detailRes = await runHandlers(app.routes['GET /api/vendors/:id'], {
    ledgerUser: { role: 'staff' },
    params: { id: '1' }
  });
  assert.equal(detailRes.statusCode, 403);
}

await testVendorWithZeroPlayersReportsZero();
await testVendorPlayersWithoutTransactionsReportZero();
await testMixedCompletedFinancialRecords();
await testCompletedDepositOnlyAndCompletedCashoutOnly();
await testDuplicateFinancialEventProtection();
await testFinancialUnavailableDoesNotReturnFakeZero();
await testFinancialQueryFailureIsControlled();
await testLargePlayerInputUsesChunkedAggregateCalls();
await testVendorFinancialRoutesRequireAdmin();
console.log('ok vendors phase3a');
