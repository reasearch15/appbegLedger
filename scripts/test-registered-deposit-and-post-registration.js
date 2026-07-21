import assert from 'node:assert/strict';
import { createAppBegPlayerForContact, POST_REGISTRATION_READY_MESSAGE } from '../src/appbeg/createPlayerService.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { registeredMenuButtons } from '../src/telegram/botRegistrationState.js';
import { findMatchingActivePaymentWindow } from '../src/payments/paymentWindowMatcher.js';
import { parsePaymentMessage } from '../src/payments/parser.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

function createRegistrationStore() {
  const outbound = [];
  const contact = {
    id: 44,
    telegram_id: 9044,
    display_name: 'Amy',
    registration_status: 'Pending Verification',
    appbeg_account_id: null,
    appbeg_link_status: null,
    active_messaging_source: 'bot_api'
  };
  let state = {
    current_flow: 'bot_registration',
    current_step: 'creating_account',
    registration_info: {
      payment_confirmed: true,
      payment_display_name: 'Amy Fei',
      first_deposit_amount: 10.37,
      registration_payment_window_id: 123,
      appbeg_password: 'Secret123',
      preferred_appbeg_username: 'AmyVip01',
      appbeg_coadmin_uid: 'coadmin-1'
    }
  };
  return {
    outbound,
    async getUserProfile() {
      return contact;
    },
    async getAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async ensureAutomationState() {
      return this.getAutomationState();
    },
    async getCoadminSettingsSnapshot() {
      return { appbeg_coadmin_uid: 'coadmin-1' };
    },
    async getCoadminSettings() {
      return { appbeg_coadmin_uid: 'coadmin-1' };
    },
    async getRegistrationPaymentWindow() {
      return {
        id: 123,
        contact_id: 44,
        flow_type: 'registration',
        status: 'matched',
        status_raw: 'completed',
        matched_payment_event_id: 555,
        first_deposit_amount: 10.37,
        expected_payment_cents: 1037,
        credited_deposit_amount: 11,
        credited_deposit_cents: 1100
      };
    },
    async logEvent() {},
    async creditRegisteredDeposit() {
      return { ok: true, amount: 11 };
    },
    async markAppBegPlayerCreated({ playerUid }) {
      contact.registration_status = 'Registered';
      contact.appbeg_account_id = playerUid;
      contact.appbeg_link_status = 'linked';
      state.registration_info = {
        ...state.registration_info,
        appbeg_player_uid: playerUid,
        appbeg_creation_complete: true,
        appbeg_password: undefined
      };
      return contact;
    },
    async updateAutomationState(_id, patch = {}) {
      state = {
        ...state,
        current_flow: patch.currentFlow ?? state.current_flow,
        current_step: patch.currentStep ?? state.current_step,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.getAutomationState();
    },
    async updateRegistrationInfo(_id, info = {}) {
      state.registration_info = { ...state.registration_info, ...info };
      return this.getAutomationState();
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage(message) {
      outbound.push(message);
      return { id: outbound.length, ...message };
    }
  };
}

function createDepositStore({ paymentName = 'Amy Fei', currentFlow = null, currentStep = null } = {}) {
  let state = {
    current_flow: currentFlow,
    current_step: currentStep,
    registration_info: {
      payment_display_name: paymentName,
      payment_name: paymentName,
      appbeg_player_uid: 'playeruid123456',
      appbeg_creation_complete: true
    }
  };
  return {
    state,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: '/tmp/qr.png' }
      };
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Chime', key: 'chime' }];
    }
  };
}

function registeredContact() {
  return {
    id: 77,
    telegram_id: 9077,
    display_name: 'Amy',
    registration_status: 'Registered',
    appbeg_account_id: 'playeruid123456',
    appbeg_link_status: 'linked',
    active_messaging_source: 'bot_api'
  };
}

function paymentText(name, amount) {
  return [
    `You received $${amount} from ${name}`,
    '3:00 PM - 12 Jul 2026'
  ].join('\n');
}

async function run() {
  assert.match(POST_REGISTRATION_READY_MESSAGE, /Your Royal VIP account is ready/);
  assert.match(POST_REGISTRATION_READY_MESSAGE, /Tap .Play./);
  assert.match(POST_REGISTRATION_READY_MESSAGE, /Open .Vault./);
  assert.doesNotMatch(POST_REGISTRATION_READY_MESSAGE, /AppBeg/);
  assert.doesNotMatch(POST_REGISTRATION_READY_MESSAGE, /Secret123/);
  console.log('ok post-registration instruction copy is customer-facing');

  const previousBot = globalThis.telegramBot;
  const previousStore = globalThis.appbegStore;
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.APPBEG_API_URL;
  const previousToken = process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'test-token';
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ ok: true, playerUid: 'playeruid123456', username: 'AmyVip01' });
    }
  });
  globalThis.telegramBot = {
    telegram: {
      async sendMessage(_chatId, _text, options = {}) {
        return { message_id: 1, reply_markup: options.reply_markup || null };
      }
    }
  };
  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUsername(username) {
      return { uid: 'playeruid123456', username, coadmin_uid: 'coadmin-1', status: 'active' };
    }
  };
  const registrationStore = createRegistrationStore();
  await createAppBegPlayerForContact(registrationStore, { contactId: 44, actorName: 'Test' });
  const sent = registrationStore.outbound.at(-1);
  assert.match(sent.text, /Your Royal VIP account is ready/);
  assert.doesNotMatch(sent.text, /AppBeg/);
  assert.doesNotMatch(sent.text, /Secret123/);
  assert.deepEqual(sent.payload.buttons.map((row) => row.map((button) => button.text)), [
    ['🟢 Deposit', '🔴 Royal VIP'],
    ['My Account', 'Help', 'Support']
  ]);
  assert.equal(sent.payload.buttons[0][1].web_app.url, 'https://royal.youplatform.org');
  assert.equal(sent.payload.buttons[0][1].url, undefined);
  assert.equal(sent.payload.buttons[0][1].data, undefined);
  assert.deepEqual(sent.payload.reply_markup.inline_keyboard[0][1], {
    text: '🔴 Royal VIP',
    style: 'danger',
    web_app: { url: 'https://royal.youplatform.org' }
  });
  assert.equal(sent.payload.buttons[0][0].style, 'success');
  assert.equal(sent.payload.buttons[0][1].style, 'danger');
  assert.equal((await registrationStore.getAutomationState()).registration_info.active_bot_message_id, 1);
  globalThis.telegramBot = previousBot;
  globalThis.appbegStore = previousStore;
  globalThis.fetch = previousFetch;
  if (previousApiUrl === undefined) delete process.env.APPBEG_API_URL;
  else process.env.APPBEG_API_URL = previousApiUrl;
  if (previousToken === undefined) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = previousToken;
  console.log('ok account creation sends final instructions with registered keyboard');

  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUid() {
      return { uid: 'playeruid123456', status: 'active', username: 'AmyVip01' };
    }
  };
  const depositStore = createDepositStore();
  const startDeposit = await decideBotReply({
    store: depositStore,
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(startDeposit.kind, 'deposit_ask_amount');
  assert.doesNotMatch(startDeposit.replies[0].text, /What payment name/i);
  assert.match(startDeposit.replies[0].text, /Amy Fei/);
  console.log('ok registered Deposit callback reuses saved payment name');

  const invalidAmount = await decideBotReply({
    store: createDepositStore({ currentFlow: 'registered_deposit', currentStep: 'deposit_amount' }),
    contact: registeredContact(),
    messageText: '10.999'
  });
  assert.equal(invalidAmount.kind, 'deposit_ask_amount');
  console.log('ok deposit amount rejects inputs requiring rounding');

  const validAmount = await decideBotReply({
    store: createDepositStore({ currentFlow: 'registered_deposit', currentStep: 'deposit_amount' }),
    contact: registeredContact(),
    messageText: '10.37'
  });
  assert.equal(validAmount.kind, 'registration_send_payment_qr');
  assert.equal(validAmount.sendPaymentQr.firstDepositAmount, 10.37);
  assert.equal(validAmount.sendPaymentQr.paymentDisplayName, 'Amy Fei');
  assert.equal(validAmount.sendPaymentQr.flowType, PAYMENT_WINDOW_FLOW.DEPOSIT);
  console.log('ok registered Deposit asks amount and prepares deposit QR');

  const activeDepositGreetingStore = createDepositStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount'
  });
  const activeDepositGreeting = await decideBotReply({
    store: activeDepositGreetingStore,
    contact: registeredContact(),
    messageText: 'Hello!'
  });
  assert.equal(activeDepositGreeting.kind, 'menu_registered');
  assert.equal(activeDepositGreeting.sendPaymentQr, undefined);
  assert.equal(activeDepositGreeting.statePatch.currentFlow, 'registered_deposit');
  assert.equal(activeDepositGreeting.statePatch.currentStep, 'deposit_amount');
  assert.deepEqual(activeDepositGreeting.replies[0].buttons.flat().map((button) => button.text), [
    '🟢 Deposit',
    '🔴 Royal VIP',
    'My Account',
    'Help',
    'Support'
  ]);
  console.log('ok greeting during active deposit restores menu without starting a second timer');

  const window = {
    id: 1,
    contact_id: 77,
    payment_display_name: 'Amy Fei',
    first_deposit_amount: 10.37,
    expected_payment_cents: 1037,
    flow_type: PAYMENT_WINDOW_FLOW.DEPOSIT,
    status: 'active',
    status_raw: 'active',
    matched_payment_event_id: null,
    expires_at: new Date(Date.now() + 7 * 60 * 1000).toISOString()
  };
  assert.equal(findMatchingActivePaymentWindow([window], parsePaymentMessage(paymentText('Amy Fei', '10.37'))).result, 'exact_match');
  assert.equal(findMatchingActivePaymentWindow([window], parsePaymentMessage(paymentText('Amy Fei', '10.36'))).result, 'no_match');
  assert.equal(findMatchingActivePaymentWindow([window], parsePaymentMessage(paymentText('Amy Fei', '10.38'))).result, 'no_match');
  assert.equal(parsePaymentMessage(paymentText('Amy Fei', '10.371')), null);
  assert.equal(findMatchingActivePaymentWindow([window], {
    amount: '10.371',
    payment_sender_name: 'Amy Fei',
    payment_app: null
  }).result, 'no_match');
  console.log('ok active deposit window matches exact cents only');

  window.status = 'matched';
  window.status_raw = 'completed';
  window.matched_payment_event_id = 555;
  assert.equal(findMatchingActivePaymentWindow([window], parsePaymentMessage(paymentText('Amy Fei', '10.37'))).result, 'no_match');
  console.log('ok matched deposit window cannot be auto-matched twice');

  const keyword = await decideBotReply({
    store: depositStore,
    contact: registeredContact(),
    messageText: 'recharge'
  });
  assert.equal(keyword.kind, 'registered_deposit_discovery');
  assert.deepEqual(keyword.replies[0].buttons.flat().map((button) => button.text), ['🟢 Deposit']);
  assert.equal(keyword.replies[0].buttons[0][0].data, 'menu:deposit');
  console.log('ok registered deposit keyword shows Deposit button');

  const ordinary = await decideBotReply({
    store: depositStore,
    contact: registeredContact(),
    messageText: 'what games are available?'
  });
  assert.notEqual(ordinary.kind, 'registered_deposit_discovery');
  console.log('ok arbitrary registered text is not treated as deposit');

  globalThis.appbegStore = previousStore;
  console.log('All registered deposit/post-registration focused checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
