import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';

async function withStore(name, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `appbeg-ledger-${name}-`));
  const store = await createDataStore({
    dialect: 'sqlite',
    databasePath: path.join(dir, 'test.sqlite')
  });
  try {
    await fn(store);
  } finally {
    await store.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createContact(store, telegramId, username) {
  return await store.upsertTelegramUser({
    id: telegramId,
    username,
    first_name: username,
    is_bot: false
  });
}

async function loadContactDetailPayload(store, contactId) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) return null;
  return {
    contact,
    messages: await store.listMessagesForUser(contact.id),
    notes: await store.listNotesForUser(contact.id),
    timeline: await store.listTimelineForUser(contact.id),
    tags: await store.listTags(),
    quickReplies: await store.listQuickReplies(),
    automationState: await store.getAutomationState(contact.id),
    registrationPaymentPenalty: await store.getRegistrationPaymentPenaltyStatus(contact.id)
  };
}

async function testContactWithoutVendorLoadsNotes() {
  await withStore('contact-no-vendor', async (store) => {
    const contact = await createContact(store, 34001, 'no_vendor');
    await store.addNote(contact.id, { staffName: 'Ops', text: 'Plain contact note' });

    const payload = await loadContactDetailPayload(store, contact.id);
    assert.equal(payload.contact.id, contact.id);
    assert.equal(payload.contact.username, 'no_vendor');
    assert.equal(payload.notes.length, 1);
    assert.equal(payload.notes[0].note_text, 'Plain contact note');
  });
}

async function testContactWithVendorLoadsNotes() {
  await withStore('contact-with-vendor', async (store) => {
    const vendor = await store.createVendor({ name: 'Royal VIP East' });
    const contact = await createContact(store, 34002, 'with_vendor');
    await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
    const linked = await store.linkVendorPlayerForContact({
      contactId: contact.id,
      appbegPlayerUid: 'appbeg_with_vendor',
      actorName: 'Test'
    });
    assert.equal(linked.linked, true);
    await store.addNote(contact.id, { staffName: 'Ops', text: 'Vendor contact note' });

    const payload = await loadContactDetailPayload(store, contact.id);
    assert.equal(payload.contact.id, contact.id);
    assert.equal(payload.notes.length, 1);
    assert.equal(payload.notes[0].note_text, 'Vendor contact note');
    const ownership = await store.getVendorPlayerByContactId(contact.id);
    assert.equal(ownership.vendor_id, vendor.id);
  });
}

async function testSuspendedVendorContactStillLoads() {
  await withStore('contact-suspended-vendor', async (store) => {
    const vendor = await store.createVendor({ name: 'Suspended Vendor' });
    await store.db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run('suspended', vendor.id);
    const contact = await createContact(store, 34003, 'suspended_vendor');
    await store.addNote(contact.id, { staffName: 'Ops', text: 'Suspended vendor note' });

    const payload = await loadContactDetailPayload(store, contact.id);
    assert.equal(payload.contact.id, contact.id);
    assert.equal(payload.notes.length, 1);
    assert.equal(payload.notes[0].note_text, 'Suspended vendor note');
  });
}

async function testUnknownContactReturnsNull() {
  await withStore('contact-unknown', async (store) => {
    const payload = await loadContactDetailPayload(store, 999999);
    assert.equal(payload, null);
  });
}

async function testNotesQueryHasNoUnresolvedVAlias() {
  const source = await fs.readFile(path.join(process.cwd(), 'src/db/index.js'), 'utf8');
  const match = source.match(/async function listNotesForUser[\s\S]*?async function listTimelineForUser/);
  assert.ok(match, 'listNotesForUser source should be present');
  assert.doesNotMatch(match[0], /\bv\./);
  assert.match(match[0], /ORDER BY created_at DESC, id DESC/);
}

(async () => {
  await testContactWithoutVendorLoadsNotes();
  await testContactWithVendorLoadsNotes();
  await testSuspendedVendorContactStillLoads();
  await testUnknownContactReturnsNull();
  await testNotesQueryHasNoUnresolvedVAlias();
  console.log('Contact detail vendor alias regression tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
