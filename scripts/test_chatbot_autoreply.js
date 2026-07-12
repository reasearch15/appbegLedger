import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { chatbotWelcomeCooldownMs } from '../src/registration/utils.js';

function createFakeStore(initial = {}) {
  let state = {
    current_flow: initial.current_flow ?? null,
    current_step: initial.current_step ?? null,
    registration_info: { ...(initial.registration_info || {}) },
    last_auto_welcome_at: initial.last_auto_welcome_at || null
  };
  const store = {
    state,
    paymentWindow: initial.payment_window ?? null,
    async ensureAutomationState() {
      return {
        ...state,
        current_flow: state.current_flow,
        current_step: state.current_step,
        registration_info: { ...state.registration_info }
      };
    },
    async getAutomationState() {
      return store.ensureAutomationState();
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Chime', key: 'chime', display_order: 1 }];
    },
    async getActiveDefaultPaymentQr(methodId) {
      if (methodId === 1) {
        return { id: 10, file_path: 'data/media/payment-qr/test.png', payment_method_id: 1 };
      }
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: 'data/media/payment-qr/test.png' }
      };
    },
    async getActiveRegistrationPaymentWindow() {
      return store.paymentWindow;
    }
  };
  return store;
}

function applyStatePatch(store, patch = {}, decision = {}) {
  if (!patch) return;
  if (patch.currentFlow !== undefined) store.state.current_flow = patch.currentFlow;
  if (patch.currentStep !== undefined) store.state.current_step = patch.currentStep;
  if (patch.registrationInfo) {
    store.state.registration_info = decision.replaceRegistrationInfo
      ? { ...patch.registrationInfo }
      : { ...store.state.registration_info, ...patch.registrationInfo };
  }
}

async function decideAndApply(store, contact, messageText, action = null) {
  const decision = await decideBotReply({ store, contact, messageText, action });
  applyStatePatch(store, decision.statePatch, decision);
  return decision;
}

async function run() {
  const contact = {
    id: 101,
    display_name: 'Alex Test',
    first_name: 'Alex',
    username: 'alex',
    telegram_id: 555,
    registration_status: 'New'
  };

  const store = createFakeStore();
  const first = await decideBotReply({ store, contact, messageText: 'hi' });
  assertEqual(first.kind, 'welcome');
  assertEqual(first.markWelcomeSent, true);
  assertEqual(Boolean(first.replies[0].buttons), true);
  assertIncludes(first.replies[0].text, 'not registered');
  console.log('ok hello triggers welcome when no active flow');

  store.state.last_auto_welcome_at = new Date().toISOString();
  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'welcome';

  const second = await decideBotReply({ store, contact, messageText: 'hello' });
  assertEqual(['welcome', 'welcome_nudge', 'menu_guest'].includes(second.kind) || second.kind === 'welcome', true);
  assertEqual(second.kind !== 'registration_ask_username', true);
  console.log('ok hello at welcome step still gets welcome/nudge text');

  const cooldown = chatbotWelcomeCooldownMs();
  store.state.last_auto_welcome_at = new Date(Date.now() - cooldown - 1000).toISOString();
  const third = await decideBotReply({ store, contact, messageText: 'hey again' });
  assertEqual(third.kind, 'welcome');
  console.log('ok welcome cooldown is time-based not permanent');

  const flowStore = createFakeStore();
  let decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'welcome');
  console.log('ok flow: hello -> welcome');

  decision = await decideAndApply(flowStore, contact, '/register');
  assertEqual(decision.kind, 'registration_ask_payment_name');
  assertEqual(decision.statePatch.currentStep, 'payment_name');
  assertEqual(decision.logEvent?.event, 'flow_started');
  console.log('ok flow: register -> payment name');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'payment_name');
  console.log('ok flow: hello during payment_name -> reminder not welcome');

  decision = await decideAndApply(flowStore, contact, 'John Smith');
  assertEqual(decision.kind, 'registration_ask_first_deposit_amount');
  assertEqual(decision.statePatch.currentStep, 'first_deposit_amount');
  console.log('ok flow: John Smith -> deposit amount');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'first_deposit_amount');
  console.log('ok flow: hello during deposit -> reminder');

  decision = await decideAndApply(flowStore, contact, '25.50');
  assertEqual(decision.kind, 'registration_send_payment_qr');
  assertEqual(decision.sendPaymentQr?.firstDepositAmount, 25.5);
  flowStore.state.current_step = 'await_payment';
  console.log('ok flow: 25.50 -> QR send');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_waiting_payment');
  console.log('ok flow: hello during await_payment -> waiting');

  flowStore.state.current_step = 'username';
  flowStore.state.registration_info = { ...flowStore.state.registration_info, payment_confirmed: true };

  decision = await decideAndApply(flowStore, contact, 'Rajex01');
  assertEqual(decision.kind, 'registration_ask_password');
  assertEqual(decision.statePatch.currentStep, 'password');
  console.log('ok flow: Rajex01 -> password');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'password');
  console.log('ok flow: hello during password -> reminder');

  assertEqual(flowStore.state.current_step !== 'welcome', true);
  assertEqual(flowStore.state.current_flow, 'bot_registration');
  console.log('ok flow never returned to welcome during registration');

  const cancelStore = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const cancelAsk = await decideBotReply({ store: cancelStore, contact, messageText: 'cancel' });
  assertEqual(cancelAsk.kind, 'registration_cancel_confirm');
  const cancelled = await decideBotReply({
    store: cancelStore,
    contact,
    messageText: '',
    action: 'register:cancel_confirm'
  });
  assertEqual(cancelled.kind, 'registration_stopped');
  assertIncludes(cancelled.replies[0].text, 'Registration has been cancelled');
  assertEqual(cancelled.statePatch.currentFlow, null);
  assertEvent(cancelled.logEvents, 'registration_flow_stopped');
  console.log('ok cancel interrupts flow');

  console.log('ALL AUTO-REPLY FIX CHECKS PASSED');
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`Expected text to include ${JSON.stringify(needle)}\nGot:\n${haystack}`);
  }
}

function assertEvent(logEvents, eventName) {
  if (!(logEvents || []).some((item) => item.event === eventName)) {
    throw new Error(`Expected log event ${eventName} in ${JSON.stringify(logEvents)}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
