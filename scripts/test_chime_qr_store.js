import fs from 'node:fs';
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

  const store = await createDataStore();
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

  await store.deletePaymentMethod(method.id);

  console.log('ALL PAYMENT METHOD STORE CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
