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
  const archivedHistorical = await store.deletePaymentQrCode(historical.id);
  assert.equal(archivedHistorical.action, 'archived');
  const hiddenHistoricalList = await store.listPaymentQrCodes(method.id);
  assert.equal(hiddenHistoricalList.some((qr) => Number(qr.id) === Number(historical.id)), false);
  const historicalAfterArchive = await store.getPaymentQrCode(historical.id);
  assert.ok(historicalAfterArchive.archived_at);
  const historicalWindowAfterArchive = await store.getRegistrationPaymentWindow(historicalWindow.id);
  assert.equal(Number(historicalWindowAfterArchive.payment_qr_code_id), Number(historical.id));

  const mixed = await store.createPaymentQrCode({
    paymentMethodId: method.id,
    filePath: relativePath,
    label: 'Mixed QR',
    isActive: true,
    isDefault: false
  });
  const mixedActiveWindow = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: mixed.id,
    paymentDisplayName: 'QR User',
    firstDepositAmount: 13.01,
    creditedDepositAmount: 14,
    flowType: 'deposit',
    windowMinutes: 7
  });
  const mixedHistoricalWindow = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: method.id,
    paymentQrCodeId: mixed.id,
    paymentDisplayName: 'QR User',
    firstDepositAmount: 14.01,
    creditedDepositAmount: 15,
    flowType: 'registration',
    windowMinutes: 7
  });
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET status = 'completed',
        matched_payment_event_id = 456,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), new Date().toISOString(), mixedHistoricalWindow.id);
  const replacedArchived = await store.deletePaymentQrCode(mixed.id);
  assert.equal(replacedArchived.action, 'replaced_archived');
  const mixedActiveAfter = await store.getRegistrationPaymentWindow(mixedActiveWindow.id);
  const mixedHistoricalAfter = await store.getRegistrationPaymentWindow(mixedHistoricalWindow.id);
  assert.equal(Number(mixedActiveAfter.payment_qr_code_id), Number(second.id));
  assert.equal(Number(mixedHistoricalAfter.payment_qr_code_id), Number(mixed.id));
  assert.ok((await store.getPaymentQrCode(mixed.id)).archived_at);

  const noReplacementMethod = await store.createPaymentMethod({ name: 'No Replacement', key: `norepl${Date.now()}` });
  const lonelyDefault = await store.createPaymentQrCode({
    paymentMethodId: noReplacementMethod.id,
    filePath: relativePath,
    label: 'Only Default',
    isActive: true,
    isDefault: true
  });
  const lonelyOld = await store.createPaymentQrCode({
    paymentMethodId: noReplacementMethod.id,
    filePath: relativePath,
    label: 'No Replacement QR',
    isActive: true,
    isDefault: false
  });
  await store.updatePaymentQrCode(lonelyDefault.id, { is_active: false, force: true });
  await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: noReplacementMethod.id,
    paymentQrCodeId: lonelyOld.id,
    paymentDisplayName: 'QR User',
    firstDepositAmount: 15.01,
    creditedDepositAmount: 16,
    flowType: 'registration',
    windowMinutes: 7
  });
  await assert.rejects(
    store.deletePaymentQrCode(lonelyOld.id),
    (error) => error.code === 'QR_REPLACEMENT_REQUIRED'
      && /Set another active QR as default before replacing this QR/.test(error.message)
  );

  await store.db?.close?.();
  fs.rmSync(dbDir, { recursive: true, force: true });

  console.log('ALL PAYMENT METHOD STORE CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
