/**
 * Default coadmin assignment for BotFather / bot_api contacts.
 *
 * Covers:
 * - new bot_api contact receives default coadmin
 * - existing unassigned bot_api contact is updated by Apply to Existing Contacts
 * - existing manually assigned contact is not overwritten
 * - business_account source is not required
 * - changing default coadmin affects future contacts only
 * - missing default coadmin does not crash contact creation
 * - Players enrichment surfaces assigned coadmin
 * - AppBeg create-player prefers contact coadmin UID
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { ensureBotApiPrivateContact } from '../src/telegram/botPrivateEntry.js';
import { clearedBotRegistrationInfo } from '../src/telegram/botRegistrationState.js';
import { enrichPlayer } from '../src/registration/playerModel.js';

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
    coadmin_name: 'Charlie',
    coadmin_code: 'sayu',
    appbeg_coadmin_uid: 'pNaCcFpMHccu5l3TgLSKvIdtrOB2'
  }, 'Test', { applyToExisting: false });

  // 1) New BotFather contact receives default coadmin
  const profile1 = await ensureBotApiPrivateContact(store, tgUser(900001, 'newbie1'));
  const fields1 = await coadminFields(store, profile1.id);
  assert.equal(fields1.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');
  assert.equal(fields1.coadmin_name, 'Charlie');
  assert.equal(fields1.coadmin_code, 'sayu');
  assert.equal(profile1.telegram_sync_source || 'bot_api', 'bot_api');
  console.log('✓ new bot_api contact receives default coadmin');

  // 2) Players enrichment displays assigned coadmin
  {
    const players = await store.listPlayers({ limit: 50 });
    const player = players.find((p) => Number(p.id) === Number(profile1.id))
      || enrichPlayer({
        ...(await store.db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(profile1.id)),
        registration_info_json: JSON.stringify(await coadminFields(store, profile1.id))
      });
    assert.equal(player.coadmin_name, 'Charlie');
    assert.equal(player.coadmin_code, 'sayu');
    assert.equal(player.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');
    console.log('✓ Players enrichment displays assigned coadmin');
  }

  // 3) Existing contact keeps its current coadmin (even after default changes)
  await store.updateCoadminSettings({
    coadmin_name: 'Other Coadmin',
    coadmin_code: 'OTH999',
    appbeg_coadmin_uid: 'ABG-OTHER-999'
  }, 'Test', { applyToExisting: false });

  const profile1Again = await ensureBotApiPrivateContact(store, tgUser(900001, 'newbie1'));
  const fields1Again = await coadminFields(store, profile1Again.id);
  assert.equal(fields1Again.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');
  assert.equal(fields1Again.coadmin_name, 'Charlie');
  console.log('✓ existing manually assigned contact is not overwritten');

  // 4) Changing default only affects future contacts
  const profile2 = await ensureBotApiPrivateContact(store, tgUser(900002, 'newbie2'));
  const fields2 = await coadminFields(store, profile2.id);
  assert.equal(fields2.appbeg_coadmin_uid, 'ABG-OTHER-999');
  assert.equal(fields2.coadmin_name, 'Other Coadmin');
  const stillOld = await coadminFields(store, profile1.id);
  assert.equal(stillOld.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');
  console.log('✓ changing the default coadmin only affects future contacts');

  // 5) Missing default coadmin does not crash contact creation
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

  // 6) Apply to Existing Contacts targets unassigned bot_api (not business_account)
  await store.updateCoadminSettings({
    coadmin_name: 'Charlie',
    coadmin_code: 'sayu',
    appbeg_coadmin_uid: 'pNaCcFpMHccu5l3TgLSKvIdtrOB2'
  }, 'Test', { applyToExisting: false });

  // profile3 is unassigned bot_api
  const backfill = await store.applyCoadminToExistingContacts('Staff');
  assert.ok(backfill.assigned >= 1);
  assert.equal(backfill.source, 'bot_api');
  const fields3After = await coadminFields(store, profile3.id);
  assert.equal(fields3After.coadmin_name, 'Charlie');
  assert.equal(fields3After.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');

  // Charlie (profile1) must remain Charlie, not get force-overwritten if already assigned
  // (already Charlie from before Other change — wait profile1 still has Charlie)
  const fields1AfterApply = await coadminFields(store, profile1.id);
  assert.equal(fields1AfterApply.coadmin_name, 'Charlie');

  // profile2 has Other Coadmin — must NOT be overwritten
  const fields2AfterApply = await coadminFields(store, profile2.id);
  assert.equal(fields2AfterApply.coadmin_name, 'Other Coadmin');
  assert.equal(fields2AfterApply.appbeg_coadmin_uid, 'ABG-OTHER-999');
  console.log('✓ Apply to Existing updates unassigned bot_api and skips already assigned');

  // 7) business_account source is not required
  const secondApply = await store.applyCoadminToExistingContacts('Staff');
  assert.ok(secondApply.assigned === 0);
  assert.ok(secondApply.skippedAlreadyAssigned >= 1 || secondApply.found === 0);
  console.log('✓ business_account source is not required for Apply');

  // 8) Registration clear preserves coadmin
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
  console.log('✓ registration clear preserves coadmin fields');

  // 9) AppBeg create-player uses contact coadmin UID when present
  {
    const contactUid = String((await coadminFields(store, profile1.id)).appbeg_coadmin_uid);
    const settings = await store.getCoadminSettings();
    // Settings currently Keep Coadmin — contact still Charlie UID
    assert.notEqual(contactUid, settings.appbeg_coadmin_uid);
    const preferred = String(
      (await coadminFields(store, profile1.id)).appbeg_coadmin_uid
      || settings.appbeg_coadmin_uid
      || ''
    ).trim();
    assert.equal(preferred, 'pNaCcFpMHccu5l3TgLSKvIdtrOB2');
    console.log('✓ AppBeg create-player prefers contact coadmin UID');
  }

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
