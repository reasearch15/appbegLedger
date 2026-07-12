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
    paymentWindow: initial.payment_window ?? {
      id: 1,
      status: 'active',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    },
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
    async getActiveRegistrationPaymentWindow() {
      return store.paymentWindow;
    }
  };
  return store;
}

function applyStatePatch(store, patch = {}) {
  if (!patch) return;
  if (patch.currentFlow !== undefined) store.state.current_flow = patch.currentFlow;
  if (patch.currentStep !== undefined) store.state.current_step = patch.currentStep;
  if (patch.registrationInfo) store.state.registration_info = { ...patch.registrationInfo };
}

async function decideAndApply(store, contact, messageText, action = null) {
  const decision = await decideBotReply({ store, contact, messageText, action });
  applyStatePatch(store, decision.statePatch);
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
  assertIncludes(first.replies[0].text, 'Register');
  assertIncludes(first.replies[0].text, 'Staff');
  console.log('ok hello triggers welcome when no active flow');

  store.state.last_auto_welcome_at = new Date().toISOString();
  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'welcome';

  const second = await decideBotReply({ store, contact, messageText: 'hello' });
  assertEqual(['welcome', 'welcome_nudge'].includes(second.kind), true);
  assertEqual(second.statePatch.currentStep, 'welcome');
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

  decision = await decideAndApply(flowStore, contact, 'register');
  assertEqual(decision.kind, 'registration_ask_payment_app');
  assertEqual(decision.statePatch.currentStep, 'payment_app');
  assertEqual(decision.logEvent?.event, 'flow_started');
  console.log('ok flow: register -> payment methods');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'payment_app');
  assertEqual(decision.logEvent?.event, 'flow_ignored_greeting');
  assertIncludes(decision.replies[0].text, "We're currently registering your account");
  assertIncludes(decision.replies[0].text, 'Chime');
  assertEqual(decision.kind !== 'welcome', true);
  console.log('ok flow: hello during payment_app -> reminder not welcome');

  decision = await decideAndApply(flowStore, contact, 'Chime');
  assertEqual(decision.kind, 'registration_ask_payment_display_name');
  assertEqual(decision.statePatch.currentStep, 'payment_display_name');
  console.log('ok flow: Chime -> payment name');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'payment_display_name');
  assertIncludes(decision.replies[0].text, 'payment name');
  console.log('ok flow: hello during payment_display_name -> reminder');

  decision = await decideAndApply(flowStore, contact, 'John Smith');
  assertEqual(decision.kind, 'registration_ask_first_deposit_amount');
  assertEqual(decision.statePatch.currentStep, 'first_deposit_amount');
  console.log('ok flow: John Smith -> deposit amount');

  decision = await decideAndApply(flowStore, contact, 'hello');
  assertEqual(decision.kind, 'registration_flow_reminder');
  assertEqual(decision.statePatch.currentStep, 'first_deposit_amount');
  assertIncludes(decision.replies[0].text, 'deposit');
  console.log('ok flow: hello during deposit -> reminder');

  decision = await decideAndApply(flowStore, contact, '25.50');
  assertEqual(decision.kind, 'registration_send_payment_qr');
  assertEqual(decision.sendPaymentQr?.firstDepositAmount, 25.5);
  flowStore.state.current_step = 'await_payment_done';
  console.log('ok flow: 25.50 -> QR send');

  decision = await decideAndApply(flowStore, contact, 'Done');
  assertEqual(decision.kind, 'registration_waiting_payment_confirmation');
  assertEqual(decision.statePatch.currentStep, 'waiting_for_payment_confirmation');
  assertIncludes(decision.replies[0].text, 'checking your payment');
  assertEqual(decision.logEvent?.event, 'done_received_waiting_for_confirmation');
  flowStore.state.current_step = 'username';
  flowStore.state.registration_info = { ...flowStore.state.registration_info, payment_confirmed: true };
  console.log('ok flow: Done -> waiting for payment confirmation');

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
    current_step: 'payment_app'
  });
  const cancelled = await decideBotReply({ store: cancelStore, contact, messageText: 'cancel' });
  assertEqual(cancelled.kind, 'registration_stopped');
  assertIncludes(cancelled.replies[0].text, 'Registration has been stopped');
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
