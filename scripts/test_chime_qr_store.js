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
  const replaced = await store.deletePaymentQrCode(inUse.id);
  if (replaced.action !== 'replaced_deleted') {
    throw new Error(`expected active QR replacement delete, got ${replaced.action}`);
  }
  const migratedWindow = await store.getRegistrationPaymentWindow(replaced.affectedWindows[0].id);
  if (Number(migratedWindow.payment_qr_code_id) !== Number(second.id)) {
    throw new Error('active window should point to replacement default QR');
  }
  assert.equal(await store.getPaymentQrCode(inUse.id), null);

  const historical = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: relativePath,
    label: 'Historical QR',
    isActive: true,
    isDefault: false
  });
  const historicalWindow = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: historical.id,
    paymentDisplayName: 'QR User',
    firstDepositAmount: 12.01,
    creditedDepositAmount: 13,
    flowType: 'registration',
    windowMinutes: 7
  });
  await store.claimPaymentWindowMatch(historicalWindow.id, 1).catch(() => null);
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET status = 'completed',
        matched_payment_event_id = 123,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), new Date().toISOString(), historicalWindow.id);
  await assert.rejects(
    store.deletePaymentQrCode(historical.id),
    (error) => error.code === 'QR_IN_USE'
      && /referenced by existing records/.test(error.message)
  );

  await store.db?.close?.();
  fs.rmSync(dbDir, { recursive: true, force: true });

  console.log('ALL PAYMENT METHOD STORE CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
