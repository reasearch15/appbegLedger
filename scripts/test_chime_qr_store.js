import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataStore } from '../src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(rootDir, 'data', 'media', 'chime-qr');

async function run() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, `test-${Date.now()}.png`);
  fs.writeFileSync(fixturePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));

  const store = await createDataStore();
  const relativePath = path.relative(rootDir, fixturePath).split(path.sep).join('/');

  const created = await store.createChimeQrCode({
    filePath: relativePath,
    label: 'Test QR',
    isActive: true,
    isDefault: true
  });
  if (!created?.preview_url?.includes('/media/chime-qr/')) {
    throw new Error('preview_url missing');
  }

  const listed = await store.listChimeQrCodes();
  if (!listed.some((item) => item.id === created.id)) {
    throw new Error('created QR not listed');
  }

  const hasDefault = await store.hasActiveDefaultChimeQr();
  if (!hasDefault) throw new Error('expected active default');

  const deleted = await store.deleteChimeQrCode(created.id);
  if (deleted.action !== 'deleted') {
    throw new Error(`expected hard delete, got ${deleted.action}`);
  }

  console.log('ALL CHIME QR STORE CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
