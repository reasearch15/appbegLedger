import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createDataStore } from '../src/db/index.js';
import { registerPaymentMethodRoutes } from '../src/routes/paymentMethods.js';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-qr-endpoint-'));
const rootDir = path.resolve('.');
const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dbDir, 'test.sqlite') });

const app = express();
app.use(express.json());
registerPaymentMethodRoutes(app, {
  store,
  rootDir,
  requireAdmin: (_req, _res, next) => next()
});

const server = await new Promise((resolve) => {
  const instance = app.listen(0, () => resolve(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const method = await store.createPaymentMethod({ name: 'Endpoint QR', key: `endpointqr${Date.now()}` });
  const unused = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: 'data/media/payment-qr/unused.png',
    label: 'Unused',
    isActive: true,
    isDefault: false
  });
  const replacementDefault = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: 'data/media/payment-qr/default.png',
    label: 'Default',
    isActive: true,
    isDefault: false
  });
  await store.setDefaultPaymentQr(replacementDefault.id);
  const deletedResponse = await fetch(`${baseUrl}/api/payment-qrs/${unused.id}`, { method: 'DELETE' });
  assert.equal(deletedResponse.status, 200);
  assert.equal((await deletedResponse.json()).action, 'deleted');
  assert.equal(await store.getPaymentQrCode(unused.id), null);

  const inUse = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: 'data/media/payment-qr/in-use.png',
    label: 'In Use',
    isActive: true,
    isDefault: false
  });
  const user = await store.upsertTelegramUser({
    id: 99234,
    first_name: 'QR',
    last_name: 'Endpoint',
    username: 'qr_endpoint',
    is_bot: false
  });
  await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: inUse.id,
    paymentDisplayName: 'QR Endpoint',
    firstDepositAmount: 10.01,
    creditedDepositAmount: 11,
    flowType: 'registration',
    windowMinutes: 7
  });
  const blockedResponse = await fetch(`${baseUrl}/api/payment-qrs/${inUse.id}`, { method: 'DELETE' });
  const blockedPayload = await blockedResponse.json();
  assert.equal(blockedResponse.status, 409);
  assert.equal(blockedPayload.code, 'QR_IN_USE');
  assert.match(blockedPayload.error, /referenced by existing records/);
  const stillThere = await store.getPaymentQrCode(inUse.id);
  assert.equal(Boolean(stillThere), true);
  assert.equal(stillThere.is_active, true);

  console.log('ok payment QR delete endpoint');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await store.db?.close?.();
  fs.rmSync(dbDir, { recursive: true, force: true });
}
