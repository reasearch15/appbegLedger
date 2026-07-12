/**
 * Default coadmin assignment for new BotFather contacts.
 *
 * Covers:
 * - new BotFather contact receives default coadmin
 * - existing contact keeps its current coadmin
 * - changing the default coadmin only affects future contacts
 * - missing default coadmin does not crash contact creation
 * - registration clear/restart preserves coadmin fields
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { ensureBotApiPrivateContact } from '../src/telegram/botPrivateEntry.js';
import { clearedBotRegistrationInfo } from '../src/telegram/botRegistrationState.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-default-coadmin-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');

function tgUser(id, username) {
  return {
    id,
    telegram_id: id,
    username,
    first_name: `User${id}`,
    last_name: null,
    is_bot: false,
    language_code: 'en',
    is_premium: false
  };
}

async function coadminFields(store, userId) {
  const state = await store.getAutomationState(userId);
  const info = state?.registration_info || {};
  return {
    coadmin_name: info.coadmin_name || null,
    coadmin_code: info.coadmin_code || null,
    appbeg_coadmin_uid: info.appbeg_coadmin_uid || null
  };
}

async function run() {
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  await store.updateCoadminSettings({
    coadmin_name: 'Default Coadmin',
    coadmin_code: 'DEF001',
    appbeg_coadmin_uid: 'ABG-DEFAULT-001'
  }, 'Test', { applyToExisting: false });

  // 1) New BotFather contact receives default coadmin
  const profile1 = await ensureBotApiPrivateContact(store, tgUser(900001, 'newbie1'));
  const fields1 = await coadminFields(store, profile1.id);
  assert.equal(fields1.appbeg_coadmin_uid, 'ABG-DEFAULT-001');
  assert.equal(fields1.coadmin_name, 'Default Coadmin');
  assert.equal(fields1.coadmin_code, 'DEF001');
  console.log('✓ new BotFather contact receives default coadmin');

  // 2) Existing contact keeps its current coadmin (even after default changes)
  await store.updateCoadminSettings({
    coadmin_name: 'Other Coadmin',
    coadmin_code: 'OTH999',
    appbeg_coadmin_uid: 'ABG-OTHER-999'
  }, 'Test', { applyToExisting: false });

  const profile1Again = await ensureBotApiPrivateContact(store, tgUser(900001, 'newbie1'));
  const fields1Again = await coadminFields(store, profile1Again.id);
  assert.equal(fields1Again.appbeg_coadmin_uid, 'ABG-DEFAULT-001');
  assert.equal(fields1Again.coadmin_name, 'Default Coadmin');
  assert.equal(fields1Again.coadmin_code, 'DEF001');
  console.log('✓ existing contact keeps its current coadmin');

  // 3) Changing default only affects future contacts
  const profile2 = await ensureBotApiPrivateContact(store, tgUser(900002, 'newbie2'));
  const fields2 = await coadminFields(store, profile2.id);
  assert.equal(fields2.appbeg_coadmin_uid, 'ABG-OTHER-999');
  assert.equal(fields2.coadmin_name, 'Other Coadmin');
  assert.equal(fields2.coadmin_code, 'OTH999');
  const stillOld = await coadminFields(store, profile1.id);
  assert.equal(stillOld.appbeg_coadmin_uid, 'ABG-DEFAULT-001');
  console.log('✓ changing the default coadmin only affects future contacts');

  // 4) Missing default coadmin does not crash contact creation
  await store.updateCoadminSettings({
    coadmin_name: '',
    coadmin_code: '',
    appbeg_coadmin_uid: ''
  }, 'Test', { applyToExisting: false });

  const profile3 = await ensureBotApiPrivateContact(store, tgUser(900003, 'orphan'));
  assert.ok(profile3?.id);
  const fields3 = await coadminFields(store, profile3.id);
  assert.equal(fields3.appbeg_coadmin_uid, null);
  assert.equal(fields3.coadmin_name, null);
  console.log('✓ missing default coadmin does not crash contact creation');

  // 5) Registration clear preserves coadmin (regression for Contact List "—")
  await store.updateCoadminSettings({
    coadmin_name: 'Keep Coadmin',
    coadmin_code: 'KEEP1',
    appbeg_coadmin_uid: 'ABG-KEEP-111'
  }, 'Test', { applyToExisting: false });
  const profile4 = await ensureBotApiPrivateContact(store, tgUser(900004, 'regflow'));
  const beforeClear = await coadminFields(store, profile4.id);
  assert.equal(beforeClear.coadmin_name, 'Keep Coadmin');

  const state = await store.getAutomationState(profile4.id);
  const existingInfo = state.registration_info || {};
  const cleared = clearedBotRegistrationInfo(profile4, existingInfo);
  assert.equal(cleared.coadmin_name, 'Keep Coadmin');
  assert.equal(cleared.coadmin_code, 'KEEP1');
  assert.equal(cleared.appbeg_coadmin_uid, 'ABG-KEEP-111');
  assert.equal(cleared.full_name, undefined);
  console.log('✓ registration clear preserves coadmin fields');

  console.log('\nAll default-coadmin-on-contact tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
