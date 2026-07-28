import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { registerInternalVendorOwnershipRoutes } from '../src/routes/internalVendorOwnership.js';

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

function registerTestRoutes(store) {
  const app = createApp();
  registerInternalVendorOwnershipRoutes(app, { store });
  return app.routes;
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

async function testUnauthorizedRequest() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    const routes = registerTestRoutes({ listVendorOwnershipByPlayerUids: async () => [] });
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      body: { playerUids: ['uid1'] }
    }));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.payload, { error: 'Unauthorized' });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testBlankWrongAndMalformedKeysRejected() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    const routes = registerTestRoutes({ listVendorOwnershipByPlayerUids: async () => [] });
    const cases = [
      createRequest({ authorization: 'Bearer ' }),
      createRequest({ authorization: 'Bearer wrong-secret' }),
      createRequest({ authorization: 'phase6-secret' }),
      createRequest({ authorization: 'Basic phase6-secret' }),
      createRequest({ authorization: 'Bearer phase6-secret extra-token' })
    ];
    for (const req of cases) {
      req.body = { playerUids: ['uid1'] };
      const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], req);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.payload, { error: 'Unauthorized' });
    }
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testMissingServerKeyReturnsUnavailable() {
  const previousVendor = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  const previousInternal = process.env.APPBEG_LEDGER_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = '';
  process.env.APPBEG_LEDGER_INTERNAL_API_KEY = '';
  try {
    const routes = registerTestRoutes({ listVendorOwnershipByPlayerUids: async () => [] });
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: ['uid1'] }
    }));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.payload, { configured: false });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previousVendor;
    process.env.APPBEG_LEDGER_INTERNAL_API_KEY = previousInternal;
  }
}

async function testOwnedUnknownAndNoVendorPlayers() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  const calls = [];
  try {
    const routes = registerTestRoutes({
      async listVendorOwnershipByPlayerUids(playerUids) {
        calls.push(playerUids);
        return [{
          appbeg_player_uid: 'owned_uid',
          vendor_id: 12,
          vendor_name: 'Royal VIP East',
          vendor_code: 'VND-000012',
          vendor_status: 'suspended',
          ownership_date: '2026-07-27T12:00:00.000Z'
        }];
      }
    });
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: ['owned_uid', 'missing_uid', 'owned_uid', '', ' '] }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [['owned_uid', 'missing_uid']]);
    assert.equal(res.payload.configured, true);
    assert.deepEqual(res.payload.players.owned_uid, {
      owned: true,
      vendorId: 12,
      vendorName: 'Royal VIP East',
      vendorCode: 'VND-000012',
      vendorStatus: 'suspended',
      ownershipDate: '2026-07-27T12:00:00.000Z'
    });
    assert.deepEqual(res.payload.players.missing_uid, { owned: false });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testRequestValidationReturnsControlledErrors() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    const routes = registerTestRoutes({ listVendorOwnershipByPlayerUids: async () => [] });
    const badBodies = [
      undefined,
      {},
      { playerUids: 'uid1' },
      { playerUids: [['uid1']] },
      { playerUids: [{ uid: 'uid1' }] },
      { playerUids: [123] },
      { playerUids: [true] },
      { playerUids: [null] },
      { playerUids: ['x'.repeat(129)] }
    ];
    for (const body of badBodies) {
      const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
        key: 'phase6-secret',
        body
      }));
      assert.equal(res.statusCode, 400);
      assert.match(res.payload.error, /playerUids/);
    }
    const oversized = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: Array.from({ length: 501 }, (_, index) => `uid_${index}`) }
    }));
    assert.equal(oversized.statusCode, 413);
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testEmptyUidArrayDoesNotQuery() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  let queried = false;
  try {
    const routes = registerTestRoutes({
      async listVendorOwnershipByPlayerUids() {
        queried = true;
        return [];
      }
    });
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: [' ', ''] }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { configured: true, players: {} });
    assert.equal(queried, false);
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testUnconfiguredStoreReturnsUnavailable() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    const routes = registerTestRoutes({});
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: ['uid1'] }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { configured: false });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testEndpointReadsSqliteVendorOwnership() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    await withStore('vendor-internal-ownership', async (store) => {
      const vendor = await store.createVendor({
        name: 'Royal VIP East'
      });
      const contact = await store.upsertTelegramUser({
        id: 9001,
        first_name: 'Owned',
        username: 'owned_player',
        is_bot: false
      });
      await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
      const linked = await store.linkVendorPlayerForContact({
        contactId: contact.id,
        appbegPlayerUid: 'sqlite_owned_uid',
        actorName: 'Test'
      });
      assert.equal(linked.linked, true);

      const routes = registerTestRoutes(store);
      const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
        key: 'phase6-secret',
        body: { playerUids: ['sqlite_owned_uid', 'sqlite_unknown_uid'] }
      }));

      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.configured, true);
      assert.equal(res.payload.players.sqlite_owned_uid.owned, true);
      assert.equal(res.payload.players.sqlite_owned_uid.vendorName, 'Royal VIP East');
      assert.equal(res.payload.players.sqlite_owned_uid.vendorCode, vendor.vendor_code);
      assert.equal(res.payload.players.sqlite_owned_uid.vendorStatus, 'active');
      assert.equal(Object.hasOwn(res.payload.players.sqlite_owned_uid, ['linked', 'Staff', 'Uid'].join('')), false);
      assert.match(res.payload.players.sqlite_owned_uid.ownershipDate, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(res.payload.players.sqlite_unknown_uid, { owned: false });
    });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testQueryFailureReturnsUnavailable() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  try {
    const routes = registerTestRoutes({
      async listVendorOwnershipByPlayerUids() {
        throw new Error('simulated query failure with secret phase6-secret');
      }
    });
    const res = await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: ['uid1'] }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { configured: false });
  } finally {
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

async function testSecretsAreNotLogged() {
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  const previousWarn = console.warn;
  const previousError = console.error;
  const logs = [];
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = 'phase6-secret';
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const routes = registerTestRoutes({
      async listVendorOwnershipByPlayerUids() {
        throw new Error('simulated query failure with secret phase6-secret');
      }
    });
    await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      authorization: 'Bearer wrong-secret',
      body: { playerUids: ['uid1'] }
    }));
    await runHandlers(routes['POST /api/internal/vendor-ownership'], createRequest({
      key: 'phase6-secret',
      body: { playerUids: ['uid1'] }
    }));
    assert.doesNotMatch(logs.join('\n'), /phase6-secret|wrong-secret|Authorization/i);
  } finally {
    console.warn = previousWarn;
    console.error = previousError;
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
  }
}

function testGetIsNotRegistered() {
  const routes = registerTestRoutes({ listVendorOwnershipByPlayerUids: async () => [] });
  assert.equal(routes['GET /api/internal/vendor-ownership'], undefined);
}

(async () => {
  await testUnauthorizedRequest();
  await testBlankWrongAndMalformedKeysRejected();
  await testMissingServerKeyReturnsUnavailable();
  await testOwnedUnknownAndNoVendorPlayers();
  await testRequestValidationReturnsControlledErrors();
  await testEmptyUidArrayDoesNotQuery();
  await testUnconfiguredStoreReturnsUnavailable();
  await testEndpointReadsSqliteVendorOwnership();
  await testQueryFailureReturnsUnavailable();
  await testSecretsAreNotLogged();
  testGetIsNotRegistered();
  console.log('Vendor internal ownership tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
