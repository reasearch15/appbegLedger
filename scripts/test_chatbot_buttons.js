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
  assertIncludes(welcome.replies[0].text, 'just reply:');
  console.log('ok welcome text with inline buttons');

  const store2 = createFakeStore({ current_flow: 'bot_registration', current_step: 'welcome' });
  const started = await decideBotReply({ store: store2, contact, action: 'bot:register' });
  assertEqual(started.kind, 'registration_ask_payment_app');
  assertEqual(started.statePatch.currentStep, 'payment_app');
  assertEqual(started.logEvent.event, 'flow_started');
  console.log('ok register action');

  const staff = await decideBotReply({ store: createFakeStore(), contact, action: 'staff:takeover' });
  assertEqual(staff.escalate, true);
  assertEqual(staff.escalateReason, 'manual_support');
  console.log('ok talk to staff');

  const store4 = createFakeStore({ current_flow: 'bot_registration', current_step: 'username' });
  const apps = await decideBotReply({ store: store4, contact, messageText: 'luckyalex' });
  assertEqual(apps.kind, 'registration_waiting_payment_confirmation');
  assertIncludes(apps.replies[0].text, 'checking your payment');
  assertEqual(Boolean(apps.replies[0].buttons), false);
  console.log('ok payment app text prompt');

  const store5 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_app',
    registration_info: { preferred_appbeg_username: 'luckyalex' }
  });
  const cash = await decideBotReply({ store: store5, contact, action: 'bot:payment_app:Cash App' });
  assertEqual(cash.kind, 'registration_ask_payment_tag');
  assertEqual(cash.statePatch.registrationInfo.payment_app, 'Cash App');
  console.log('ok payment app selected');

  assertEqual(normalizeCallbackAction('register'), 'bot:register');
  assertEqual(normalizeCallbackAction('staff'), 'staff:takeover');
  console.log('ok callback aliases still work');

  // Legacy button helpers remain available if Bot API channel is used later.
  const rows = normalizeButtonRows(paymentAppButtons());
  assertEqual(rows.length > 0, true);
  const review = normalizeButtonRows(REVIEW_BUTTONS);
  assertEqual(review[0].map((b) => b.data).join(','), 'confirm,edit');
  console.log('ok button helpers still normalize');

  const users = [201, 202, 203, 204, 205].map((id) => ({
    contact: { ...contact, id, telegram_id: id, display_name: `User ${id}` },
    store: createFakeStore()
  }));
  const results = await Promise.all(users.map(async ({ contact: c, store }) => {
    const w = await decideBotReply({ store, contact: c, messageText: 'hello' });
    const r = await decideBotReply({ store, contact: c, messageText: 'Register' });
    return { welcomeKind: w.kind, registerStep: r.statePatch.currentStep, contactId: c.id };
  }));
  assertEqual(results.every((item) => item.welcomeKind === 'welcome' && item.registerStep === 'payment_app'), true);
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
