import { decideBotReply, isStopCommand } from '../src/telegram/chatbotEngine.js';

function createFakeStore(initial = {}) {
  let state = {
    current_flow: initial.current_flow ?? null,
    current_step: initial.current_step ?? null,
    registration_info: { ...(initial.registration_info || {}) }
  };
  let paymentWindow = initial.payment_window ?? null;
  const expiredWindowIds = [];

  const store = {
    state,
    expiredWindowIds,
    async ensureAutomationState() {
      return {
        current_flow: state.current_flow,
        current_step: state.current_step,
        registration_info: { ...state.registration_info }
      };
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
      return paymentWindow;
    },
    async expireRegistrationPaymentWindow(windowId) {
      expiredWindowIds.push(windowId);
      if (paymentWindow?.id === windowId) {
        paymentWindow = { ...paymentWindow, status: 'expired' };
      }
    },
    async expireActiveRegistrationPaymentWindows() {
      if (paymentWindow?.id) {
        expiredWindowIds.push(paymentWindow.id);
        paymentWindow = { ...paymentWindow, status: 'expired' };
      }
    },
    setPaymentWindow(window) {
      paymentWindow = window;
    }
  };
  return store;
}

function applyStatePatch(store, decision) {
  const patch = decision?.statePatch;
  if (!patch) return;
  if (patch.currentFlow !== undefined) store.state.current_flow = patch.currentFlow;
  if (patch.currentStep !== undefined) store.state.current_step = patch.currentStep;
  if (patch.registrationInfo) {
    store.state.registration_info = decision.replaceRegistrationInfo
      ? { ...patch.registrationInfo }
      : { ...store.state.registration_info, ...patch.registrationInfo };
  }
  if (decision.expirePaymentWindowId) {
    store.expireRegistrationPaymentWindow(decision.expirePaymentWindowId);
  }
}

async function decideAndApply(store, contact, messageText, action = null) {
  const decision = await decideBotReply({ store, contact, messageText, action });
  applyStatePatch(store, decision);
  return decision;
}

async function run() {
  const contact = {
    id: 101,
    display_name: 'Alex Test',
    username: 'alex',
    telegram_id: 555,
    registration_status: 'New',
    telegram_sync_source: 'bot_api'
  };

  for (const command of ['stop', 'cancel', 'quit', 'restart', 'reset']) {
    if (!isStopCommand(command)) {
      throw new Error(`expected stop command: ${command}`);
    }
  }
  console.log('ok stop command detection');

  const idleStore = createFakeStore();
  const idleStop = await decideBotReply({ store: idleStore, contact, messageText: 'stop' });
  assertEqual(idleStop.kind, 'registration_stop_idle');
  assertIncludes(idleStop.replies[0].text, 'No active registration is running');
  console.log('ok stop while idle gives no-active-flow response');

  const store = createFakeStore();
  let decision = await decideAndApply(store, contact, 'register');
  assertEqual(decision.statePatch.currentStep, 'payment_name');
  assertEqual(store.state.current_flow, 'bot_registration');

  decision = await decideAndApply(store, contact, 'stop');
  assertEqual(decision.kind, 'registration_cancel_confirm');
  decision = await decideAndApply(store, contact, '', 'register:cancel_confirm');
  assertEqual(decision.kind, 'registration_stopped');
  assertEqual(store.state.current_flow, null);
  assertEqual(store.state.current_step, null);
  assertIncludes(decision.replies[0].text, 'Registration has been cancelled');
  assertEvent(decision.logEvents, 'registration_flow_stopped');
  console.log('ok Register -> Stop -> idle');

  decision = await decideAndApply(store, contact, 'register');
  assertEqual(decision.kind, 'registration_ask_payment_name');
  assertEqual(decision.statePatch.currentStep, 'payment_name');
  console.log('ok Register after Stop starts fresh payment name flow');

  const nameStore = createFakeStore();
  await decideAndApply(nameStore, contact, 'register');
  await decideAndApply(nameStore, contact, 'John Smith');
  assertEqual(nameStore.state.current_step, 'first_deposit_amount');
  assertEqual(nameStore.state.registration_info.payment_display_name, 'John Smith');

  decision = await decideAndApply(nameStore, contact, 'cancel');
  assertEqual(decision.kind, 'registration_cancel_confirm');
  decision = await decideAndApply(nameStore, contact, '', 'register:cancel_confirm');
  assertEqual(decision.kind, 'registration_stopped');
  assertEqual(nameStore.state.current_flow, null);
  assertEqual(nameStore.state.registration_info.payment_display_name, undefined);

  await decideAndApply(nameStore, contact, 'register');
  assertEqual(nameStore.state.current_step, 'payment_name');
  console.log('ok Register -> Name -> Stop -> Register starts fresh');

  const paymentStore = createFakeStore();
  await decideAndApply(paymentStore, contact, 'register');
  await decideAndApply(paymentStore, contact, 'John Smith');
  await decideAndApply(paymentStore, contact, '25.50');
  paymentStore.state.current_step = 'await_payment';
  paymentStore.setPaymentWindow({ id: 42, status: 'active' });

  decision = await decideAndApply(paymentStore, contact, 'quit');
  assertEqual(decision.kind, 'registration_cancel_confirm');
  decision = await decideAndApply(paymentStore, contact, '', 'register:cancel_confirm');
  assertEqual(decision.kind, 'registration_stopped');
  assertEqual(decision.expirePaymentWindowId, 42);
  assertEqual(paymentStore.expiredWindowIds.includes(42), true);
  assertEvent(decision.logEvents, 'active_payment_window_cancelled');
  console.log('ok deposit flow Stop cancels active payment window');

  const waitStore = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name',
    registration_info: {}
  });
  decision = await decideBotReply({ store: waitStore, contact, messageText: 'stop' });
  assertEqual(decision.kind, 'registration_cancel_confirm');
  assertEqual(decision.kind !== 'registration_ask_first_deposit_amount', true);
  console.log('ok stop is not treated as payment name');

  console.log('ALL REGISTRATION STOP CHECKS PASSED');
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
