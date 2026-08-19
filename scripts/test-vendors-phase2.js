import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAppBegPlayerForContact } from '../src/appbeg/createPlayerService.js';
import { createDataStore } from '../src/db/index.js';
import { registerVendorRoutes } from '../src/routes/vendors.js';
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

function createApp() {
  const routes = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    routes[method] = (pathname, ...handlers) => {
      routes[`${method.toUpperCase()} ${pathname}`] = handlers;
    };
  }
  return routes;
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

async function runHandlers(handlers, req = {}) {
  const res = createResponse();
  let index = -1;
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (handlers[index]) await handlers[index](req, res, next);
  };
  await next();
  return res;
}

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function fakeFinancialStore(records = []) {
  return {
    async getFinancialReportForPlayerUids(playerUids = []) {
      return {
        configured: true,
        source: 'test',
        players: playerUids.map((uid) => {
          const totals = records
            .filter((record) => record.uid === uid)
            .reduce((acc, record) => {
              if (record.type === 'in') acc.total_in += record.amount;
              if (record.type === 'out') acc.total_out += record.amount;
              acc.last_activity = record.last_activity || acc.last_activity;
              acc.active_today = acc.active_today || Boolean(record.active_today);
              return acc;
            }, { uid, total_in: 0, total_out: 0, last_activity: null, active_today: false });
          totals.net = totals.total_in - totals.total_out;
          return totals;
        })
      };
    }
  };
}

async function prepareMatchedRegistration(store, contact, {
  appbegUsername,
  password = 'secret123',
  amount = 10.37
}) {
  const window = await store.createRegistrationPaymentWindow({
    contactId: contact.id,
    telegramUserId: contact.telegram_id,
    paymentMethodId: null,
    paymentDisplayName: contact.display_name || 'Test Player',
    firstDepositAmount: amount,
    flowType: PAYMENT_WINDOW_FLOW.REGISTRATION
  });
  const now = new Date().toISOString();
  const payment = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title, sender_id,
      sender_name, message_text, raw_payload_json, processing_status,
      parsed_recipient_tag, parsed_recipient_tag_normalized, parsed_amount,
      routing_status, contact_id, registration_payment_window_id,
      message_date, created_at, updated_at
    )
    VALUES (?, ?, 'payments', ?, ?, ?, '{}', 'Matched', ?, ?, ?, 'matched', ?, ?, ?, ?, ?)
  `).run(
    900000 + Number(contact.id),
    -1001,
    contact.telegram_id,
    contact.display_name || 'Test Player',
    `${contact.display_name || 'Test Player'} ${amount}`,
    contact.display_name || 'Test Player',
    String(contact.display_name || 'Test Player').toLowerCase(),
    amount,
    contact.id,
    window.id,
    now,
    now,
    now
  );
  await store.claimPaymentWindowMatch(window.id, Number(payment.lastInsertRowid));
  await store.updateRegistrationInfo(contact.id, {
    payment_confirmed: true,
    preferred_appbeg_username: appbegUsername,
    appbeg_password: password,
    registration_payment_window_id: window.id,
    appbeg_coadmin_uid: 'coadmin_1',
    payment_display_name: contact.display_name || 'Test Player'
  }, 'Test');
  await store.updateRegistrationStatus(contact.id, 'Pending Verification', 'Test');
  return window;
}

async function withFakeAppBeg(fn) {
  const originalFetch = globalThis.fetch;
  const originalBot = globalThis.telegramBot;
  const originalEnv = {
    APPBEG_API_URL: process.env.APPBEG_API_URL,
    APPBEG_LEDGER_INTERNAL_TOKEN: process.env.APPBEG_LEDGER_INTERNAL_TOKEN
  };
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  globalThis.telegramBot = {
    telegram: {
      async sendMessage() {
        return { message_id: 1, reply_markup: { inline_keyboard: [] } };
      }
    }
  };
  try {
    await fn((playerUid, username) => {
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/internal/ledger/create-player')) {
          return makeResponse(200, { ok: true, playerUid, username });
        }
        if (String(url).endsWith('/api/internal/ledger/credit-deposit')) {
          return makeResponse(200, { status: 'credited', amount: 11, playerUid });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      };
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.telegramBot = originalBot;
    if (originalEnv.APPBEG_API_URL == null) delete process.env.APPBEG_API_URL;
    else process.env.APPBEG_API_URL = originalEnv.APPBEG_API_URL;
    if (originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
    else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN;
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

async function testReferralMetadataSurvivesRegistrationRestart() {
  const registrationInfo = {
    vendor_id: 1,
    vendor_code: 'VND-000001',
    vendor_referral_captured_at: '2026-07-27T00:00:00.000Z'
  };
  const store = {
    async ensureAutomationState() {
      return {
        current_flow: null,
        current_step: null,
        registration_info: { ...registrationInfo }
      };
    },
    async getBotSession() {
      return null;
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: 'data/media/payment-qr/chime.png' }
      };
    }
  };
  const decision = await decideBotReply({
    store,
    contact: {
      id: 362,
      telegram_id: 990362,
      display_name: 'Restart Vendor',
      username: 'restart_vendor',
      registration_status: 'New'
    },
    messageText: '/register'
  });
  assert.equal(decision.kind, 'registration_ask_username');
  assert.equal(decision.replaceRegistrationInfo, true);
  assert.equal(decision.statePatch.registrationInfo.vendor_id, 1);
  assert.equal(decision.statePatch.registrationInfo.vendor_code, 'VND-000001');
}

async function testVendorOwnershipRecoversStartPayloadWhenMetadataMissing() {
  await withStore('vendor-recover-start-payload', async (store) => {
    const vendor = await store.createVendor({ name: 'Recovered Vendor' });
    const contact = await store.upsertTelegramUser({
      id: 371,
      first_name: 'Recovered',
      last_name: 'Player',
      username: 'recovered_player',
      is_bot: false
    });
    const conversation = await store.ensureConversation(contact.id);
    await store.db.prepare(`
      INSERT INTO messages (
        conversation_id, telegram_user_id, telegram_message_id, direction, sender_type,
        message_type, text, payload_json, sent_at
      )
      VALUES (?, ?, ?, 'incoming', 'telegram_user', 'text', ?, '{}', ?)
    `).run(
      conversation.id,
      contact.id,
      123,
      `/start ${vendor.vendor_code}`,
      new Date().toISOString()
    );

    const linked = await store.linkVendorPlayerForContact({
      contactId: contact.id,
      appbegPlayerUid: 'recovered_uid',
      actorName: 'Test'
    });
    assert.equal(linked.linked, true);
    assert.equal(linked.reason, 'linked_recovered_from_start_payload');
    assert.equal(linked.mapping.vendor_id, vendor.id);
    const state = await store.ensureAutomationState(contact.id);
    assert.equal(state.registration_info.vendor_id, vendor.id);
    assert.equal(state.registration_info.vendor_code, vendor.vendor_code);
  });
}

async function testNewContactVendorLinkCreatesOwnershipOnPlayerCreation() {
  await withStore('vendor-create-new-contact', async (store) => {
    await withFakeAppBeg(async (setPlayerResponse) => {
      const vendor = await store.createVendor({ name: 'New Contact Vendor', commissionPercentage: 20 });
      const contact = await store.upsertTelegramUser({
        id: 381,
        first_name: 'New',
        last_name: 'Vendor',
        username: 'new_vendor_player',
        is_bot: false
      });
      const captured = await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
      assert.equal(captured.captured, true);
      await prepareMatchedRegistration(store, contact, {
        appbegUsername: 'NewVendor01',
        playerUid: 'new_vendor_uid'
      });
      setPlayerResponse('new_vendor_uid', 'NewVendor01');

      const created = await createAppBegPlayerForContact(store, { contactId: contact.id, actorName: 'Test' });
      assert.equal(created.ok, true);
      const players = await store.listVendorPlayers(vendor.id);
      assert.equal(players.length, 1);
      assert.equal(players[0].telegram_contact_id, contact.id);
      assert.equal(players[0].appbeg_player_uid, 'new_vendor_uid');
    });
  });
}

async function testExistingContactVendorLinkCreatesOwnershipAndVendorDetailStats() {
  await withStore('vendor-create-existing-contact', async (store) => {
    await withFakeAppBeg(async (setPlayerResponse) => {
      const vendor = await store.createVendor({ name: 'Existing Contact Vendor', commissionPercentage: 20 });
      const contact = await store.upsertTelegramUser({
        id: 382,
        first_name: 'Existing',
        last_name: 'Vendor',
        username: 'existing_vendor_player',
        is_bot: false
      });
      await store.storeIncomingTelegramMessage({
        message: {
          message_id: 38201,
          from: { id: 382, first_name: 'Existing', last_name: 'Vendor', username: 'existing_vendor_player', is_bot: false },
          chat: { id: 382, type: 'private' },
          text: `/start ${vendor.vendor_code}`,
          date: Math.floor(Date.now() / 1000)
        }
      });
      const captured = await store.captureVendorReferralForContact(contact.id, vendor.vendor_code);
      assert.equal(captured.captured, true);
      await prepareMatchedRegistration(store, contact, {
        appbegUsername: 'ExistingVendor01',
        playerUid: 'existing_vendor_uid'
      });
      setPlayerResponse('existing_vendor_uid', 'ExistingVendor01');

      const firstCreate = await createAppBegPlayerForContact(store, { contactId: contact.id, actorName: 'Test' });
      assert.equal(firstCreate.ok, true);
      const duplicate = await store.linkVendorPlayerForContact({
        contactId: contact.id,
        appbegPlayerUid: 'existing_vendor_uid',
        actorName: 'Test'
      });
      assert.equal(duplicate.linked, false);
      assert.equal(duplicate.reason, 'player_already_owned');
      assert.equal((await store.listVendorPlayers(vendor.id)).length, 1);

      const app = createApp();
      registerVendorRoutes(app, {
        store,
        requireAdmin: (_req, _res, next) => next(),
        appbegStore: fakeFinancialStore([
          { uid: 'existing_vendor_uid', type: 'in', amount: 44, active_today: true, last_activity: '2026-07-27T00:00:00.000Z' },
          { uid: 'existing_vendor_uid', type: 'out', amount: 10, last_activity: '2026-07-27T01:00:00.000Z' }
        ])
      });
      const detail = await runHandlers(app['GET /api/vendors/:id'], {
        params: { id: String(vendor.id) },
        query: {},
        ledgerUser: { role: 'admin' }
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.payload.players.length, 1);
      assert.equal(detail.payload.players[0].appbegPlayerUid, 'existing_vendor_uid');
      assert.equal(detail.payload.vendor.playerCount, 1);
      assert.equal(detail.payload.vendor.totalIn, 44);
      assert.equal(detail.payload.vendor.net, 34);
      assert.equal(detail.payload.vendor.activePlayersToday, 1);
    });
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
await testReferralMetadataSurvivesRegistrationRestart();
await testVendorOwnershipRecoversStartPayloadWhenMetadataMissing();
await testNewContactVendorLinkCreatesOwnershipOnPlayerCreation();
await testExistingContactVendorLinkCreatesOwnershipAndVendorDetailStats();
await testRegistrationWithoutVendorCreatesNoOwnership();
await testVendorDeletionDoesNotCascadeOwnership();
await testCreatePlayerWithoutVendorStillSucceeds();
await testCreatePlayerSucceedsWhenVendorLinkFails();
console.log('ok vendors phase2');
