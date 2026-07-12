import { decideBotReply } from '../src/telegram/chatbotEngine.js';

function createFakeStore(initial = {}) {
  const state = {
    current_flow: initial.current_flow || null,
    current_step: initial.current_step || null,
    registration_info: { ...(initial.registration_info || {}) },
    last_auto_welcome_at: initial.last_auto_welcome_at || null
  };
  return {
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Cash App', key: 'cash_app' }];
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Cash App',
        paymentMethodKey: 'cash_app',
        qr: { id: 10, file_path: 'data/media/payment-qr/test.png' }
      };
    },
    async getActiveDefaultPaymentQr(methodId) {
      return methodId ? { id: 10, file_path: 'data/media/payment-qr/test.png' } : null;
    }
  };
}

async function run() {
  const contact = {
    id: 1,
    display_name: 'Alex',
    first_name: 'Alex',
    username: 'alex',
    telegram_id: 9,
    registration_status: 'New'
  };

  const welcome = await decideBotReply({
    store: createFakeStore(),
    contact,
    messageText: 'hi'
  });
  assertIncludes(welcome.replies[0].text, 'Welcome to Royal VIP');
  assertIncludes(welcome.replies[0].text, 'not registered');
  assertEqual(Boolean(welcome.replies[0].buttons), true);
  console.log('ok welcome text copy with buttons');

  const register = await decideBotReply({
    store: createFakeStore({ current_flow: 'bot_registration', current_step: 'welcome' }),
    contact,
    messageText: 'Register'
  });
  assertEqual(register.kind, 'registration_ask_payment_name');
  console.log('ok Register text command');

  const staff = await decideBotReply({
    store: createFakeStore(),
    contact,
    messageText: 'Staff'
  });
  assertEqual(staff.escalate, true);
  assertEqual(staff.escalateReason, 'manual_support');
  console.log('ok Staff text command');

  const payment = await decideBotReply({
    store: createFakeStore({
      current_flow: 'bot_registration',
      current_step: 'username',
      registration_info: {}
    }),
    contact,
    messageText: 'luckyalex'
  });
  assertEqual(payment.kind, 'registration_waiting_payment');
  assertIncludes(payment.replies[0].text, 'waiting to verify your payment');
  console.log('ok username waits for payment confirmation');

  console.log('ALL TEXT WELCOME CHECKS PASSED');
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
