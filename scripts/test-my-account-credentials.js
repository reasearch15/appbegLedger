import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppBegPlayerForContact } from '../src/appbeg/createPlayerService.js';
import { createDataStore } from '../src/db/index.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';
import { resolveRoyalVipCredentials } from '../src/telegram/accountView.js';

function contact(overrides = {}) {
  return {
    id: 77,
    telegram_id: 9077,
    display_name: 'Amy',
    username: 'amy',
    registration_status: 'Registered',
    appbeg_account_id: 'playeruid123456',
    appbeg_link_status: 'linked',
    active_messaging_source: 'bot_api',
    telegram_sync_source: 'bot_api',
    ...overrides
  };
}

function createStore({ initialState = {}, contactOverride = {}, botSettings = { enabled: true } } = {}) {
  const user = contact(contactOverride);
  let state = {
    current_flow: initialState.current_flow || null,
    current_step: initialState.current_step || null,
    registration_info: { ...(initialState.registration_info || {}) }
  };
  const logs = [];
  const outbound = [];
  const completed = [];
  return {
    logs,
    outbound,
    completed,
    async getUserProfile(id) {
      assert.equal(id, user.id);
      return { ...user };
    },
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async updateAutomationState(_id, patch = {}) {
      state = {
        ...state,
        current_flow: patch.currentFlow === undefined ? state.current_flow : patch.currentFlow,
        current_step: patch.currentStep === undefined ? state.current_step : patch.currentStep,
        registration_info: patch.registrationInfo
          ? { ...patch.registrationInfo }
          : state.registration_info
      };
      return this.getAutomationState();
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async isIncomingMessageEligibleForAutoBot() {
      return { eligible: true };
    },
    async getAutoRegistrationBotSettings() {
      return botSettings;
    },
    async completeBotJob(id, payload) {
      completed.push({ id, payload });
    },
    async logAutomationDecision(payload) {
      logs.push(payload);
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage(message) {
      outbound.push(message);
      return { id: outbound.length, ...message };
    },
    _state() {
      return state;
    }
  };
}

async function run() {
  const previousAppbegStore = globalThis.appbegStore;
  const previousFetch = globalThis.fetch;
  const previousBot = globalThis.telegramBot;
  const previousApiUrl = process.env.APPBEG_API_URL;
  const previousToken = process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUid(uid) {
      return { uid, status: 'active', username: 'AmyVip01' };
    }
  };

  const baseInfo = {
    appbeg_player_uid: 'playeruid123456',
    appbeg_creation_complete: true,
    royal_vip_credentials: {
      username: 'AmyVip01',
      password: 'Secret123',
      player_uid: 'playeruid123456'
    }
  };

  const store = createStore({ initialState: { registration_info: baseInfo } });
  const account = await decideBotReply({
    store,
    contact: contact(),
    action: 'menu:my_account'
  });
  assert.equal(account.kind, 'account_credentials');
  assert.match(account.replies[0].text, /👤 Royal VIP Account/);
  assert.match(account.replies[0].text, /Username:\nAmyVip01/);
  assert.match(account.replies[0].text, /Password:\nSecret123/);
  assert.match(account.replies[0].text, /Keep these details private/);
  assert.doesNotMatch(account.replies[0].text, /AppBeg/);
  assert.deepEqual(account.replies[0].buttons[0][0].web_app, { url: 'https://royal.youplatform.org' });
  assert.equal(JSON.stringify(account.replies[0].buttons), JSON.stringify(account.replies[0].buttons).includes('Secret123') ? 'password leaked' : JSON.stringify(account.replies[0].buttons));
  console.log('ok registered user sees own Royal VIP credentials with Web App button');

  const otherInfo = {
    royal_vip_credentials: {
      username: 'OtherVip01',
      password: 'OtherSecret'
    }
  };
  assert.equal(resolveRoyalVipCredentials({ contact: contact({ id: 88, telegram_id: 9088 }), info: otherInfo }).password, 'OtherSecret');
  assert.equal(resolveRoyalVipCredentials({ contact: contact(), info: baseInfo }).password, 'Secret123');
  assert.equal(resolveRoyalVipCredentials({
    contact: contact({ telegram_id: 9077 }),
    info: {
      royal_vip_credentials: {
        username: 'OtherVip01',
        password: 'OtherSecret',
        telegram_user_id: 9088
      }
    }
  }).ok, false);
  console.log('ok credentials resolve only from the authenticated contact state provided');

  const missing = await decideBotReply({
    store: createStore({ initialState: { registration_info: { appbeg_player_uid: 'playeruid123456' } } }),
    contact: contact(),
    action: 'menu:my_account'
  });
  assert.equal(missing.kind, 'account_credentials_missing');
  assert.match(missing.replies[0].text, /not available yet/);
  assert.doesNotMatch(missing.replies[0].text, /Password:\s*$/);
  assert.deepEqual(missing.replies[0].buttons.flat().map((button) => button.text), ['Support', 'Back']);
  console.log('ok missing credentials show safe fallback');

  const processStore = createStore({ initialState: { registration_info: baseInfo } });
  const calls = [];
  const bot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        calls.push({ method: 'sendMessage', chatId, text, options });
        return { message_id: 501, reply_markup: options.reply_markup || null };
      },
      async editMessageText(chatId, messageId, inlineMessageId, text, options = {}) {
        calls.push({ method: 'editMessageText', chatId, messageId, inlineMessageId, text, options });
        return { message_id: messageId };
      },
      async deleteMessage(chatId, messageId) {
        calls.push({ method: 'deleteMessage', chatId, messageId });
        return true;
      }
    }
  };

  await processBotJob(processStore, {
    id: 1,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: 'bot:my_account',
    incoming_telegram_message_id: 400,
    message_id: null
  }, { bot });
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(calls[0].text, /Secret123/);
  assert.equal(processStore.outbound[0].text, '[sensitive account details omitted]');
  assert.equal(processStore.logs[0].responseSent, '[sensitive account details omitted]');
  assert.doesNotMatch(JSON.stringify(processStore.logs), /Secret123/);
  assert.doesNotMatch(JSON.stringify(calls[0].options), /Secret123/);
  const saved = await processStore.getAutomationState();
  assert.equal(saved.registration_info.account_view_message_id, 501);
  console.log('ok account view sends once without logging password');

  await processBotJob(processStore, {
    id: 2,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: 'bot:my_account',
    incoming_telegram_message_id: 400,
    message_id: null
  }, { bot });
  assert.equal(calls.some((call) => call.method === 'editMessageText' && call.messageId === 501 && /Secret123/.test(call.text)), true);
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 1);
  const editedState = await processStore.getAutomationState();
  const token = editedState.registration_info.account_view_token;
  console.log('ok double tapping My Account edits existing account message');

  await processBotJob(processStore, {
    id: 3,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: `account:hide:${token}`,
    incoming_telegram_message_id: 501,
    message_id: null
  }, { bot });
  assert.equal(calls.some((call) => call.method === 'deleteMessage' && call.messageId === 501), true);
  console.log('ok Hide Details deletes the credential message');

  const stale = await decideBotReply({
    store: processStore,
    contact: contact(),
    action: `account:back:${token}`,
    callbackMessageId: 999
  });
  assert.equal(stale.kind, 'account_stale_button');
  console.log('ok stale account buttons are rejected');

  const depositStore = createStore({
    initialState: {
      current_flow: 'registered_deposit',
      current_step: 'deposit_amount',
      registration_info: {
        ...baseInfo,
        payment_display_name: 'Amy Fei',
        deposit_in_progress: true
      }
    }
  });
  const duringDeposit = await decideBotReply({
    store: depositStore,
    contact: contact(),
    action: 'menu:my_account'
  });
  assert.equal(duringDeposit.kind, 'account_credentials');
  assert.equal(depositStore._state().current_flow, 'registered_deposit');
  const tokenDuringDeposit = duringDeposit.accountView.token;
  depositStore._state().registration_info.account_view_token = tokenDuringDeposit;
  depositStore._state().registration_info.account_view_message_id = 700;
  const back = await decideBotReply({
    store: depositStore,
    contact: contact(),
    action: `account:back:${tokenDuringDeposit}`,
    callbackMessageId: 700
  });
  assert.equal(back.kind, 'deposit_ask_amount');
  assert.equal(back.statePatch.currentFlow, 'registered_deposit');
  assert.equal(back.statePatch.currentStep, 'deposit_amount');
  console.log('ok Back restores active deposit step without resetting state');

  await testCredentialSnapshotPersistsInRealStore();

  globalThis.appbegStore = previousAppbegStore;
  globalThis.fetch = previousFetch;
  globalThis.telegramBot = previousBot;
  if (previousApiUrl == null) delete process.env.APPBEG_API_URL;
  else process.env.APPBEG_API_URL = previousApiUrl;
  if (previousToken == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = previousToken;
  console.log('All My Account credential focused checks passed.');
}

async function testCredentialSnapshotPersistsInRealStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'royal-vip-account-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 'test.sqlite') });
  const previousFetch = globalThis.fetch;
  const previousBot = globalThis.telegramBot;
  const previousApiUrl = process.env.APPBEG_API_URL;
  const previousToken = process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  try {
    process.env.APPBEG_API_URL = 'https://appbeg.test';
    process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async text() {
        if (String(url).endsWith('/api/internal/ledger/create-player')) {
          return JSON.stringify({ ok: true, playerUid: 'playeruid123456', username: 'PersistVip01' });
        }
        return JSON.stringify({ status: 'credited', amount: 11 });
      }
    });
    globalThis.telegramBot = {
      telegram: {
        async sendMessage(_chatId, _text, options = {}) {
          return { message_id: 9001, reply_markup: options.reply_markup || null };
        }
      }
    };

    const savedContact = await store.upsertTelegramUser({
      id: 91001,
      first_name: 'Persist',
      last_name: 'Check',
      username: 'persist_check',
      is_bot: false
    });
    const window = await store.createRegistrationPaymentWindow({
      contactId: savedContact.id,
      telegramUserId: savedContact.telegram_id,
      paymentMethodId: null,
      paymentDisplayName: 'Persist Check',
      firstDepositAmount: 10.37,
      creditedDepositAmount: 11,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
      windowMinutes: 7
    });
    const now = new Date().toISOString();
    const paymentResult = await store.db.prepare(`
      INSERT INTO payment_events (
        telegram_message_id, telegram_group_id, sender_name, message_text, raw_payload_json,
        processing_status, parsed_amount, parsed_sender_name, parsed_payment_app,
        routing_status, contact_id, registration_payment_window_id, message_date, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'Parsed', ?, ?, ?, 'registration_payment_matched', ?, ?, ?, ?, ?)
    `).run(
      9100101,
      -1001,
      'Persist Check',
      'You received $10.37 from Persist Check',
      '{}',
      10.37,
      'Persist Check',
      'Chime',
      savedContact.id,
      window.id,
      now,
      now,
      now
    );
    const paymentId = Number(paymentResult.lastInsertRowid);
    const claim = await store.claimPaymentWindowMatch(window.id, paymentId);
    assert.equal(claim.ok, true);
    await store.updateAutomationState(savedContact.id, {
      currentFlow: 'bot_registration',
      currentStep: 'creating_account',
      registrationInfo: {
        payment_confirmed: true,
        preferred_appbeg_username: 'PersistVip01',
        appbeg_password: 'PersistSecret1',
        registration_payment_window_id: window.id,
        payment_display_name: 'Persist Check',
        first_deposit_amount: 10.37,
        appbeg_coadmin_uid: 'coadmin_1',
        telegram_user_id: savedContact.telegram_id
      }
    });

    await createAppBegPlayerForContact(store, { contactId: savedContact.id, actorName: 'Test' });
    const state = await store.getAutomationState(savedContact.id);
    assert.equal(state.registration_info.appbeg_password, undefined);
    assert.equal(state.registration_info.royal_vip_credentials.username, 'PersistVip01');
    assert.equal(state.registration_info.royal_vip_credentials.password, 'PersistSecret1');
    assert.equal(String(state.registration_info.royal_vip_credentials.telegram_user_id), String(savedContact.telegram_id));
    const freshContact = await store.getUserProfile(savedContact.id);
    const credentials = resolveRoyalVipCredentials({ contact: freshContact, info: state.registration_info });
    assert.equal(credentials.ok, true);
    assert.equal(credentials.username, 'PersistVip01');
    assert.equal(credentials.password, 'PersistSecret1');
    console.log('ok successful create persists credentials where My Account reads them');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.telegramBot = previousBot;
    if (previousApiUrl == null) delete process.env.APPBEG_API_URL;
    else process.env.APPBEG_API_URL = previousApiUrl;
    if (previousToken == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
    else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = previousToken;
    store.db?.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
