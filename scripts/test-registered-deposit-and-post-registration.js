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

function createDepositStore({
  paymentName = 'Amy Fei',
  currentFlow = null,
  currentStep = null,
  registrationInfo = {}
} = {}) {
  let state = {
    current_flow: currentFlow,
    current_step: currentStep,
    registration_info: {
      payment_display_name: paymentName,
      payment_name: paymentName,
      appbeg_player_uid: 'playeruid123456',
      appbeg_creation_complete: true,
      ...registrationInfo
    }
  };
  const calls = { resetBotState: 0 };
  let botSession = {
    current_screen: 'Home',
    workflow_key: null,
    workflow_step: null,
    state_stack_json: '[]',
    context_json: '{}'
  };
  return {
    state,
    calls,
    _state() {
      return state;
    },
    _botSession() {
      return botSession;
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
      return this.ensureAutomationState();
    },
    async updateRegistrationInfo(_id, info = {}) {
      state.registration_info = { ...state.registration_info, ...info };
      return this.ensureAutomationState();
    },
    async getBotSession() {
      return { ...botSession };
    },
    async resetBotState() {
      calls.resetBotState += 1;
      botSession = {
        current_screen: 'Home',
        workflow_key: null,
        workflow_step: null,
        state_stack_json: '[]',
        context_json: '{}'
      };
      return { ...botSession };
    },
    async setBotScreen(_id, screen, opts = {}) {
      botSession = {
        current_screen: screen,
        workflow_key: opts.workflowKey ?? null,
        workflow_step: opts.workflowStep ?? null,
        state_stack_json: '[]',
        context_json: JSON.stringify(opts.context || {})
      };
      return { ...botSession };
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async expireRegistrationPaymentWindowIfDue() {
      return null;
    },
    async listRegistrationPaymentWindowsForExpiryWorker() {
      return [];
    },
    async expireRegistrationPaymentWindow() {
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

  const keywordStore = createDepositStore();
  const keyword = await decideBotReply({
    store: keywordStore,
    contact: registeredContact(),
    messageText: 'recharge'
  });
  assert.equal(keyword.kind, 'registered_deposit_discovery');
  assert.deepEqual(keyword.replies[0].buttons.flat().map((button) => button.text), ['🟢 Deposit']);
  assert.equal(keyword.replies[0].buttons[0][0].data, 'menu:deposit');
  console.log('ok registered deposit keyword shows Deposit button');

  const ordinary = await decideBotReply({
    store: createDepositStore(),
    contact: registeredContact(),
    messageText: 'what games are available?'
  });
  assert.notEqual(ordinary.kind, 'registered_deposit_discovery');
  console.log('ok arbitrary registered text is not treated as deposit');

  // Help → Deposit → amount must switch session to deposit and accept the amount.
  const helpThenDepositStore = createDepositStore();
  const helpHome = await decideBotReply({
    store: helpThenDepositStore,
    contact: registeredContact(),
    action: 'bot:how_it_works'
  });
  assert.equal(helpHome.statePatch, null);
  const depositAfterHelp = await decideBotReply({
    store: helpThenDepositStore,
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(depositAfterHelp.kind, 'deposit_ask_amount');
  assert.equal(depositAfterHelp.statePatch.currentFlow, 'registered_deposit');
  assert.equal(depositAfterHelp.statePatch.currentStep, 'deposit_amount');
  assert.equal(depositAfterHelp.statePatch.registrationInfo.deposit_in_progress, true);
  assert.ok(helpThenDepositStore.calls.resetBotState >= 1);
  assert.equal(helpThenDepositStore._botSession().workflow_key, 'deposit');
  assert.equal(helpThenDepositStore._botSession().workflow_step, 'waiting_amount');
  await helpThenDepositStore.updateAutomationState(77, depositAfterHelp.statePatch);
  const amountAfterHelp = await decideBotReply({
    store: helpThenDepositStore,
    contact: registeredContact(),
    messageText: '25'
  });
  assert.equal(amountAfterHelp.kind, 'registration_send_payment_qr');
  assert.equal(amountAfterHelp.sendPaymentQr.firstDepositAmount, 25);
  assert.equal(amountAfterHelp.sendPaymentQr.flowType, PAYMENT_WINDOW_FLOW.DEPOSIT);
  console.log('ok Help → Deposit → amount starts deposit window');

  // Account → Deposit → amount
  const accountThenDepositStore = createDepositStore();
  await decideBotReply({
    store: accountThenDepositStore,
    contact: registeredContact(),
    action: 'bot:my_account'
  });
  const depositAfterAccount = await decideBotReply({
    store: accountThenDepositStore,
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(depositAfterAccount.statePatch.currentFlow, 'registered_deposit');
  assert.equal(depositAfterAccount.statePatch.currentStep, 'deposit_amount');
  await accountThenDepositStore.updateAutomationState(77, depositAfterAccount.statePatch);
  const amountAfterAccount = await decideBotReply({
    store: accountThenDepositStore,
    contact: registeredContact(),
    messageText: '15'
  });
  assert.equal(amountAfterAccount.kind, 'registration_send_payment_qr');
  assert.equal(amountAfterAccount.sendPaymentQr.firstDepositAmount, 15);
  console.log('ok Account → Deposit → amount starts deposit window');

  // Cancel old flow → Deposit → amount
  const cancelThenDepositStore = createDepositStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount',
    registrationInfo: { deposit_in_progress: true }
  });
  const cancelled = await decideBotReply({
    store: cancelThenDepositStore,
    contact: registeredContact(),
    action: 'deposit:cancel'
  });
  await cancelThenDepositStore.updateAutomationState(77, cancelled.statePatch);
  assert.equal(cancelThenDepositStore._state().current_flow, null);
  const depositAfterCancel = await decideBotReply({
    store: cancelThenDepositStore,
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  await cancelThenDepositStore.updateAutomationState(77, depositAfterCancel.statePatch);
  const amountAfterCancel = await decideBotReply({
    store: cancelThenDepositStore,
    contact: registeredContact(),
    messageText: '20'
  });
  assert.equal(amountAfterCancel.kind, 'registration_send_payment_qr');
  assert.equal(amountAfterCancel.sendPaymentQr.firstDepositAmount, 20);
  console.log('ok cancel → Deposit → amount starts deposit window');

  // Stale wiped flow/step with deposit_in_progress must still accept amount (not Support/menu).
  const wipedFlowStore = createDepositStore({
    currentFlow: null,
    currentStep: null,
    registrationInfo: {
      deposit_in_progress: true,
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei'
    }
  });
  const amountAfterWipe = await decideBotReply({
    store: wipedFlowStore,
    contact: registeredContact(),
    messageText: '30'
  });
  assert.equal(amountAfterWipe.kind, 'registration_send_payment_qr');
  assert.equal(amountAfterWipe.sendPaymentQr.firstDepositAmount, 30);
  console.log('ok amount after wiped deposit flow/step still hits deposit handler');

  // Stale bot_registration leftover + deposit bot session must still accept amount.
  const corruptedStore = createDepositStore({
    currentFlow: 'bot_registration',
    currentStep: 'welcome',
    registrationInfo: {
      deposit_in_progress: true,
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei'
    }
  });
  await corruptedStore.setBotScreen(77, 'Deposit', {
    workflowKey: 'deposit',
    workflowStep: 'waiting_amount',
    context: { payment_name: 'Amy Fei' }
  });
  const amountAfterCorruption = await decideBotReply({
    store: corruptedStore,
    contact: registeredContact(),
    messageText: '18'
  });
  assert.equal(amountAfterCorruption.kind, 'registration_send_payment_qr');
  assert.equal(amountAfterCorruption.sendPaymentQr.firstDepositAmount, 18);
  console.log('ok amount after Help/Menu session corruption still hits deposit handler');

  // Eligibility skip must not swallow deposit amount messages (silent "nothing happens").
  const { processBotJob, shouldUseRegistrationBot, isActiveDepositSession } = await import('../src/telegram/chatbotProcessor.js')
    .then(async () => {
      const processor = await import('../src/telegram/chatbotProcessor.js');
      const depositFlow = await import('../src/telegram/registeredDepositFlow.js');
      return {
        processBotJob: processor.processBotJob,
        shouldUseRegistrationBot: processor.shouldUseRegistrationBot,
        isActiveDepositSession: depositFlow.isActiveDepositSession
      };
    });
  const eligibilityStore = createDepositStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount',
    registrationInfo: {
      deposit_in_progress: true,
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei'
    }
  });
  await eligibilityStore.setBotScreen(77, 'Deposit', {
    workflowKey: 'deposit',
    workflowStep: 'waiting_amount'
  });
  eligibilityStore.getUserProfile = async () => registeredContact();
  eligibilityStore.getAutoRegistrationBotSettings = async () => ({ enabled: true, enabled_at: null });
  eligibilityStore.isIncomingMessageEligibleForAutoBot = async () => ({
    eligible: false,
    reason: 'missing_message_timestamp'
  });
  eligibilityStore.completeBotJob = async () => {};
  eligibilityStore.logAutomationDecision = async () => {};
  eligibilityStore.storeOutgoingMessage = async (msg) => ({ id: 1, ...msg });
  eligibilityStore.getContactPreferredMessageSource = async () => 'bot_api';
  eligibilityStore.getActivePaymentQrForRegistration = async () => ({
    id: 10,
    file_path: '/tmp/qr.png'
  });
  eligibilityStore.getActiveDefaultPaymentQr = async () => ({
    id: 10,
    file_path: '/tmp/qr.png'
  });
  eligibilityStore.createRegistrationPaymentWindow = async (payload) => ({
    id: 99,
    ...payload,
    status: 'active',
    expires_at: new Date(Date.now() + 7 * 60 * 1000).toISOString()
  });
  eligibilityStore.getActiveRegistrationPaymentWindow = async () => null;
  let outboundCount = 0;
  globalThis.telegramBot = {
    telegram: {
      async sendMessage(_c, _t, opts = {}) {
        outboundCount += 1;
        return { message_id: 9000 + outboundCount, reply_markup: opts.reply_markup || { inline_keyboard: [[{ text: 'x', callback_data: 'x' }]] } };
      },
      async sendPhoto() {
        outboundCount += 1;
        return { message_id: 9100 + outboundCount };
      },
      async editMessageReplyMarkup() {}
    }
  };
  assert.equal(
    isActiveDepositSession(eligibilityStore._state(), eligibilityStore._botSession()),
    true
  );
  assert.equal(
    shouldUseRegistrationBot(
      { job_type: 'inbound_message', input_text: '10' },
      eligibilityStore._state(),
      registeredContact(),
      eligibilityStore._botSession()
    ),
    true
  );
  const skippedAmount = await processBotJob(eligibilityStore, {
    id: 501,
    contact_id: 77,
    job_type: 'inbound_message',
    input_text: '10',
    action: null,
    incoming_telegram_message_id: 555,
    created_at: new Date().toISOString()
  }, { bot: globalThis.telegramBot });
  assert.notEqual(skippedAmount.skipped, true);
  assert.equal(skippedAmount.decision?.kind, 'registration_send_payment_qr');
  console.log('ok deposit amount is not silently skipped when eligibility fails');

  // Cancel Deposit after QR: delete QR message, clear cancel button, return to menu.
  const cancelCleanupStore = createDepositStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_await_payment',
    registrationInfo: {
      deposit_in_progress: true,
      deposit_awaiting_payment: true,
      deposit_requested_amount: 10,
      deposit_payment_window_id: 88,
      payment_qr_telegram_message_id: 4242,
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei'
    }
  });
  await cancelCleanupStore.setBotScreen(77, 'Deposit', {
    workflowKey: 'deposit',
    workflowStep: 'await_payment',
    context: { qr_telegram_message_id: 4242, amount: 10 }
  });
  cancelCleanupStore.getUserProfile = async () => registeredContact();
  cancelCleanupStore.getAutoRegistrationBotSettings = async () => ({ enabled: true, enabled_at: null });
  cancelCleanupStore.isIncomingMessageEligibleForAutoBot = async () => ({ eligible: true, reason: 'eligible' });
  cancelCleanupStore.completeBotJob = async () => {};
  cancelCleanupStore.logAutomationDecision = async () => {};
  cancelCleanupStore.storeOutgoingMessage = async (msg) => ({ id: 1, ...msg });
  cancelCleanupStore.getContactPreferredMessageSource = async () => 'bot_api';
  let expiredWindowId = null;
  cancelCleanupStore.expireRegistrationPaymentWindow = async (id) => {
    expiredWindowId = id;
    return { id, status: 'expired' };
  };
  const telegramCalls = { deleted: [], editedCaption: [], clearedMarkup: [], sent: [] };
  const cancelBot = {
    telegram: {
      async deleteMessage(chatId, messageId) {
        telegramCalls.deleted.push({ chatId, messageId });
        return true;
      },
      async editMessageCaption(chatId, messageId, _inline, caption, extra) {
        telegramCalls.editedCaption.push({ chatId, messageId, caption, extra });
        return true;
      },
      async editMessageReplyMarkup(chatId, messageId, _inline, markup) {
        telegramCalls.clearedMarkup.push({ chatId, messageId, markup });
        return true;
      },
      async sendMessage(chatId, text, opts = {}) {
        telegramCalls.sent.push({ chatId, text, opts });
        return { message_id: 9301, reply_markup: opts.reply_markup };
      },
      async editMessageText() {}
    }
  };
  const cancelResult = await processBotJob(cancelCleanupStore, {
    id: 502,
    contact_id: 77,
    job_type: 'callback_action',
    input_text: '',
    action: 'deposit:cancel',
    incoming_telegram_message_id: 4242,
    created_at: new Date().toISOString()
  }, { bot: cancelBot });
  assert.equal(cancelResult.decision?.kind, 'deposit_cancelled');
  assert.equal(expiredWindowId, 88);
  assert.deepEqual(telegramCalls.deleted, [{ chatId: 9077, messageId: 4242 }]);
  assert.equal(telegramCalls.editedCaption.length, 0);
  assert.equal(cancelCleanupStore._state().current_flow, null);
  assert.equal(cancelCleanupStore._state().registration_info.deposit_in_progress, undefined);
  assert.equal(cancelCleanupStore._botSession().workflow_key, null);
  assert.match(String(telegramCalls.sent[0]?.text || ''), /Deposit cancelled/i);
  assert.ok((telegramCalls.sent[0]?.opts?.reply_markup?.inline_keyboard || []).flat().some((b) => /deposit/i.test(b.callback_data || b.text || '')));
  console.log('ok Cancel Deposit deletes QR message and returns to menu');

  // If Telegram cannot delete the QR, edit caption and strip Cancel Deposit.
  const cancelEditStore = createDepositStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_await_payment',
    registrationInfo: {
      deposit_in_progress: true,
      deposit_awaiting_payment: true,
      payment_qr_telegram_message_id: 5252,
      deposit_payment_window_id: 89
    }
  });
  cancelEditStore.getUserProfile = async () => registeredContact();
  cancelEditStore.getAutoRegistrationBotSettings = async () => ({ enabled: true, enabled_at: null });
  cancelEditStore.isIncomingMessageEligibleForAutoBot = async () => ({ eligible: true, reason: 'eligible' });
  cancelEditStore.completeBotJob = async () => {};
  cancelEditStore.logAutomationDecision = async () => {};
  cancelEditStore.storeOutgoingMessage = async (msg) => ({ id: 1, ...msg });
  cancelEditStore.getContactPreferredMessageSource = async () => 'bot_api';
  cancelEditStore.expireRegistrationPaymentWindow = async () => null;
  const editCalls = { deleted: [], editedCaption: [], sent: [] };
  const editBot = {
    telegram: {
      async deleteMessage() {
        throw new Error('message can\'t be deleted');
      },
      async editMessageCaption(chatId, messageId, _inline, caption, extra) {
        editCalls.editedCaption.push({ chatId, messageId, caption, extra });
        return true;
      },
      async editMessageReplyMarkup() {},
      async sendMessage(chatId, text, opts = {}) {
        editCalls.sent.push({ chatId, text, opts });
        return { message_id: 9302, reply_markup: opts.reply_markup };
      }
    }
  };
  const editCancelResult = await processBotJob(cancelEditStore, {
    id: 503,
    contact_id: 77,
    job_type: 'callback_action',
    input_text: '',
    action: 'deposit:cancel',
    incoming_telegram_message_id: 5252,
    created_at: new Date().toISOString()
  }, { bot: editBot });
  assert.equal(editCancelResult.decision?.kind, 'deposit_cancelled');
  assert.equal(editCalls.editedCaption.length, 1);
  assert.equal(editCalls.editedCaption[0].messageId, 5252);
  assert.equal(editCalls.editedCaption[0].caption, 'Deposit cancelled.');
  assert.deepEqual(editCalls.editedCaption[0].extra?.reply_markup, { inline_keyboard: [] });
  assert.match(String(editCalls.sent[0]?.text || ''), /Deposit cancelled/i);
  console.log('ok Cancel Deposit edits QR when delete fails');

  globalThis.appbegStore = previousStore;
  console.log('All registered deposit/post-registration focused checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
