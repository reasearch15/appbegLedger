import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireAdmin } from '../src/middleware/auth.js';
import { createDataStore } from '../src/db/index.js';
import { buildVendorBotLink, registerVendorRoutes } from '../src/routes/vendors.js';

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

function registerTestRoutes(store) {
  const app = createApp();
  registerVendorRoutes(app, {
    store,
    requireAdmin,
    appbegStore: {
      async getFinancialReportForPlayerUids(playerUids = []) {
        return {
          configured: true,
          players: playerUids.map((uid) => ({ uid, total_in: 0, total_out: 0, net: 0, last_activity: null }))
        };
      }
    }
  });
  return app.routes;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function testVendorBotLinks() {
  assert.equal(
    buildVendorBotLink('VND-000001', { TELEGRAM_BOT_USERNAME: '@RoyalSweepsBot' }),
    'https://t.me/RoyalSweepsBot?start=VND-000001'
  );
  assert.equal(
    buildVendorBotLink('VND 000001', { TELEGRAM_BOT_USERNAME: 'RoyalSweepsBot' }),
    'https://t.me/RoyalSweepsBot?start=VND%20000001'
  );
  assert.equal(
    buildVendorBotLink('VND-000002', { ROYAL_VIP_TELEGRAM_BOT_URL: 'https://t.me/@RoyalSweepsBot' }),
    'https://t.me/RoyalSweepsBot?start=VND-000002'
  );
  assert.equal(buildVendorBotLink('VND-000001', {}), null);
}

async function testVendorPayloadHasBotLinkAndNoStaffLink() {
  const previous = process.env.TELEGRAM_BOT_USERNAME;
  process.env.TELEGRAM_BOT_USERNAME = '@RoyalSweepsBot';
  try {
    await withStore('vendor-payload-link', async (store) => {
      const routes = registerTestRoutes(store);
      const createRes = await runHandlers(routes['POST /api/vendors'], {
        ledgerUser: { role: 'admin' },
        body: {
          name: 'Bot Link Vendor',
          username: 'bot_link_vendor',
          password: 'password123',
          commissionPercentage: 7.5,
          [['linked', 'Staff', 'Uid'].join('')]: 'obsolete',
          notes: 'Payload test'
        }
      });
      assert.equal(createRes.statusCode, 201);
      assert.equal(createRes.payload.vendor.vendorBotLink, 'https://t.me/RoyalSweepsBot?start=VND-000001');
      assert.equal(Object.hasOwn(createRes.payload.vendor, ['linked', 'Staff', 'Uid'].join('')), false);
      assert.equal(Object.hasOwn(createRes.payload.vendor, ['linked', 'staff', 'uid'].join('_')), false);

      const listRes = await runHandlers(routes['GET /api/vendors'], {
        ledgerUser: { role: 'admin' },
        query: {}
      });
      assert.equal(listRes.statusCode, 200);
      assert.equal(listRes.payload.vendors[0].vendorBotLink, 'https://t.me/RoyalSweepsBot?start=VND-000001');
      assert.equal(Object.hasOwn(listRes.payload.vendors[0], ['linked', 'Staff', 'Uid'].join('')), false);
    });
  } finally {
    restoreEnv('TELEGRAM_BOT_USERNAME', previous);
  }
}

async function testVendorPayloadLinkUnavailable() {
  const previousUsername = process.env.TELEGRAM_BOT_USERNAME;
  const previousVendorUsername = process.env.VENDOR_TELEGRAM_BOT_USERNAME;
  const previousRoyalUrl = process.env.ROYAL_VIP_TELEGRAM_BOT_URL;
  const previousBotUrl = process.env.TELEGRAM_BOT_URL;
  process.env.TELEGRAM_BOT_USERNAME = '';
  process.env.VENDOR_TELEGRAM_BOT_USERNAME = '';
  process.env.ROYAL_VIP_TELEGRAM_BOT_URL = '';
  process.env.TELEGRAM_BOT_URL = '';
  try {
    await withStore('vendor-payload-no-link', async (store) => {
      const routes = registerTestRoutes(store);
      const createRes = await runHandlers(routes['POST /api/vendors'], {
        ledgerUser: { role: 'admin' },
        body: {
          name: 'No Link Vendor',
          username: 'no_link_vendor',
          password: 'password123'
        }
      });
      assert.equal(createRes.statusCode, 201);
      assert.equal(createRes.payload.vendor.vendorBotLink, null);
    });
  } finally {
    restoreEnv('TELEGRAM_BOT_USERNAME', previousUsername);
    restoreEnv('VENDOR_TELEGRAM_BOT_USERNAME', previousVendorUsername);
    restoreEnv('ROYAL_VIP_TELEGRAM_BOT_URL', previousRoyalUrl);
    restoreEnv('TELEGRAM_BOT_URL', previousBotUrl);
  }
}

async function testDeleteVendorSucceedsWithZeroPlayers() {
  await withStore('vendor-delete-empty', async (store) => {
    const vendor = await store.createVendor({ name: 'Delete Me' });
    await store.createVendorSettlement(vendor.id, {
      amount: 12.34,
      settlementDate: '2026-07-27',
      createdBy: 'admin'
    });
    const routes = registerTestRoutes(store);
    const res = await runHandlers(routes['DELETE /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { deleted: true, vendorId: vendor.id });
    assert.equal(await store.getVendor(vendor.id), null);
    assert.equal((await store.listVendorSettlements(vendor.id)).length, 0);
  });
}

async function testDeleteVendorBlockedWithOwnedPlayers() {
  await withStore('vendor-delete-owned', async (store) => {
    const vendor = await store.createVendor({ name: 'Owned Vendor' });
    const contact = await store.upsertTelegramUser({ id: 99101, username: 'owned_delete', first_name: 'Owned', is_bot: false });
    await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
    const linked = await store.linkVendorPlayerForContact({ contactId: contact.id, appbegPlayerUid: 'owned-delete-uid' });
    assert.equal(linked.linked, true);
    const routes = registerTestRoutes(store);
    const res = await runHandlers(routes['DELETE /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: String(vendor.id) }
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /still owns players/i);
    assert.ok(await store.getVendor(vendor.id));
    assert.ok(await store.getVendorPlayerByAppBegUid('owned-delete-uid'));
  });
}

async function testDeleteUnknownVendor() {
  await withStore('vendor-delete-unknown', async (store) => {
    const routes = registerTestRoutes(store);
    const res = await runHandlers(routes['DELETE /api/vendors/:id'], {
      ledgerUser: { role: 'admin' },
      params: { id: '9999' }
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, { error: 'Vendor not found.' });
  });
}

async function testDeleteRollbackPreservesSettlementHistory() {
  await withStore('vendor-delete-rollback', async (store) => {
    const vendor = await store.createVendor({ name: 'Rollback Vendor' });
    await store.createVendorSettlement(vendor.id, {
      amount: 45,
      settlementDate: '2026-07-27',
      createdBy: 'admin'
    });
    await store.db.exec(`
      CREATE TRIGGER vendor_delete_abort
      BEFORE DELETE ON vendors
      WHEN OLD.name = 'Rollback Vendor'
      BEGIN
        SELECT RAISE(ABORT, 'rollback test');
      END
    `);
    await assert.rejects(() => store.deleteVendor(vendor.id), /rollback test/);
    assert.ok(await store.getVendor(vendor.id));
    assert.equal((await store.listVendorSettlements(vendor.id)).length, 1);
  });
}

async function testVendorUiControlsAndNoStaffCopy() {
  const source = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(source, /Telegram Bot/);
  assert.match(source, /data-vendor-copy="link"/);
  assert.match(source, /data-vendor-copy="code"/);
  assert.match(source, /data-vendor-open-bot/);
  assert.match(source, /data-vendor-download-qr/);
  assert.match(source, /data-vendor-telegram-qr/);
  assert.match(source, /Telegram link not configured/);
  assert.match(source, /Download QR/);
  assert.match(source, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(source, /await refreshVendors\(\)/);
  const retiredTerms = [
    ['Linked', 'Staff'].join(' '),
    ['Reporting', 'Only'].join(' '),
    ['vendor', 'Linked', 'Staff', 'Uid'].join(''),
    ['linked', 'Staff', 'Uid'].join(''),
    ['linked', 'staff', 'uid'].join('_')
  ];
  for (const term of retiredTerms) {
    assert.equal(source.includes(term), false);
  }
}

async function testVendorTelegramQrHelpers() {
  const {
    telegramQrFilename,
    telegramHandleFromUrl,
    DOWNLOAD_CARD_WIDTH,
    QR_ERROR_CORRECTION,
    LOGO_SIZE_RATIO
  } = await import('../public/telegramQr.js');

  assert.equal(telegramQrFilename('Acme Games'), 'acme-games-telegram-qr.png');
  assert.equal(telegramQrFilename('  Vendor #2!! '), 'vendor-2-telegram-qr.png');
  assert.equal(telegramQrFilename(''), 'vendor-telegram-qr.png');
  assert.ok(DOWNLOAD_CARD_WIDTH >= 1024);
  assert.equal(QR_ERROR_CORRECTION, 'H');
  assert.ok(LOGO_SIZE_RATIO > 0 && LOGO_SIZE_RATIO <= 0.25);

  assert.equal(
    telegramHandleFromUrl('https://t.me/Royal_Sweeps_bot?start=VND-000004'),
    '@Royal_Sweeps_bot'
  );
  assert.equal(telegramHandleFromUrl('https://t.me/BotAlpha?start=VND-000001'), '@BotAlpha');
  assert.equal(telegramHandleFromUrl(''), '');

  const QRCode = (await import('qrcode')).default;
  const linkA = buildVendorBotLink('VND-000001', { TELEGRAM_BOT_USERNAME: 'BotAlpha' });
  const linkB = buildVendorBotLink('VND-000002', { TELEGRAM_BOT_USERNAME: 'BotBeta' });
  assert.equal(linkA, 'https://t.me/BotAlpha?start=VND-000001');
  assert.equal(linkB, 'https://t.me/BotBeta?start=VND-000002');
  assert.notEqual(linkA, linkB);

  for (const link of [linkA, linkB]) {
    const created = QRCode.create(link, { errorCorrectionLevel: QR_ERROR_CORRECTION });
    const encoded = created.segments.map((segment) => {
      const data = segment.data;
      if (typeof data === 'string') return data;
      return Buffer.from(data).toString('utf8');
    }).join('');
    assert.equal(encoded, link);

    const png = await QRCode.toBuffer(link, {
      type: 'png',
      width: 1024,
      margin: 3,
      errorCorrectionLevel: QR_ERROR_CORRECTION,
      color: { dark: '#0a7a45', light: '#ffffff' }
    });
    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
    assert.equal(png[2], 0x4e);
    assert.equal(png[3], 0x47);
    assert.ok(png.length > 1500, 'PNG should be large enough for print/share use');
  }

  assert.equal(buildVendorBotLink('VND-000001', {}), null);
  const qrSource = await fs.readFile(path.join(process.cwd(), 'public/telegramQr.js'), 'utf8');
  assert.match(qrSource, /URL\.revokeObjectURL/);
  assert.match(qrSource, /createObjectURL/);
  assert.match(qrSource, /from '\.\/lib\/qrcode\.js'/);
  assert.match(qrSource, /renderBrandedTelegramQrCard/);
  assert.match(qrSource, /Scan to open Telegram/);
  assert.match(qrSource, /drawCenterLogo|drawTelegramPlane/);

  // Optional end-to-end decode of the branded card when node-canvas is available.
  try {
    const { createCanvas } = await import('canvas');
    const jsQR = (await import('jsqr')).default;
    globalThis.document = {
      createElement(tag) {
        if (tag === 'canvas') return createCanvas(10, 10);
        throw new Error(`unsupported element: ${tag}`);
      }
    };
    const { renderBrandedTelegramQrCard } = await import('../public/telegramQr.js');
    for (const link of [linkA, linkB]) {
      const canvas = createCanvas(100, 100);
      await renderBrandedTelegramQrCard(canvas, { url: link, width: 1080 });
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(image.data, canvas.width, canvas.height);
      assert.equal(decoded?.data, link);
    }
  } catch (error) {
    if (!/Cannot find package|Cannot find module/.test(String(error?.message || error))) {
      throw error;
    }
  }
}

await testVendorBotLinks();
await testVendorPayloadHasBotLinkAndNoStaffLink();
await testVendorPayloadLinkUnavailable();
await testDeleteVendorSucceedsWithZeroPlayers();
await testDeleteVendorBlockedWithOwnedPlayers();
await testDeleteUnknownVendor();
await testDeleteRollbackPreservesSettlementHistory();
await testVendorUiControlsAndNoStaffCopy();
await testVendorTelegramQrHelpers();
console.log('Vendor admin improvement tests passed.');
