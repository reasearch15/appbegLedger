import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAppBegPlayerForContact } from '../src/appbeg/createPlayerService.js';
import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

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

async function testVendorOwnershipMapping() {
  await withStore('vendor-ownership', async (store) => {
    const vendor = await store.createVendor({ name: 'Referral Desk', commissionPercentage: 0 });
    const contact = await store.upsertTelegramUser({
      id: 101,
      first_name: 'Vera',
      last_name: 'Player',
      username: 'vera_player',
      is_bot: false
    });

    const captured = await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
    assert.equal(captured.captured, true);

    const linked = await store.linkVendorPlayerForContact({
      contactId: contact.id,
      appbegPlayerUid: 'appbeg_player_1',
      actorName: 'Test'
    });
    assert.equal(linked.linked, true);
    assert.equal(linked.mapping.vendor_id, vendor.id);
    assert.equal(linked.mapping.telegram_contact_id, contact.id);
    assert.equal(linked.mapping.appbeg_player_uid, 'appbeg_player_1');

    const players = await store.listVendorPlayers(vendor.id);
    assert.equal(players.length, 1);
    assert.equal(players[0].telegram_name, 'Vera Player');
    assert.equal(players[0].telegram_username, 'vera_player');
    assert.equal(players[0].appbeg_player_uid, 'appbeg_player_1');
  });
}

async function testReferralCaptureFromStartPayload() {
  const calls = [];
  let registrationInfo = {};
  const store = {
    async ensureAutomationState() {
      return { current_flow: null, current_step: null, registration_info: { ...registrationInfo } };
    },
    async getBotSession() {
      return null;
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async captureVendorReferralForContact(contactId, code, actorName) {
      calls.push({ contactId, code, actorName });
      registrationInfo = {
        ...registrationInfo,
        vendor_code: code,
        vendor_id: 1
      };
      return { captured: true };
    }
  };

  const decision = await decideBotReply({
    store,
    contact: {
      id: 202,
      telegram_id: 990202,
      display_name: 'Start Payload',
      username: 'start_payload',
      registration_status: 'New'
    },
    messageText: '/start VND-000001'
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { contactId: 202, code: 'VND-000001', actorName: 'TelegramStart' });
  assert.equal(decision.statePatch.registrationInfo.vendor_code, 'VND-000001');
  assert.equal(decision.kind, 'welcome');
}

async function testDuplicateOwnershipIsNotOverwritten() {
  await withStore('vendor-duplicates', async (store) => {
    const firstVendor = await store.createVendor({ name: 'First Vendor' });
    const secondVendor = await store.createVendor({ name: 'Second Vendor' });
    const firstContact = await store.upsertTelegramUser({ id: 301, first_name: 'First', is_bot: false });
    const secondContact = await store.upsertTelegramUser({ id: 302, first_name: 'Second', is_bot: false });

    await store.captureVendorReferralForContact(firstContact.id, firstVendor.vendor_code);
    await store.captureVendorReferralForContact(secondContact.id, secondVendor.vendor_code);
    const firstLink = await store.linkVendorPlayerForContact({
      contactId: firstContact.id,
      appbegPlayerUid: 'same_appbeg_uid'
    });
    assert.equal(firstLink.linked, true);

    const duplicatePlayer = await store.linkVendorPlayerForContact({
      contactId: secondContact.id,
      appbegPlayerUid: 'same_appbeg_uid'
    });
    assert.equal(duplicatePlayer.linked, false);
    assert.equal(duplicatePlayer.reason, 'player_already_owned');

    const laterReferral = await store.captureVendorReferralForContact(firstContact.id, secondVendor.vendor_code);
    assert.equal(laterReferral.captured, false);
    assert.equal(laterReferral.reason, 'already_owned');

    const duplicateContact = await store.linkVendorPlayerForContact({
      contactId: firstContact.id,
      appbegPlayerUid: 'different_appbeg_uid'
    });
    assert.equal(duplicateContact.linked, false);
    assert.equal(duplicateContact.reason, 'contact_already_owned');

    assert.equal((await store.listVendorPlayers(firstVendor.id)).length, 1);
    assert.equal((await store.listVendorPlayers(secondVendor.id)).length, 0);
  });
}

async function testInvalidSuspendedAndMalformedReferralsAreIgnored() {
  await withStore('vendor-invalid-referrals', async (store) => {
    const activeVendor = await store.createVendor({ name: 'Active Vendor' });
    const suspendedVendor = await store.createVendor({ name: 'Suspended Vendor' });
    await store.db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run('suspended', suspendedVendor.id);
    const contact = await store.upsertTelegramUser({ id: 351, first_name: 'Invalid', is_bot: false });

    const malformed = await store.captureVendorReferralForContact(contact.id, 'not-a-vendor');
    assert.equal(malformed.captured, false);
    assert.equal(malformed.reason, 'invalid_vendor_code');

    const unknown = await store.captureVendorReferralForContact(contact.id, 'VND-999999');
    assert.equal(unknown.captured, false);
    assert.equal(unknown.reason, 'vendor_not_found');

    const suspended = await store.captureVendorReferralForContact(contact.id, suspendedVendor.vendor_code);
    assert.equal(suspended.captured, false);
    assert.equal(suspended.reason, 'vendor_not_found');

    const valid = await store.captureVendorReferralForContact(contact.id, activeVendor.vendor_code);
    assert.equal(valid.captured, true);
  });
}

async function testReferralMetadataPreservesExistingRegistrationInfo() {
  await withStore('vendor-metadata-preserve', async (store) => {
    const vendor = await store.createVendor({ name: 'Metadata Vendor' });
    const contact = await store.upsertTelegramUser({ id: 361, first_name: 'Meta', is_bot: false });
    await store.updateRegistrationInfo(contact.id, {
      preferred_appbeg_username: 'MetaPlayer',
      appbeg_password: 'secret123',
      nested: { keep: true }
    }, 'Test');

    const captured = await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
    assert.equal(captured.captured, true);

    const state = await store.ensureAutomationState(contact.id);
    assert.equal(state.registration_info.preferred_appbeg_username, 'MetaPlayer');
    assert.equal(state.registration_info.appbeg_password, 'secret123');
    assert.deepEqual(state.registration_info.nested, { keep: true });
    assert.equal(state.registration_info.vendor_id, vendor.id);
    assert.equal(state.registration_info.vendor_code, vendor.vendor_code);
  });
}

async function testRegistrationWithoutVendorCreatesNoOwnership() {
  await withStore('vendor-no-referral', async (store) => {
    const contact = await store.upsertTelegramUser({
      id: 401,
      first_name: 'No',
      last_name: 'Referral',
      username: 'no_referral',
      is_bot: false
    });

    const result = await store.linkVendorPlayerForContact({
      contactId: contact.id,
      appbegPlayerUid: 'unowned_player'
    });
    assert.equal(result.linked, false);
    assert.equal(result.reason, 'no_vendor_referral');
    assert.equal((await store.listVendorPlayers(1)).length, 0);
  });
}

async function testVendorDeletionDoesNotCascadeOwnership() {
  await withStore('vendor-delete-protection', async (store) => {
    const vendor = await store.createVendor({ name: 'Protected Vendor' });
    const contact = await store.upsertTelegramUser({ id: 451, first_name: 'Protected', is_bot: false });
    await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
    const linked = await store.linkVendorPlayerForContact({
      contactId: contact.id,
      appbegPlayerUid: 'protected_uid'
    });
    assert.equal(linked.linked, true);

    let deleteBlocked = false;
    try {
      await store.db.prepare('DELETE FROM vendors WHERE id = ?').run(vendor.id);
    } catch (error) {
      deleteBlocked = /constraint|foreign key/i.test(String(error.message || error.code || ''));
    }
    assert.equal(deleteBlocked, true);
    assert.equal((await store.listVendorPlayers(vendor.id)).length, 1);
  });
}

async function testCreatePlayerWithoutVendorStillSucceeds() {
  const originalFetch = globalThis.fetch;
  const originalBot = globalThis.telegramBot;
  const originalEnv = {
    APPBEG_API_URL: process.env.APPBEG_API_URL,
    APPBEG_LEDGER_INTERNAL_TOKEN: process.env.APPBEG_LEDGER_INTERNAL_TOKEN
  };
  const calls = [];

  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ ok: true, playerUid: 'created_uid', username: 'NoVendor01' });
    }
  });
  globalThis.telegramBot = {
    telegram: {
      async sendMessage() {
        return { message_id: 1 };
      }
    }
  };

  const store = {
    async getUserProfile(id) {
      return { id, telegram_id: 7001, registration_status: 'Pending Verification' };
    },
    async getAutomationState() {
      return {
        registration_info: {
          payment_confirmed: true,
          preferred_appbeg_username: 'NoVendor01',
          appbeg_password: 'secret123',
          registration_payment_window_id: 9
        }
      };
    },
    async getCoadminSettings() {
      return { appbeg_coadmin_uid: 'coadmin_1' };
    },
    async getRegistrationPaymentWindow() {
      return {
        id: 9,
        contact_id: 77,
        flow_type: PAYMENT_WINDOW_FLOW.REGISTRATION,
        status: 'matched',
        status_raw: 'completed',
        first_deposit_amount: 10,
        credited_deposit_amount: 10,
        credited_deposit_cents: 1000,
        matched_payment_event_id: 88
      };
    },
    async creditRegisteredDeposit() {},
    async markAppBegPlayerCreated(payload) {
      calls.push(['mark', payload]);
      return { id: payload.userId, registration_status: 'Registered' };
    },
    async linkVendorPlayerForContact(payload) {
      calls.push(['link', payload]);
      return { linked: false, reason: 'no_vendor_referral' };
    },
    async logEvent() {},
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage() {}
  };

  try {
    const created = await createAppBegPlayerForContact(store, { contactId: 77, actorName: 'Test' });
    assert.equal(created.ok, true);
    assert.equal(created.playerUid, 'created_uid');
    assert.equal(calls.some(([name]) => name === 'mark'), true);
    assert.equal(calls.some(([name]) => name === 'link'), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.telegramBot = originalBot;
    if (originalEnv.APPBEG_API_URL == null) delete process.env.APPBEG_API_URL;
    else process.env.APPBEG_API_URL = originalEnv.APPBEG_API_URL;
    if (originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
    else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN;
  }
}

async function testCreatePlayerSucceedsWhenVendorLinkFails() {
  const originalFetch = globalThis.fetch;
  const originalBot = globalThis.telegramBot;
  const originalEnv = {
    APPBEG_API_URL: process.env.APPBEG_API_URL,
    APPBEG_LEDGER_INTERNAL_TOKEN: process.env.APPBEG_LEDGER_INTERNAL_TOKEN
  };
  const calls = [];

  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ ok: true, playerUid: 'created_uid_link_fail', username: 'LinkFail01' });
    }
  });
  globalThis.telegramBot = {
    telegram: {
      async sendMessage() {
        return { message_id: 1 };
      }
    }
  };

  const store = {
    async getUserProfile(id) {
      return { id, telegram_id: 7002, registration_status: 'Pending Verification' };
    },
    async getAutomationState() {
      return {
        registration_info: {
          payment_confirmed: true,
          preferred_appbeg_username: 'LinkFail01',
          appbeg_password: 'secret123',
          registration_payment_window_id: 10
        }
      };
    },
    async getCoadminSettings() {
      return { appbeg_coadmin_uid: 'coadmin_1' };
    },
    async getRegistrationPaymentWindow() {
      return {
        id: 10,
        contact_id: 78,
        flow_type: PAYMENT_WINDOW_FLOW.REGISTRATION,
        status: 'matched',
        status_raw: 'completed',
        first_deposit_amount: 10,
        credited_deposit_amount: 10,
        credited_deposit_cents: 1000,
        matched_payment_event_id: 89
      };
    },
    async creditRegisteredDeposit() {},
    async markAppBegPlayerCreated(payload) {
      calls.push(['mark', payload]);
      return { id: payload.userId, registration_status: 'Registered' };
    },
    async linkVendorPlayerForContact() {
      calls.push(['link']);
      throw new Error('simulated vendor ownership failure');
    },
    async logEvent(event) {
      calls.push(['log', event.eventType]);
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage() {}
  };

  try {
    const created = await createAppBegPlayerForContact(store, { contactId: 78, actorName: 'Test' });
    assert.equal(created.ok, true);
    assert.equal(created.playerUid, 'created_uid_link_fail');
    assert.equal(calls.some(([name]) => name === 'mark'), true);
    assert.equal(calls.some(([name]) => name === 'link'), true);
    assert.equal(calls.some(([name, eventType]) => name === 'log' && eventType === 'vendor_player_link_failed'), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.telegramBot = originalBot;
    if (originalEnv.APPBEG_API_URL == null) delete process.env.APPBEG_API_URL;
    else process.env.APPBEG_API_URL = originalEnv.APPBEG_API_URL;
    if (originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
    else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN;
  }
}

await testVendorOwnershipMapping();
await testReferralCaptureFromStartPayload();
await testDuplicateOwnershipIsNotOverwritten();
await testInvalidSuspendedAndMalformedReferralsAreIgnored();
await testReferralMetadataPreservesExistingRegistrationInfo();
await testRegistrationWithoutVendorCreatesNoOwnership();
await testVendorDeletionDoesNotCascadeOwnership();
await testCreatePlayerWithoutVendorStillSucceeds();
await testCreatePlayerSucceedsWhenVendorLinkFails();
console.log('ok vendors phase2');
