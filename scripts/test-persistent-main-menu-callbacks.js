import assert from 'node:assert/strict';
import { validateCallbackFreshness } from '../src/telegram/callbackSafety.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { HELP_HOME_ACTION } from '../src/telegram/royalVipHelpCenter.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

function createStore({ registrationInfo = {}, currentFlow = null, currentStep = null, activeWindow = null } = {}) {
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
  const calls = { updates: [] };
  return {
    calls,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async updateAutomationState(_id, patch = {}) {
      calls.updates.push(patch);
      state = {
        ...state,
        current_flow: patch.currentFlow ?? state.current_flow,
        current_step: patch.currentStep ?? state.current_step,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.ensureAutomationState();
    },
    async getBotSession() {
      return null;
    },
    async getActiveRegistrationPaymentWindow() {
      return activeWindow;
    },
    async getRegistrationDefaultPaymentQr() {
      return null;
    },
    async listActivePaymentMethodsForRegistration() {
      return [];
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

async function assertFresh(action, label, registrationInfo = { active_bot_message_id: 200 }, { persistent = false } = {}) {
  const result = await validateCallbackFreshness({
    store: createStore({ registrationInfo }),
    user: registeredContact(),
    action,
    callbackMessageId: 100
  });
  assert.equal(result.ok, true, label);
  if (persistent) {
    assert.equal(result.persistentNavigation, true, `${label} is explicitly persistent navigation`);
  }
}

async function run() {
  const previousAppBegStore = globalThis.appbegStore;
  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUid(uid) {
      return { uid, status: 'active', username: 'AmyVip01' };
    }
  };

  await assertFresh('menu:deposit', 'old Deposit main-menu callback stays usable', undefined, { persistent: true });
  await assertFresh('bot:deposit', 'normalized Deposit callback stays usable', undefined, { persistent: true });
  await assertFresh('menu:my_account', 'old My Account callback stays usable');
  await assertFresh('bot:how_it_works', 'old Help callback stays usable');
  await assertFresh('menu:support', 'old Support callback stays usable');
  await assertFresh('menu:deposit', 'Deposit still works after bot restart with no active message id', {}, { persistent: true });
  console.log('ok persistent main-menu callbacks bypass stale-message expiry');

  const staleCancel = await validateCallbackFreshness({
    store: createStore({ registrationInfo: { active_bot_message_id: 200 } }),
    user: registeredContact(),
    action: 'deposit:cancel',
    callbackMessageId: 100
  });
  assert.equal(staleCancel.ok, false);
  assert.equal(staleCancel.reason, 'expired_callback');

  const staleRegisterConfirm = await validateCallbackFreshness({
    store: createStore({ registrationInfo: { active_bot_message_id: 200 } }),
    user: registeredContact(),
    action: 'register:confirm',
    callbackMessageId: 100
  });
  assert.equal(staleRegisterConfirm.ok, false);
  assert.equal(staleRegisterConfirm.reason, 'expired_callback');
  console.log('ok old one-time financial callbacks still expire');

  const freshDeposit = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(freshDeposit.kind, 'deposit_ask_amount');
  assert.equal(freshDeposit.statePatch.currentFlow, 'registered_deposit');
  assert.equal(freshDeposit.statePatch.currentStep, 'deposit_amount');

  const staleDeposit = await decideBotReply({
    store: createStore({
      currentFlow: 'registered_deposit',
      currentStep: 'deposit_await_payment',
      registrationInfo: {
        deposit_in_progress: true,
        deposit_awaiting_payment: true,
        deposit_payment_window_id: 991,
        payment_window_expires_at: '2020-01-01T00:00:00.000Z'
      }
    }),
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(staleDeposit.kind, 'deposit_ask_amount');
  assert.equal(staleDeposit.statePatch.registrationInfo.deposit_payment_window_id, undefined);
  assert.equal(staleDeposit.statePatch.registrationInfo.deposit_awaiting_payment, false);

  const activeDeposit = await decideBotReply({
    store: createStore({
      activeWindow: {
        id: 501,
        contact_id: 77,
        status: 'active',
        flow_type: PAYMENT_WINDOW_FLOW.DEPOSIT,
        payment_display_name: 'Amy Fei',
        first_deposit_amount: 25,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        matched_payment_event_id: null
      }
    }),
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(activeDeposit.kind, 'deposit_waiting_payment');
  assert.equal(activeDeposit.statePatch.registrationInfo.deposit_payment_window_id, 501);
  console.log('ok Deposit starts fresh after stale state and resumes an active deposit');

  const helpStore = createStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount'
  });
  const help = await decideBotReply({
    store: helpStore,
    contact: registeredContact(),
    action: HELP_HOME_ACTION
  });
  assert.equal(help.statePatch, null);
  assert.equal(helpStore.calls.updates.length, 0);

  const afterHelpDeposit = await decideBotReply({
    store: helpStore,
    contact: registeredContact(),
    action: 'menu:deposit'
  });
  assert.equal(afterHelpDeposit.kind, 'deposit_ask_amount');
  assert.equal(afterHelpDeposit.statePatch.currentStep, 'deposit_amount');
  console.log('ok Help remains read-only and does not block Deposit afterward');

  globalThis.appbegStore = previousAppBegStore;
  console.log('All persistent main-menu callback checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
