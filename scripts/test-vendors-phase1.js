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

async function testVendorCreationValidation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-ledger-vendors-'));
  const store = await createDataStore({
    dialect: 'sqlite',
    databasePath: path.join(dir, 'vendors.sqlite')
  });

  try {
    await assert.rejects(
      () => store.createVendor({ name: '', commissionPercentage: 10 }),
      /Vendor name is required/
    );
    await assert.rejects(
      () => store.createVendor({ name: 'Bad Commission', commissionPercentage: 100.01 }),
      /Commission percentage must be between 0 and 100/
    );

    const vendor = await store.createVendor({
      name: 'North Desk',
      commissionPercentage: 12.5,
      linkedStaffUid: 'staff_uid_reporting',
      notes: 'Phase 1 test'
    });

    assert.equal(vendor.vendor_code, 'VND-000001');
    assert.equal(vendor.name, 'North Desk');
    assert.equal(vendor.status, 'active');
    assert.equal(vendor.commission_percentage, 12.5);
    assert.equal(vendor.linked_staff_uid, 'staff_uid_reporting');

    const vendors = await store.listVendors();
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0].vendor_code, 'VND-000001');
    assert.ok(vendors[0].vendor_code);

    const zeroCommission = await store.createVendor({
      name: 'Zero Commission',
      commissionPercentage: 0
    });
    assert.equal(zeroCommission.vendor_code, 'VND-000002');
    assert.equal(zeroCommission.commission_percentage, 0);

    const fullCommission = await store.createVendor({
      name: 'Full Commission',
      commissionPercentage: 100
    });
    assert.equal(fullCommission.vendor_code, 'VND-000003');
    assert.equal(fullCommission.commission_percentage, 100);
  } finally {
    await store.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testVendorListingRequiresAdmin() {
  const routes = {};
  const app = {
    get(pathname, ...handlers) {
      routes[`GET ${pathname}`] = handlers;
    },
    post(pathname, ...handlers) {
      routes[`POST ${pathname}`] = handlers;
    }
  };

  registerVendorRoutes(app, {
    store: { async listVendors() { return []; } },
    requireAdmin
  });

  const handlers = routes['GET /api/vendors'];
  assert.equal(handlers.length, 2);

  const unauthenticated = createResponse();
  handlers[0]({}, unauthenticated, () => {
    throw new Error('Unauthenticated request should not continue.');
  });
  assert.equal(unauthenticated.statusCode, 401);

  const staff = createResponse();
  handlers[0]({ ledgerUser: { role: 'staff' } }, staff, () => {
    throw new Error('Staff request should not continue.');
  });
  assert.equal(staff.statusCode, 403);

  let continued = false;
  const admin = createResponse();
  handlers[0]({ ledgerUser: { role: 'admin' } }, admin, () => {
    continued = true;
  });
  assert.equal(continued, true);
}

await testVendorCreationValidation();
await testVendorListingRequiresAdmin();
console.log('ok vendors phase1');
