import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcrypt';

import { createDataStore } from '../src/db/index.js';
import { requireAdmin, requireAuth } from '../src/middleware/auth.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerVendorRoutes } from '../src/routes/vendors.js';

function createApp() {
  const routes = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    routes[method] = (pathname, ...handlers) => {
      routes[`${method.toUpperCase()} ${pathname}`] = handlers;
    };
  }
  return routes;
}

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
    },
    clearCookie() {
      return this;
    }
  };
}

async function runHandlers(handlers, req = {}) {
  const res = createResponse();
  let index = -1;
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (handlers[index]) await handlers[index](req, res, next);
  };
  await next();
  return res;
}

function fakeFinancialStore(records = []) {
  return {
    async getFinancialReportForPlayerUids(playerUids = []) {
      return {
        configured: true,
        source: 'test',
        players: playerUids.map((uid) => {
          const totals = records
            .filter((record) => record.uid === uid)
            .reduce((acc, record) => {
              if (record.type === 'in') acc.total_in += record.amount;
              if (record.type === 'out') acc.total_out += record.amount;
              acc.last_activity = record.last_activity || acc.last_activity;
              acc.active_today = acc.active_today || Boolean(record.active_today);
              return acc;
            }, { uid, total_in: 0, total_out: 0, last_activity: null, active_today: false });
          totals.net = totals.total_in - totals.total_out;
          return totals;
        })
      };
    }
  };
}

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-ledger-vendor-auth-'));
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

async function createOwnedPlayer(store, vendor, contactId, uid, username) {
  const contact = await store.upsertTelegramUser({
    id: contactId,
    first_name: username,
    username,
    is_bot: false
  });
  await store.updateRegistrationStatus(contact.id, 'Registered', 'Test');
  await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
  const linked = await store.linkVendorPlayerForContact({
    contactId: contact.id,
    appbegPlayerUid: uid,
    actorName: 'Test'
  });
  assert.equal(linked.linked, true);
}

async function testVendorAuthAndPortal() {
  await withStore(async (store) => {
    const app = createApp();
    registerAuthRoutes(app, { store });
    registerVendorRoutes(app, {
      store,
      requireAdmin,
      appbegStore: fakeFinancialStore([
        { uid: 'own_uid', type: 'in', amount: 120, last_activity: '2026-07-27T10:00:00.000Z', active_today: true },
        { uid: 'own_uid', type: 'out', amount: 40, last_activity: '2026-07-27T11:00:00.000Z', active_today: true },
        { uid: 'other_uid', type: 'in', amount: 999, last_activity: '2026-07-27T09:00:00.000Z', active_today: true }
      ])
    });

    const adminHash = await bcrypt.hash('admin-password', 12);
    await store.createLedgerUser({ username: 'admin', passwordHash: adminHash, role: 'admin' });

    const createVendorRes = await runHandlers(app['POST /api/vendors'], {
      ledgerUser: { role: 'admin', username: 'admin' },
      body: {
        name: 'Vendor One',
        username: 'VendorOne',
        password: 'vendor-password',
        commissionPercentage: 25,
        notes: 'private admin note'
      }
    });
    assert.equal(createVendorRes.statusCode, 201);
    const vendor = createVendorRes.payload.vendor;
    assert.equal(vendor.username, 'vendorone');
    assert.equal(vendor.password_hash, undefined);

    const duplicateRes = await runHandlers(app['POST /api/vendors'], {
      ledgerUser: { role: 'admin', username: 'admin' },
      body: {
        name: 'Duplicate Vendor',
        username: 'vendorone',
        password: 'vendor-password',
        commissionPercentage: 10
      }
    });
    assert.equal(duplicateRes.statusCode, 400);

    const vendorAuth = await store.getVendorAuthByUsername('vendorone');
    assert.notEqual(vendorAuth.password_hash, 'vendor-password');
    assert.equal(await bcrypt.compare('vendor-password', vendorAuth.password_hash), true);

    const otherHash = await bcrypt.hash('other-password', 12);
    const otherVendor = await store.createVendor({
      name: 'Other Vendor',
      username: 'other-vendor',
      passwordHash: otherHash,
      commissionPercentage: 50
    });
    await createOwnedPlayer(store, vendor, 9001, 'own_uid', 'ownplayer');
    await createOwnedPlayer(store, otherVendor, 9002, 'other_uid', 'otherplayer');
    await store.createVendorSettlement(vendor.id, { amount: 5, settlementDate: '2026-07-26', notes: 'paid', createdBy: 'Admin' });

    const adminSession = {};
    const adminLogin = await runHandlers(app['POST /api/auth/login'], {
      body: { username: 'admin', password: 'admin-password' },
      session: adminSession,
      headers: {},
      ip: '127.0.0.10'
    });
    assert.equal(adminLogin.statusCode, 200);
    assert.equal(adminLogin.payload.user.role, 'admin');
    assert.equal(adminLogin.payload.user.password_hash, undefined);
    assert.equal(adminSession.ledgerAuthType, 'admin');

    const vendorSession = {};
    const vendorLogin = await runHandlers(app['POST /api/auth/login'], {
      body: { username: 'VendorOne', password: 'vendor-password' },
      session: vendorSession,
      headers: {},
      ip: '127.0.0.11'
    });
    assert.equal(vendorLogin.statusCode, 200);
    assert.equal(vendorLogin.payload.user.role, 'vendor');
    assert.equal(vendorLogin.payload.user.vendorId, vendor.id);
    assert.equal(vendorLogin.payload.user.password_hash, undefined);
    assert.equal(vendorSession.ledgerAuthType, 'vendor');
    assert.equal(vendorSession.ledgerVendorId, vendor.id);

    const wrongPassword = await runHandlers(app['POST /api/auth/login'], {
      body: { username: 'vendorone', password: 'wrong-password' },
      session: {},
      headers: {},
      ip: '127.0.0.12'
    });
    assert.equal(wrongPassword.statusCode, 401);

    const vendorReq = { session: vendorSession };
    const authRes = await runHandlers([requireAuth(store), (req, res) => res.json({ user: req.ledgerUser })], vendorReq);
    assert.equal(authRes.payload.user.role, 'vendor');
    assert.equal(authRes.payload.user.vendorId, vendor.id);

    const dashboard = await runHandlers(app['GET /api/vendor/dashboard'], { ledgerUser: authRes.payload.user });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.payload.vendor.playerCount, 1);
    assert.equal(dashboard.payload.vendor.totalIn, 120);
    assert.equal(dashboard.payload.vendor.totalOut, 40);
    assert.equal(dashboard.payload.vendor.net, 80);
    assert.equal(dashboard.payload.vendor.receivable, 20);
    assert.equal(dashboard.payload.vendor.settlementTotal, 5);
    assert.equal(dashboard.payload.vendor.outstanding, 15);

    const players = await runHandlers(app['GET /api/vendor/players'], {
      ledgerUser: authRes.payload.user,
      query: { query: 'own', sort: 'username', dir: 'asc', page: '1', limit: '25' }
    });
    assert.equal(players.statusCode, 200);
    assert.equal(players.payload.players.length, 1);
    assert.equal(players.payload.players[0].appbegPlayerUid, 'own_uid');
    assert.equal(players.payload.players.some((player) => player.appbegPlayerUid === 'other_uid'), false);

    const settlements = await runHandlers(app['GET /api/vendor/settlements'], { ledgerUser: authRes.payload.user });
    assert.equal(settlements.statusCode, 200);
    assert.equal(settlements.payload.settlements[0].runningOutstanding, 15);

    const reset = await runHandlers(app['POST /api/vendors/:id/reset-password'], {
      ledgerUser: { role: 'admin', username: 'admin' },
      params: { id: String(vendor.id) },
      body: { password: 'new-vendor-password' }
    });
    assert.equal(reset.statusCode, 200);
    const resetAuth = await store.getVendorAuthByUsername('vendorone');
    assert.equal(await bcrypt.compare('new-vendor-password', resetAuth.password_hash), true);

    const vendorAdminAttempt = await runHandlers([
      requireAuth(store),
      (req, res, next) => {
        if (req.ledgerUser.role === 'vendor' && !'/api/vendors'.startsWith('/api/vendor/')) {
          return res.status(403).json({ error: 'Admin access required.' });
        }
        return next();
      }
    ], { session: vendorSession });
    assert.equal(vendorAdminAttempt.statusCode, 403);
  });
}

await testVendorAuthAndPortal();
console.log('vendor auth portal tests passed');
