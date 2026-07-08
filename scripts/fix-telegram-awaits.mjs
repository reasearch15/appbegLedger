import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'telegram');
const files = ['bot.js', 'automationEngine.js', 'menuEngine.js', 'messageDelivery.js', 'accountSyncProcess.js', 'paymentSyncProcess.js'];

for (const file of files) {
  const target = path.join(root, file);
  let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  source = source.replace(/(?<!await )store\./g, 'await store.');
  source = source.replace(/await await store\./g, 'await store.');
  fs.writeFileSync(target, source);
  console.log('Patched', file);
}
