/**
 * Regression: first deposit amount must not be silently skipped while Deposit
 * callback is still pending (depositActive false, pendingDepositStartAmount true).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';

function registeredContact() {
  return {
    id: 77,
    telegram_id: 9077,
    display_name: 'Amy',
    registration_status: 'Registered',
    appbeg_account_id: 'playeruid123456',
    appbeg_link_status: 'linked',
    active_messaging_source: 'bot_api',
    bot_enabled: true
  };
}

function createTempQr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deposit-elig-bypass-'));
  const filePath = path.join(dir, 'qr.png');
  fs.writeFileSync(filePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  return filePath;
}

function createStore({
  currentFlow = null,
  currentStep = null,
  registrationInfo = {},
  pendingDepositStart = false,
  autoBotEnabled = true,
  eligible = false,
  eligibilityReason = 'missing_message_timestamp'
} = {}) {
  let state = {
    current_flow: currentFlow,
    current_step: currentStep,
    registration_info: {
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei',
      appbeg_player_uid: 'playeruid123456',
      appbeg_creation_complete: true,
      ...registrationInfo
    }
  };
  let botSession = {
    current_screen: 'Home',
    workflow_key: null,
    workflow_step: null,
    state_stack_json: '[]',
    context_json: '{}'
  };
  const windows = [];
  const qrPath = createTempQr();

  return {
    windows,
    _state() { return state; },
    _botSession() { return botSession; },
    async getUserProfile() { return registeredContact(); },
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() { return this.ensureAutomationState(); },
    async updateAutomationState(_id, patch = {}) {
      state = {
        ...state,
        current_flow: patch.currentFlow === undefined ? state.current_flow : patch.currentFlow,
        current_step: patch.currentStep === undefined ? state.current_step : patch.currentStep,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.ensureAutomationState();
    },
    async updateRegistrationInfo(_id, info = {}) {
      state.registration_info = { ...state.registration_info, ...info };
      return this.ensureAutomationState();
    },
    async getBotSession() { return { ...botSession }; },
    async resetBotState() {
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
    async hasPendingDepositStartJob() {
      return Boolean(pendingDepositStart);
    },
    async getAutoRegistrationBotSettings() {
      return { enabled: autoBotEnabled, enabled_at: null };
    },
    async isIncomingMessageEligibleForAutoBot() {
      return { eligible, reason: eligibilityReason };
    },
    async completeBotJob() {},
    async logAutomationDecision() {},
    async storeOutgoingMessage(msg) { return { id: 1, ...msg }; },
    async getContactPreferredMessageSource() { return 'bot_api'; },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: qrPath }
      };
    },
    async getActivePaymentQrForRegistration() {
      return { id: 10, file_path: qrPath };
    },
    async getActiveDefaultPaymentQr() {
      return { id: 10, file_path: qrPath };
    },
    async getActiveRegistrationPaymentWindow(_contactId, opts = {}) {
      const wantFlow = opts.flowType || null;
      const now = Date.now();
      return windows.find((w) => {
        if (String(w.status || '').toLowerCase() !== 'active') return false;
        if (wantFlow && (w.flow_type || 'registration') !== wantFlow) return false;
        const expires = new Date(w.expires_at).getTime();
        return Number.isFinite(expires) && expires > now;
      }) || null;
    },
    async expireRegistrationPaymentWindowIfDue() { return null; },
    async listRegistrationPaymentWindowsForExpiryWorker() { return []; },
    async expireRegistrationPaymentWindow() { return null; },
    async createRegistrationPaymentWindow(payload) {
      const window = {
        id: 100 + windows.length,
        contact_id: payload.contactId,
        telegram_user_id: payload.telegramUserId,
        payment_method_id: payload.paymentMethodId,
        payment_qr_code_id: payload.paymentQrCodeId,
        payment_display_name: payload.paymentDisplayName,
        first_deposit_amount: payload.firstDepositAmount,
        expected_payment_cents: Math.round(Number(payload.firstDepositAmount) * 100),
        flow_type: payload.flowType || 'registration',
        status: 'active',
        matched_payment_event_id: null,
        expires_at: new Date(Date.now() + 7 * 60 * 1000).toISOString()
      };
      windows.push(window);
      return window;
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Chime', key: 'chime' }];
    }
  };
}

function mockBot() {
  const calls = { photos: [], texts: [] };
  const bot = {
    telegram: {
      async sendMessage(_c, text, opts = {}) {
        calls.texts.push(String(text));
        return {
          message_id: 8000 + calls.texts.length,
          reply_markup: opts.reply_markup || { inline_keyboard: [[{ text: 'x', callback_data: 'x' }]] }
        };
      },
      async sendPhoto(_c, _p, opts = {}) {
        calls.photos.push(String(opts?.caption || ''));
        return { message_id: 9000 + calls.photos.length };
      },
      async editMessageReplyMarkup() {}
    }
  };
  return { bot, calls };
}

async function run() {
  // Test 1: pending Deposit callback + ineligible "5" must NOT skip — QR created.
  {
    const store = createStore({
      currentFlow: null,
      currentStep: null,
      registrationInfo: {
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei'
      },
      pendingDepositStart: true,
      eligible: false,
      eligibilityReason: 'missing_message_timestamp'
    });
    const { bot, calls } = mockBot();
    const result = await processBotJob(store, {
      id: 601,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1001,
      created_at: new Date().toISOString()
    }, { bot });
    assert.notEqual(result.skipped, true);
    assert.equal(result.decision?.kind, 'registration_send_payment_qr');
    assert.equal(store.windows.length, 1);
    assert.equal(calls.photos.length, 1);
    console.log('ok Test 1: pending deposit start + ineligible 5 reaches QR (not skipped)');
  }

  // Test 2: same race with automation disabled — deposit still continues.
  {
    const store = createStore({
      currentFlow: null,
      currentStep: null,
      registrationInfo: {
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei'
      },
      pendingDepositStart: true,
      autoBotEnabled: false,
      eligible: false,
      eligibilityReason: 'bot_disabled'
    });
    const { bot, calls } = mockBot();
    const result = await processBotJob(store, {
      id: 602,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1002,
      created_at: new Date().toISOString()
    }, { bot });
    assert.notEqual(result.skipped, true);
    assert.equal(result.decision?.kind, 'registration_send_payment_qr');
    assert.equal(store.windows.length, 1);
    assert.equal(calls.photos.length, 1);
    console.log('ok Test 2: pending deposit start bypasses bot-disabled gate');
  }

  // Test 3: unrelated ineligible inbound still skipped.
  {
    const store = createStore({
      currentFlow: null,
      currentStep: null,
      registrationInfo: {},
      pendingDepositStart: false,
      eligible: false,
      eligibilityReason: 'missing_message_timestamp'
    });
    // Force registration path without deposit ownership (non-numeric, no deposit session).
    store.getUserProfile = async () => ({
      ...registeredContact(),
      registration_status: 'Collecting Info'
    });
    const { bot } = mockBot();
    const result = await processBotJob(store, {
      id: 603,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: 'need help with something',
      action: null,
      incoming_telegram_message_id: 1003,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'missing_message_timestamp');
    assert.equal(store.windows.length, 0);
    console.log('ok Test 3: unrelated ineligible inbound still skipped');
  }

  // Test 4: numeric message with NO pending deposit and no active session — still skipped.
  {
    const store = createStore({
      currentFlow: null,
      currentStep: null,
      registrationInfo: {
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei'
      },
      pendingDepositStart: false,
      eligible: false,
      eligibilityReason: 'missing_message_timestamp'
    });
    // Registered + no deposit session → support AI path (not registration eligibility skip).
    // Force registration path via Collecting Info so eligibility gate is reached.
    store.getUserProfile = async () => ({
      ...registeredContact(),
      registration_status: 'Collecting Info'
    });
    const { bot } = mockBot();
    const result = await processBotJob(store, {
      id: 604,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1004,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'missing_message_timestamp');
    assert.equal(store.windows.length, 0);
    console.log('ok Test 4: numeric with no pending deposit still skipped when ineligible');
  }

  // Test 5: depositActive still bypasses eligibility exactly as before.
  {
    const store = createStore({
      currentFlow: 'registered_deposit',
      currentStep: 'deposit_amount',
      registrationInfo: {
        deposit_in_progress: true,
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei'
      },
      pendingDepositStart: false,
      eligible: false,
      eligibilityReason: 'missing_message_timestamp'
    });
    await store.setBotScreen(77, 'Deposit', {
      workflowKey: 'deposit',
      workflowStep: 'waiting_amount'
    });
    const { bot, calls } = mockBot();
    const result = await processBotJob(store, {
      id: 605,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1005,
      created_at: new Date().toISOString()
    }, { bot });
    assert.notEqual(result.skipped, true);
    assert.equal(result.decision?.kind, 'registration_send_payment_qr');
    assert.equal(store.windows.length, 1);
    assert.equal(calls.photos.length, 1);
    console.log('ok Test 5: depositActive eligibility bypass unchanged');
  }

  // Test 6: rapid 5 then 5 → exactly one payment window.
  {
    const store = createStore({
      currentFlow: 'registered_deposit',
      currentStep: 'deposit_amount',
      registrationInfo: {
        deposit_in_progress: true,
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei'
      },
      pendingDepositStart: false,
      eligible: true
    });
    await store.setBotScreen(77, 'Deposit', {
      workflowKey: 'deposit',
      workflowStep: 'waiting_amount'
    });
    store.getActiveRegistrationPaymentWindow = async (_id, opts = {}) => {
      const wantFlow = opts?.flowType || null;
      const now = Date.now();
      return store.windows.find((w) => {
        if (String(w.status || '').toLowerCase() !== 'active') return false;
        if (wantFlow && (w.flow_type || 'registration') !== wantFlow) return false;
        const expires = new Date(w.expires_at).getTime();
        return Number.isFinite(expires) && expires > now;
      }) || null;
    };
    const { bot, calls } = mockBot();
    const first = await processBotJob(store, {
      id: 606,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1006,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(first.decision?.kind, 'registration_send_payment_qr');
    const second = await processBotJob(store, {
      id: 607,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1007,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(second.decision?.kind, 'deposit_waiting_payment');
    assert.equal(store.windows.length, 1);
    assert.equal(calls.photos.length, 1);
    console.log('ok Test 6: rapid 5 then 5 creates exactly one payment window');
  }

  // Test 7: expired deposit → start again → first 5 creates new window immediately.
  {
    const store = createStore({
      currentFlow: 'registered_deposit',
      currentStep: 'deposit_amount',
      registrationInfo: {
        deposit_in_progress: true,
        payment_display_name: 'Amy Fei',
        payment_name: 'Amy Fei',
        deposit_payment_window_id: 55
      },
      pendingDepositStart: false,
      eligible: true
    });
    await store.setBotScreen(77, 'Deposit', {
      workflowKey: 'deposit',
      workflowStep: 'waiting_amount'
    });
    store.getActiveRegistrationPaymentWindow = async () => ({
      id: 55,
      status: 'expired',
      flow_type: 'deposit',
      first_deposit_amount: 5,
      expected_payment_cents: 500,
      expires_at: new Date(Date.now() - 60_000).toISOString()
    });
    store.expireRegistrationPaymentWindowIfDue = async () => ({ id: 55, status: 'expired' });
    const { bot, calls } = mockBot();
    const result = await processBotJob(store, {
      id: 608,
      contact_id: 77,
      job_type: 'inbound_message',
      input_text: '5',
      action: null,
      incoming_telegram_message_id: 1008,
      created_at: new Date().toISOString()
    }, { bot });
    assert.notEqual(result.skipped, true);
    assert.equal(result.decision?.kind, 'registration_send_payment_qr');
    assert.equal(store.windows.length, 1);
    assert.equal(calls.photos.length, 1);
    console.log('ok Test 7: after expired deposit, first 5 creates new window immediately');
  }

  console.log('All deposit amount eligibility bypass checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
