import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '..', 'src', 'db', 'index.js');
let source = fs.readFileSync(target, 'utf8');

const asyncNames = [...source.matchAll(/async function ([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
const syncOnly = new Set([
  'normalizeDisplayName',
  'nowIso',
  'hydrateUser',
  'hydrateAutomationRule',
  'hydrateAutomationState',
  'hydratePlayer',
  'hydratePaymentEvent',
  'hydrateDepositEvent',
  'normalizeTelegramUsername',
  'contactMatchesCoadminAccount',
  'buildCoadminSnapshot'
]);

for (const name of syncOnly) {
  source = source.replace(new RegExp(`async function ${name}\\(`, 'g'), `function ${name}(`);
  const idx = asyncNames.indexOf(name);
  if (idx >= 0) asyncNames.splice(idx, 1);
}

for (const name of asyncNames) {
  const call = new RegExp(`(?<!await\\s)(?<!function )(?<!async function )\\b${name}\\(`, 'g');
  source = source.replace(call, `await ${name}(`);
}

source = source.replace(/await await /g, 'await ');
source = source.replace(/await function /g, 'function ');
source = source.replace(/await async function /g, 'async function ');

fs.writeFileSync(target, source);
console.log(`Patched awaits for ${asyncNames.length} async functions.`);
