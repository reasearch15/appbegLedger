import { decideBotReply, REVIEW_BUTTONS, paymentAppButtons, normalizeCallbackAction } from '../src/telegram/chatbotEngine.js';
import { normalizeButtonRows } from '../src/telegram/messageDelivery.js';

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
    async getActiveDefaultPaymentQr(methodId) {
      if (methodId === 1) {
        return { id: 10, file_path: 'data/media/payment-qr/test.png', payment_method_id: 1 };
      }
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Cash App',
        paymentMethodKey: 'cash_app',
        qr: { id: 10, file_path: 'data/media/payment-qr/test.png' }
      };
    }
  };
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

  const store1 = createFakeStore();
  const welcome = await decideBotReply({ store: store1, contact, messageText: 'hi' });
  assertEqual(welcome.kind, 'welcome');
  assertEqual(Boolean(welcome.replies[0].buttons), true);
  assertIncludes(welcome.replies[0].text, 'How registration works');
  console.log('ok welcome text with inline buttons');

  const store2 = createFakeStore({ current_flow: 'bot_registration', current_step: 'welcome' });
  const started = await decideBotReply({ store: store2, contact, action: 'bot:register' });
  assertEqual(started.kind, 'registration_ask_payment_name');
  assertEqual(started.statePatch.currentStep, 'payment_name');
  assertEqual(started.logEvent.event, 'flow_started');
  console.log('ok register action');

  const staff = await decideBotReply({ store: createFakeStore(), contact, action: 'staff:takeover' });
  assertEqual(staff.escalate, true);
  assertEqual(staff.escalateReason, 'manual_support');
  console.log('ok talk to staff');

  const store4 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'await_payment',
    registration_info: { payment_display_name: 'John', first_deposit_amount: 10 }
  });
  const waiting = await decideBotReply({ store: store4, contact, messageText: 'hello' });
  assertEqual(waiting.kind, 'registration_waiting_payment');
  console.log('ok waiting payment ignores chatter');

  const store5 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const named = await decideBotReply({ store: store5, contact, messageText: 'John Smith' });
  assertEqual(named.kind, 'registration_ask_first_deposit_amount');
  assertEqual(named.statePatch.registrationInfo.payment_display_name, 'John Smith');
  console.log('ok payment name selected');

  assertEqual(normalizeCallbackAction('register'), 'bot:register');
  assertEqual(normalizeCallbackAction('staff'), 'staff:takeover');
  console.log('ok callback aliases still work');

  const rows = normalizeButtonRows(paymentAppButtons());
  assertEqual(rows.length > 0, true);
  const review = normalizeButtonRows(REVIEW_BUTTONS);
  assertEqual(review[0].map((b) => b.data).join(','), 'register:confirm');
  console.log('ok button helpers still normalize');

  const users = [201, 202, 203, 204, 205].map((id) => ({
    contact: { ...contact, id, telegram_id: id, display_name: `User ${id}` },
    store: createFakeStore()
  }));
  const results = await Promise.all(users.map(async ({ contact: c, store }) => {
    const w = await decideBotReply({ store, contact: c, messageText: 'hello' });
    const r = await decideBotReply({ store, contact: c, messageText: '/register' });
    return { welcomeKind: w.kind, registerStep: r.statePatch.currentStep, contactId: c.id };
  }));
  assertEqual(results.every((item) => item.welcomeKind === 'welcome' && item.registerStep === 'payment_name'), true);
  assertEqual(new Set(results.map((item) => item.contactId)).size, 5);
  console.log('ok multi-user isolation');

  console.log('ALL BUTTON FLOW CHECKS PASSED');
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
