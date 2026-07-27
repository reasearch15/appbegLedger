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

function fakeFinancialStore(totalsByUid = {}) {
  return {
    configured: true,
    async getFinancialReportForPlayerUids(playerUids = []) {
      const players = playerUids.map((uid) => {
        const totals = totalsByUid[uid] || { total_in: 0, total_out: 0, last_activity: null };
        const totalIn = Number(totals.total_in || 0);
        const totalOut = Number(totals.total_out || 0);
        return {
          uid,
          total_in: totalIn,
          total_out: totalOut,
          net: totalIn - totalOut,
          last_activity: totals.last_activity || null
        };
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

function unavailableFinancialStore() {
  return {
    configured: true,
    async getFinancialReportForPlayerUids(playerUids = []) {
      return {
        configured: false,
        reason: 'Financial reporting unavailable',
        players: playerUids.map((uid) => ({ uid, financial_available: false })),
        summary: null
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

async function testCommissionAndOutstandingCalculations() {
  await withStore('vendor-phase3b-calculations', async (store) => {
    const vendor = await store.createVendor({ name: 'Settled Vendor', commissionPercentage: 10 });
    await createOwnedPlayer(store, vendor, 1101, 'calc_uid');
    const settlement = await store.createVendorSettlement(vendor.id, {
      amount: 100,
      settlementDate: '2026-04-01',
      notes: 'First settlement',
      createdBy: 'Admin One'
    });
    assert.equal(settlement.settlement_amount, 100);
    assert.equal(settlement.settlement_amount_cents, 10000);

    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({
        calc_uid: { total_in: 4000, total_out: 1000, last_activity: '2026-04-02T00:00:00.000Z' }
      })
    });

    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.totalIn, 4000);
    assert.equal(res.payload.vendor.totalOut, 1000);
    assert.equal(res.payload.vendor.net, 3000);
    assert.equal(res.payload.vendor.receivable, 300);
    assert.equal(res.payload.vendor.settlementTotal, 100);
    assert.equal(res.payload.vendor.outstanding, 200);
    assert.equal(res.payload.vendor.lastSettlement, '2026-04-01');
    assert.equal(res.payload.settlements.length, 1);

    const listRes = await runHandlers(app.routes['GET /api/vendors'], {
      ledgerUser: { role: 'admin' }
    });
    const listed = listRes.payload.vendors.find((item) => item.id === vendor.id);
    assert.equal(listed.receivable, res.payload.vendor.receivable);
    assert.equal(listed.settlementTotal, res.payload.vendor.settlementTotal);
    assert.equal(listed.outstanding, res.payload.vendor.outstanding);
  });
}

async function testMultipleSettlementsOrderingAndOverpayment() {
  await withStore('vendor-phase3b-overpayment', async (store) => {
    const vendor = await store.createVendor({ name: 'Overpaid Vendor', commissionPercentage: 10 });
    await createOwnedPlayer(store, vendor, 1201, 'over_uid');
    await store.createVendorSettlement(vendor.id, { amount: 150, settlementDate: '2026-03-01', createdBy: 'Admin' });
    await store.createVendorSettlement(vendor.id, { amount: 200, settlementDate: '2026-05-01', notes: 'Newest', createdBy: 'Admin' });

    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({ over_uid: { total_in: 1000, total_out: 0 } })
    });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });

    assert.equal(res.payload.vendor.receivable, 100);
    assert.equal(res.payload.vendor.settlementTotal, 350);
    assert.equal(res.payload.vendor.outstanding, -250);
    assert.equal(res.payload.vendor.lastSettlement, '2026-05-01');
    assert.equal(res.payload.settlements[0].settlementDate, '2026-05-01');
    assert.equal(res.payload.settlements[1].settlementDate, '2026-03-01');
  });
}

async function testPreciseSettlementCents() {
  await withStore('vendor-phase3b-precision', async (store) => {
    const vendor = await store.createVendor({ name: 'Precision Vendor', commissionPercentage: 100 });
    await store.createVendorSettlement(vendor.id, { amount: '0.10', settlementDate: '2026-01-01', createdBy: 'Admin' });
    await store.createVendorSettlement(vendor.id, { amount: '10.01', settlementDate: '2026-01-02', createdBy: 'Admin' });
    const settlements = await store.listVendorSettlements(vendor.id);
    assert.equal(settlements.reduce((sum, settlement) => sum + settlement.settlement_amount_cents, 0), 1011);

    await createOwnedPlayer(store, vendor, 1151, 'precision_uid');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({ precision_uid: { total_in: 20.11, total_out: 0 } })
    });
    const res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.vendor.receivable, 20.11);
    assert.equal(res.payload.vendor.settlementTotal, 10.11);
    assert.equal(res.payload.vendor.outstanding, 10);
  });
}

async function testCommissionUpdateValidationAndDecimals() {
  await withStore('vendor-phase3b-commission', async (store) => {
    const vendor = await store.createVendor({ name: 'Commission Vendor', commissionPercentage: 0 });
    await createOwnedPlayer(store, vendor, 1301, 'commission_uid');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({ commission_uid: { total_in: 100, total_out: 0 } })
    });

    let res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: 12.5 }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.vendor.commissionPercentage, 12.5);

    res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.vendor.receivable, 12.5);

    res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: 100 }
    });
    assert.equal(res.statusCode, 200);
    res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.vendor.receivable, 100);

    res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: -1 }
    });
    assert.equal(res.statusCode, 400);

    res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: 101 }
    });
    assert.equal(res.statusCode, 400);

    res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: '' }
    });
    assert.equal(res.statusCode, 400);

    res = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) },
      body: { commissionPercentage: 'abc' }
    });
    assert.equal(res.statusCode, 400);
  });
}

async function testNegativeNetAndUnavailableFinancials() {
  await withStore('vendor-phase3b-negative-unavailable', async (store) => {
    const negativeVendor = await store.createVendor({ name: 'Negative Net', commissionPercentage: 10 });
    await createOwnedPlayer(store, negativeVendor, 1351, 'negative_uid');
    let app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({ negative_uid: { total_in: 100, total_out: 300 } })
    });
    let res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(negativeVendor.id) }
    });
    assert.equal(res.payload.vendor.net, -200);
    assert.equal(res.payload.vendor.receivable, -20);
    assert.equal(res.payload.vendor.outstanding, -20);

    const unavailableVendor = await store.createVendor({ name: 'Unavailable Financials', commissionPercentage: 10 });
    await createOwnedPlayer(store, unavailableVendor, 1352, 'unavailable_uid');
    app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: unavailableFinancialStore() });
    res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(unavailableVendor.id) }
    });
    assert.equal(res.payload.vendor.financialAvailable, false);
    assert.equal(res.payload.vendor.receivable, null);
    assert.equal(res.payload.vendor.outstanding, null);
  });
}

async function testZeroCommissionAndNegativeSettlementRejected() {
  await withStore('vendor-phase3b-zero-negative', async (store) => {
    const vendor = await store.createVendor({ name: 'Zero Vendor', commissionPercentage: 0 });
    await createOwnedPlayer(store, vendor, 1401, 'zero_uid');
    const app = createApp();
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore({ zero_uid: { total_in: 500, total_out: 100 } })
    });

    let res = await runHandlers(app.routes['GET /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.payload.vendor.receivable, 0);
    assert.equal(res.payload.vendor.outstanding, 0);

    res = await runHandlers(app.routes['POST /api/vendors/:id/settlements'], {
      ledgerUser: { role: 'admin', username: 'admin_user' },
      params: { id: String(vendor.id) },
      body: { amount: -10, settlementDate: '2026-06-01' }
    });
    assert.equal(res.statusCode, 400);

    for (const body of [
      { amount: 0, settlementDate: '2026-06-01' },
      { amount: 'abc', settlementDate: '2026-06-01' },
      { amount: '1.001', settlementDate: '2026-06-01' },
      { amount: '10000000000.00', settlementDate: '2026-06-01' },
      { amount: 10, settlementDate: '2026-02-30' },
      { amount: 10, settlementDate: 'not-a-date' },
      { amount: 10, settlementDate: '2026-06-01', notes: 'x'.repeat(1001) }
    ]) {
      res = await runHandlers(app.routes['POST /api/vendors/:id/settlements'], {
        ledgerUser: { role: 'admin', username: 'admin_user' },
        params: { id: String(vendor.id) },
        body
      });
      assert.equal(res.statusCode, 400);
    }
    assert.equal((await store.listVendorSettlements(vendor.id)).length, 0);
  });
}

async function testSettlementApiCreatesAuditRow() {
  await withStore('vendor-phase3b-api-settlement', async (store) => {
    const vendor = await store.createVendor({ name: 'Audit Vendor', commissionPercentage: 1 });
    const app = createApp();
    registerVendorRoutes(app, { store, requireAdmin, appbegStore: fakeFinancialStore({}) });

    const res = await runHandlers(app.routes['POST /api/vendors/:id/settlements'], {
      ledgerUser: { role: 'admin', display_name: 'Admin Display', username: 'admin_user' },
      params: { id: String(vendor.id) },
      body: { amount: 33.33, settlementDate: '2026-07-01', notes: '<b>safe note</b>', createdBy: 'Spoofed Client' }
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.settlement.settlementAmount, 33.33);
    assert.equal(res.payload.settlement.createdBy, 'Admin Display');
    assert.equal(res.payload.settlement.notes, '<b>safe note</b>');
    const rows = await store.listVendorSettlements(vendor.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_by, 'Admin Display');
  });
}

async function testVendorFkPreventsSettlementHistoryDeletion() {
  await withStore('vendor-phase3b-fk', async (store) => {
    const vendor = await store.createVendor({ name: 'FK Vendor', commissionPercentage: 1 });
    await store.createVendorSettlement(vendor.id, { amount: 1, settlementDate: '2026-08-01', createdBy: 'Admin' });
    let blocked = false;
    try {
      await store.db.prepare('DELETE FROM vendors WHERE id = ?').run(vendor.id);
    } catch (error) {
      blocked = /constraint|foreign key/i.test(String(error.message || error.code || ''));
    }
    assert.equal(blocked, true);
    assert.equal((await store.listVendorSettlements(vendor.id)).length, 1);
  });
}

async function testNoSettlementUpdateOrDeleteRoutes() {
  const app = createApp();
  registerVendorRoutes(app, {
    store: {
      async getVendor() { return null; },
      async listVendorSettlements() { return []; },
      async createVendorSettlement() { return null; },
      async updateVendorCommissionPercentage() { return null; }
    },
    requireAdmin,
    appbegStore: fakeFinancialStore({})
  });
  assert.equal(app.routes['PATCH /api/vendors/:id/settlements/:settlementId'], undefined);
  assert.equal(app.routes['DELETE /api/vendors/:id/settlements/:settlementId'], undefined);
  assert.equal(app.routes['DELETE /api/vendors/:id/settlements'], undefined);
}

async function testSettlementRoutesRequireAdmin() {
  const app = createApp();
  registerVendorRoutes(app, {
    store: {
      async getVendor() { return null; },
      async listVendorSettlements() { return []; },
      async createVendorSettlement() { return null; },
      async updateVendorCommissionPercentage() { return null; }
    },
    requireAdmin,
    appbegStore: fakeFinancialStore({})
  });

  const postRes = await runHandlers(app.routes['POST /api/vendors/:id/settlements'], {
    params: { id: '1' },
    body: { amount: 1, settlementDate: '2026-01-01' }
  });
  assert.equal(postRes.statusCode, 401);

  const patchRes = await runHandlers(app.routes['PATCH /api/vendors/:id/commission'], {
    ledgerUser: { role: 'staff' },
    params: { id: '1' },
    body: { commissionPercentage: 1 }
  });
  assert.equal(patchRes.statusCode, 403);
}

await testCommissionAndOutstandingCalculations();
await testPreciseSettlementCents();
await testMultipleSettlementsOrderingAndOverpayment();
await testCommissionUpdateValidationAndDecimals();
await testNegativeNetAndUnavailableFinancials();
await testZeroCommissionAndNegativeSettlementRejected();
await testSettlementApiCreatesAuditRow();
await testVendorFkPreventsSettlementHistoryDeletion();
await testNoSettlementUpdateOrDeleteRoutes();
await testSettlementRoutesRequireAdmin();
console.log('ok vendors phase3b');
