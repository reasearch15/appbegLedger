import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataStore } from '../src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(rootDir, 'data', 'media', 'payment-qr');

async function run() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, `test-${Date.now()}.png`);
  fs.writeFileSync(fixturePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-qr-store-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dbDir, 'test.sqlite') });
  const relativePath = path.relative(rootDir, fixturePath).split(path.sep).join('/');

  const method = await store.createPaymentMethod({ name: 'Test Method', key: `test${Date.now()}` });
  const created = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: relativePath,
    label: 'Test QR',
    isActive: true,
    isDefault: true
  });
  if (!created?.preview_url?.includes('/media/payment-qr/')) {
    throw new Error('preview_url missing');
  }

  const listed = await store.listPaymentQrCodes(method.id);
  if (!listed.some((item) => item.id === created.id)) {
    throw new Error('created QR not listed');
  }

  const defaultQr = await store.getActiveDefaultPaymentQr(method.id);
  if (!defaultQr) throw new Error('expected active default');

  const second = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: relativePath,
    label: 'Second QR',
    isActive: true,
    isDefault: false
  });
  await store.setDefaultPaymentQr(second.id);

  const deleted = await store.deletePaymentQrCode(created.id);
  if (deleted.action !== 'deleted') {
    throw new Error(`expected hard delete, got ${deleted.action}`);
  }

  const inUse = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: relativePath,
    label: 'In Use QR',
    isActive: true,
    isDefault: false
  });
  const user = await store.upsertTelegramUser({
    id: 99123,
    first_name: 'QR',
    last_name: 'User',
    username: 'qr_user',
    is_bot: false
  });
  await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: inUse.id,
    paymentDisplayName: 'QR User',
    firstDepositAmount: 10.01,
    creditedDepositAmount: 11,
    flowType: 'registration',
    windowMinutes: 7
  });
  await assert.rejects(
    store.deletePaymentQrCode(inUse.id),
    (error) => error.code === 'QR_IN_USE'
      && /referenced by existing records/.test(error.message)
  );
  const stillThere = await store.getPaymentQrCode(inUse.id);
  if (!stillThere || !stillThere.is_active) {
    throw new Error('in-use QR should remain present and active after failed delete');
  }

  await store.db?.close?.();
  fs.rmSync(dbDir, { recursive: true, force: true });

  console.log('ALL PAYMENT METHOD STORE CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
