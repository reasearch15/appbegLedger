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
    },
    async listGameAccountsForPlayer(uid) {
      if (String(uid) !== 'playeruid123456') return [];
      return [
        { key: 'orion_stars', label: 'Orion Stars', username: 'amyniv_0OS', password: 'os-secret' },
        { key: 'fire_kirin', label: 'Fire Kirin', username: 'amyqxb_0FK', password: null },
        { key: 'juwa', label: 'Juwa', username: 'amydon_0JW', password: 'jw-secret' }
      ];
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
  assert.match(account.replies[0].text, /^Royal VIP Account/);
  assert.match(account.replies[0].text, /Username:\nAmyVip01/);
  assert.match(account.replies[0].text, /Password:\nSecret123/);
  assert.match(account.replies[0].text, /🎮 Game Accounts/);
  assert.doesNotMatch(account.replies[0].text, /amyniv_0OS|amyqxb_0FK|amydon_0JW/);
  assert.doesNotMatch(account.replies[0].text, /os-secret|jw-secret/);
  assert.match(account.replies[0].text, /Keep these details private/);
  assert.doesNotMatch(account.replies[0].text, /AppBeg/);
  assert.deepEqual(account.replies[0].buttons[0][0].web_app, { url: 'https://royal.youplatform.org' });
  assert.match(account.replies[0].buttons[0][0].text, /Open Royal VIP/);
  const accountButtonTexts = account.replies[0].buttons.flat().map((button) => button.text);
  assert.ok(accountButtonTexts.includes('🟣 Orion Stars'));
  assert.ok(accountButtonTexts.includes('🟠 Fire Kirin'));
  assert.ok(accountButtonTexts.includes('🟢 Juwa'));
  assert.ok(accountButtonTexts.includes('🙈 Hide Details'));
  assert.ok(accountButtonTexts.includes('🏠 Home'));
  assert.ok(accountButtonTexts.includes('Support'));
  assert.ok(!accountButtonTexts.includes('🔐 Show Game Passwords'));
  assert.equal(JSON.stringify(account.replies[0].buttons), JSON.stringify(account.replies[0].buttons).includes('Secret123') ? 'password leaked' : JSON.stringify(account.replies[0].buttons));
  console.log('ok registered user sees Royal VIP + game account buttons (no dumped credentials)');

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
  assert.match(missing.replies[0].text, /Royal VIP account information is currently unavailable/);
  assert.match(missing.replies[0].text, /Please contact Support/);
  assert.doesNotMatch(missing.replies[0].text, /Password:\s*$/);
  assert.ok(missing.replies[0].text.trim().length > 0);
  assert.deepEqual(missing.replies[0].buttons.flat().map((button) => button.text), ['Support', '🏠 Home']);
  console.log('ok missing credentials show safe fallback');

  const missingProcessStore = createStore({
    initialState: { registration_info: { appbeg_player_uid: 'playeruid123456' } }
  });
  const missingCalls = [];
  const missingBot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        missingCalls.push({ method: 'sendMessage', chatId, text, options });
        return { message_id: 601, reply_markup: options.reply_markup || null };
      }
    }
  };
  await processBotJob(missingProcessStore, {
    id: 10,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: 'bot:my_account',
    incoming_telegram_message_id: 401,
    update_id: 20001,
    message_id: null
  }, { bot: missingBot });
  assert.equal(missingCalls.length, 1);
  assert.equal(missingCalls[0].chatId, 9077);
  assert.match(missingCalls[0].text, /contact Support/i);
  assert.equal(missingProcessStore.completed[0].payload.status, 'completed');
  assert.doesNotMatch(JSON.stringify(missingProcessStore.logs), /Password:/i);
  console.log('ok missing credentials deliver Support message (no silent completion)');

  const undeliveredStore = createStore({ initialState: { registration_info: baseInfo } });
  const undeliveredBot = {
    telegram: {
      async sendMessage() {
        throw new Error('telegram_send_failed');
      }
    }
  };
  const undelivered = await processBotJob(undeliveredStore, {
    id: 11,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: 'bot:my_account',
    incoming_telegram_message_id: 402,
    update_id: 20002,
    message_id: null
  }, { bot: undeliveredBot });
  assert.equal(undelivered.ok, false);
  assert.equal(undeliveredStore.completed[0].payload.status, 'failed');
  assert.match(String(undeliveredStore.completed[0].payload.errorText || ''), /telegram_send_failed/);
  assert.doesNotMatch(JSON.stringify(undeliveredStore.completed), /Secret123/);
  console.log('ok undelivered account credentials mark job failed');

  const processStore = createStore({ initialState: { registration_info: baseInfo } });
  const calls = [];
  let nextMessageId = 500;
  const bot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        nextMessageId += 1;
        calls.push({ method: 'sendMessage', chatId, text, options });
        return { message_id: nextMessageId, reply_markup: options.reply_markup || null };
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
    update_id: 10001,
    message_id: null
  }, { bot });
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].chatId, 9077);
  assert.match(calls[0].text, /Secret123/);
  assert.equal(processStore.outbound[0].text, '[sensitive account details omitted]');
  assert.equal(processStore.logs[0].responseSent, '[sensitive account details omitted]');
  assert.doesNotMatch(JSON.stringify(processStore.logs), /Secret123/);
  assert.doesNotMatch(JSON.stringify(processStore.outbound), /Secret123/);
  assert.doesNotMatch(JSON.stringify(calls[0].options), /Secret123/);
  assert.equal(processStore.completed[0].payload.status, 'completed');
  assert.ok(!processStore.completed[0].payload.errorText);
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
    update_id: 10002,
    message_id: null
  }, { bot });
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);
  assert.equal(calls.some((call) => call.method === 'editMessageText'), false);
  assert.equal(calls.some((call) => call.method === 'deleteMessage' && call.messageId === 501), true);
  const editedState = await processStore.getAutomationState();
  const token = editedState.registration_info.account_view_token;
  assert.equal(editedState.registration_info.account_view_message_id, 502);
  console.log('ok double tapping My Account sends a fresh account message');

  const beforeGameEdits = calls.filter((call) => call.method === 'editMessageText').length;
  await processBotJob(processStore, {
    id: 3,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: `account:game:orion_stars:${token}`,
    incoming_telegram_message_id: 502,
    update_id: 10003,
    message_id: null
  }, { bot });
  const gameEdit = calls.filter((call) => call.method === 'editMessageText').slice(beforeGameEdits);
  assert.equal(gameEdit.length, 1);
  assert.equal(gameEdit[0].messageId, 502);
  assert.match(gameEdit[0].text, /^🎮 Orion Stars/);
  assert.match(gameEdit[0].text, /Username:\namyniv_0OS/);
  assert.match(gameEdit[0].text, /Password:\nos-secret/);
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);
  const afterGameState = await processStore.getAutomationState();
  assert.equal(afterGameState.registration_info.account_view_mode, 'game');
  assert.equal(afterGameState.registration_info.account_view_platform_key, 'orion_stars');
  assert.ok(JSON.stringify(gameEdit[0].options?.reply_markup || {}).includes('Back to Games'));
  console.log('ok game button edits same message with that game credentials');

  const beforeHideEdits = calls.filter((call) => call.method === 'editMessageText').length;
  await processBotJob(processStore, {
    id: 4,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: `account:hide:${token}`,
    incoming_telegram_message_id: 502,
    update_id: 10004,
    message_id: null
  }, { bot });
  const hideEdit = calls.filter((call) => call.method === 'editMessageText').slice(beforeHideEdits);
  assert.equal(hideEdit.length, 1);
  assert.equal(hideEdit[0].messageId, 502);
  assert.match(hideEdit[0].text, /Username:\namyniv_0OS/);
  assert.match(hideEdit[0].text, /Password:\n••••••••/);
  assert.doesNotMatch(hideEdit[0].text, /os-secret/);
  console.log('ok hide details masks game password on same message');

  const beforeBackEdits = calls.filter((call) => call.method === 'editMessageText').length;
  await processBotJob(processStore, {
    id: 5,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: `account:game_list:${token}`,
    incoming_telegram_message_id: 502,
    update_id: 10005,
    message_id: null
  }, { bot });
  const backEdit = calls.filter((call) => call.method === 'editMessageText').slice(beforeBackEdits);
  assert.equal(backEdit.length, 1);
  assert.equal(backEdit[0].messageId, 502);
  assert.match(backEdit[0].text, /^Royal VIP Account/);
  assert.match(backEdit[0].text, /Password:\nSecret123/);
  assert.match(backEdit[0].text, /🎮 Game Accounts/);
  assert.doesNotMatch(backEdit[0].text, /amyniv_0OS|os-secret/);
  assert.ok(JSON.stringify(backEdit[0].options?.reply_markup || {}).includes('Orion Stars'));
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);
  console.log('ok back to games restores list on same message');

  const beforeMainHide = calls.filter((call) => call.method === 'editMessageText').length;
  await processBotJob(processStore, {
    id: 6,
    contact_id: 77,
    telegram_user_id: 9077,
    job_type: 'callback_action',
    input_text: '',
    action: `account:hide:${token}`,
    incoming_telegram_message_id: 502,
    update_id: 10006,
    message_id: null
  }, { bot });
  const mainHide = calls.filter((call) => call.method === 'editMessageText').slice(beforeMainHide);
  assert.equal(mainHide.length, 1);
  assert.match(mainHide[0].text, /Username:\nAmyVip01/);
  assert.match(mainHide[0].text, /Password:\n••••••••/);
  assert.doesNotMatch(mainHide[0].text, /Secret123/);
  console.log('ok hide details masks Royal VIP password on main view');

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

  try {
    await testCredentialSnapshotPersistsInRealStore();
  } catch (error) {
    if (String(error?.message || error).includes('NODE_MODULE_VERSION') || error?.code === 'ERR_DLOPEN_FAILED') {
      console.log('skip credential snapshot sqlite persistence check (better-sqlite3 node ABI mismatch)');
    } else {
      throw error;
    }
  }

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
    // Use a claimable routing_status — claimPaymentWindowMatch refuses already-matched rows.
    const paymentResult = await store.db.prepare(`
      INSERT INTO payment_events (
        telegram_message_id, telegram_group_id, sender_name, message_text, raw_payload_json,
        processing_status, parsed_amount, parsed_sender_name, parsed_payment_app,
        routing_status, contact_id, registration_payment_window_id, message_date, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'Parsed', ?, ?, ?, 'pending_match', ?, NULL, ?, ?, ?)
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
