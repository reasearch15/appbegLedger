import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { registerInternalVendorCashoutRoutes } from '../src/routes/internalVendorCashoutCompleted.js';
import {
  applyCashoutToVendorTotals,
  computeVendorAccountingFromTotals,
  validateVendorCashoutCompletedBody
} from '../src/vendors/vendorCashoutAccounting.js';

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
    post(pathname, ...handlers) {
      routes[`POST ${pathname}`] = handlers;
    }
  };
}

function createRequest({ body, key, authorization } = {}) {
  return {
    body,
    get(name) {
      const normalized = String(name || '').toLowerCase();
      if (normalized === 'authorization' && authorization !== undefined) return authorization;
      if (normalized === 'authorization' && key) return `Bearer ${key}`;
      return '';
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

function mockAppbegStore(players) {
  return {
    async getFinancialReportForPlayerUids(uids = []) {
      const wanted = new Set((uids || []).map((uid) => String(uid)));
      return {
        configured: true,
        source: 'appbeg_financial_events_cache',
        players: (players || []).filter((row) => wanted.has(String(row.uid)))
      };
    }
  };
}

async function seedVendorWithPlayer(store, { commissionPercentage = 10, playerUid = 'player-a' } = {}) {
  const vendor = await store.createVendor({
    name: 'Royal VIP East',
    commissionPercentage
  });
  await store.db.prepare(`
    INSERT INTO vendor_players (vendor_id, appbeg_player_uid, linked_at, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(vendor.id, playerUid);
  return vendor;
}

async function testValidCashoutIncreasesTotalOutOnce() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'cashout-secret';
  await withStore('cashout-once', async (store) => {
    const vendor = await seedVendorWithPlayer(store, { commissionPercentage: 20 });
    const appbegStore = mockAppbegStore([
      { uid: 'player-a', total_in: 200, total_out: 50, net: 150 }
    ]);
    const app = createApp();
    registerInternalVendorCashoutRoutes(app, { store, appbegStore });
    const handlers = app.routes['POST /api/internal/vendor-cashout-completed'];
    const body = {
      eventId: 'evt-1',
      taskId: 'task-1',
      playerUid: 'player-a',
      vendorId: vendor.id,
      vendorCode: vendor.vendor_code,
      vendorName: vendor.name,
      amountNpr: 50
    };
    const res = await runHandlers(handlers, createRequest({ body, key: 'cashout-secret' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.duplicate, false);
    assert.equal(res.payload.accounting.totalOut, 50);
    assert.equal(res.payload.accounting.totalIn, 200);
    assert.equal(res.payload.accounting.net, 150);
    assert.equal(res.payload.accounting.receivable, 30); // 150 * 20%

    const event = await store.getVendorCashoutEventByEventId('evt-1');
    assert.equal(event.amountNpr, 50);
    assert.equal(event.vendorId, vendor.id);
    assert.equal(event.source, 'appbeg_cashout');
  });
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
}

async function testNetAndReceivableRecalculate() {
  const accounting = applyCashoutToVendorTotals(
    { totalIn: 100, totalOut: 0, settlementTotal: 0 },
    40,
    25
  );
  assert.equal(accounting.totalOut, 40);
  assert.equal(accounting.net, 60);
  assert.equal(accounting.receivable, 15);

  const fromTotals = computeVendorAccountingFromTotals({
    totalIn: 100,
    totalOut: 40,
    commissionPercentage: 25
  });
  assert.deepEqual(fromTotals, accounting);
}

async function testDuplicateEventIdDoesNotDoubleCount() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'cashout-secret';
  await withStore('cashout-dup', async (store) => {
    const vendor = await seedVendorWithPlayer(store);
    const appbegStore = mockAppbegStore([
      { uid: 'player-a', total_in: 100, total_out: 50, net: 50 }
    ]);
    const app = createApp();
    registerInternalVendorCashoutRoutes(app, { store, appbegStore });
    const handlers = app.routes['POST /api/internal/vendor-cashout-completed'];
    const body = {
      eventId: 'evt-dup',
      taskId: 'task-dup',
      playerUid: 'player-a',
      vendorId: vendor.id,
      amountNpr: 50
    };
    const first = await runHandlers(handlers, createRequest({ body, key: 'cashout-secret' }));
    const second = await runHandlers(handlers, createRequest({ body, key: 'cashout-secret' }));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(second.payload.duplicate, true);
    assert.equal(second.payload.status, 'already_processed');

    const count = await store.db.prepare(
      'SELECT COUNT(*) AS count FROM vendor_cashout_events WHERE event_id = ?'
    ).get('evt-dup');
    assert.equal(Number(count.count), 1);
  });
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
}

async function testInvalidVendorRejected() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'cashout-secret';
  await withStore('cashout-invalid-vendor', async (store) => {
    const app = createApp();
    registerInternalVendorCashoutRoutes(app, { store, appbegStore: mockAppbegStore([]) });
    const handlers = app.routes['POST /api/internal/vendor-cashout-completed'];
    const res = await runHandlers(handlers, createRequest({
      key: 'cashout-secret',
      body: {
        eventId: 'evt-bad-vendor',
        taskId: 'task-1',
        playerUid: 'player-a',
        vendorId: 999999,
        amountNpr: 50
      }
    }));
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.error, 'Vendor not found.');
  });
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
}

async function testInvalidAmountsRejected() {
  for (const amountNpr of [0, -5, 'abc', null]) {
    const validation = validateVendorCashoutCompletedBody({
      eventId: 'evt-amt',
      taskId: 'task-amt',
      playerUid: 'player-a',
      vendorId: 1,
      amountNpr
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.status, 400);
  }
}

async function testConcurrentDuplicatesRemainIdempotent() {
  await withStore('cashout-concurrent', async (store) => {
    const vendor = await seedVendorWithPlayer(store);
    const payload = {
      eventId: 'evt-concurrent',
      taskId: 'task-concurrent',
      playerUid: 'player-a',
      vendorId: vendor.id,
      amountNpr: 50,
      source: 'appbeg_cashout',
      metadata: { source: 'appbeg_cashout' }
    };
    const results = await Promise.all([
      store.recordVendorCashoutCompleted(payload),
      store.recordVendorCashoutCompleted(payload),
      store.recordVendorCashoutCompleted(payload)
    ]);
    const inserted = results.filter((row) => row.inserted).length;
    const duplicates = results.filter((row) => row.duplicate).length;
    assert.equal(inserted, 1);
    assert.equal(duplicates, 2);
    const count = await store.db.prepare(
      'SELECT COUNT(*) AS count FROM vendor_cashout_events WHERE event_id = ?'
    ).get('evt-concurrent');
    assert.equal(Number(count.count), 1);
  });
}

async function testDatabaseRollbackLeavesNoPartialUpdate() {
  await withStore('cashout-rollback', async (store) => {
    const vendor = await seedVendorWithPlayer(store);
    // Force failure after vendor check by using an invalid FK scenario via monkeypatch.
    const original = store.db.db.prepare;
    store.db.db.prepare = (sql) => {
      if (/INSERT INTO vendor_cashout_events/i.test(sql)) {
        throw new Error('forced_insert_failure');
      }
      return original.call(store.db.db, sql);
    };
    await assert.rejects(
      () => store.recordVendorCashoutCompleted({
        eventId: 'evt-rollback',
        taskId: 'task-rollback',
        playerUid: 'player-a',
        vendorId: vendor.id,
        amountNpr: 50
      }),
      /forced_insert_failure/
    );
    store.db.db.prepare = original;
    const count = await store.db.prepare(
      'SELECT COUNT(*) AS count FROM vendor_cashout_events WHERE event_id = ?'
    ).get('evt-rollback');
    assert.equal(Number(count.count), 0);
  });
}

async function testUnauthorizedRejected() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'cashout-secret';
  await withStore('cashout-auth', async (store) => {
    const app = createApp();
    registerInternalVendorCashoutRoutes(app, { store });
    const handlers = app.routes['POST /api/internal/vendor-cashout-completed'];
    const res = await runHandlers(handlers, createRequest({
      body: {
        eventId: 'evt-auth',
        taskId: 'task-auth',
        playerUid: 'player-a',
        vendorId: 1,
        amountNpr: 50
      }
    }));
    assert.equal(res.statusCode, 401);
  });
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
}

(async () => {
  await testValidCashoutIncreasesTotalOutOnce();
  await testNetAndReceivableRecalculate();
  await testDuplicateEventIdDoesNotDoubleCount();
  await testInvalidVendorRejected();
  await testInvalidAmountsRejected();
  await testConcurrentDuplicatesRemainIdempotent();
  await testDatabaseRollbackLeavesNoPartialUpdate();
  await testUnauthorizedRejected();
  console.log('Vendor cashout completed internal API tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
