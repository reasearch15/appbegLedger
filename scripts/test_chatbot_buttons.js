import { decideBotReply, paymentAppButtons, WELCOME_BUTTONS, REVIEW_BUTTONS } from '../src/telegram/chatbotEngine.js';

function createFakeStore(initial = {}) {
  let state = {
    current_flow: initial.current_flow || null,
    current_step: initial.current_step || null,
    registration_info: { ...(initial.registration_info || {}) }
  };
  return {
    state,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
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

  // 1) Welcome buttons
  const store1 = createFakeStore();
  const welcome = await decideBotReply({ store: store1, contact, messageText: 'hi' });
  assertEqual(welcome.kind, 'welcome');
  assertEqual(welcome.replies[0].text.includes('Welcome to Royal VIP'), true);
  assertEqual(JSON.stringify(welcome.replies[0].buttons), JSON.stringify(WELCOME_BUTTONS));
  console.log('ok welcome buttons');

  // 2) Register button
  const store2 = createFakeStore({ current_flow: 'bot_registration', current_step: 'welcome' });
  const started = await decideBotReply({ store: store2, contact, action: 'bot:register' });
  assertEqual(started.kind, 'registration_ask_username');
  assertEqual(started.statePatch.currentStep, 'username');
  assertEqual(started.replies[0].text.includes('What username would you like'), true);
  assertEqual(started.logEvent.event, 'registration_started');
  console.log('ok register button');

  // 3) Talk to staff
  const staff = await decideBotReply({ store: createFakeStore(), contact, action: 'staff:takeover' });
  assertEqual(staff.escalate, true);
  assertEqual(staff.escalateReason, 'manual_support');
  assertEqual(staff.replies[0].text.includes('staff member will assist'), true);
  console.log('ok talk to staff');

  // 4) Username -> payment app buttons
  const store4 = createFakeStore({ current_flow: 'bot_registration', current_step: 'username' });
  const apps = await decideBotReply({ store: store4, contact, messageText: 'luckyalex' });
  assertEqual(apps.kind, 'registration_ask_payment_app');
  assertEqual(JSON.stringify(apps.replies[0].buttons), JSON.stringify(paymentAppButtons()));
  console.log('ok payment app buttons');

  // 5) Cash App selection
  const store5 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_app',
    registration_info: { preferred_appbeg_username: 'luckyalex' }
  });
  const cash = await decideBotReply({ store: store5, contact, action: 'bot:payment_app:Cash App' });
  assertEqual(cash.kind, 'registration_ask_payment_tag');
  assertEqual(cash.statePatch.registrationInfo.payment_app, 'Cash App');
  assertEqual(cash.logEvent.event, 'payment_app_selected');
  console.log('ok payment app selected');

  // 6) Other -> typed
  const store6 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_app',
    registration_info: { preferred_appbeg_username: 'luckyalex' }
  });
  const other = await decideBotReply({ store: store6, contact, action: 'bot:payment_app:Other' });
  assertEqual(other.kind, 'registration_ask_payment_app_other');
  console.log('ok other payment app');

  // 7) Review buttons
  const store7 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'payment_tag',
    registration_info: {
      preferred_appbeg_username: 'luckyalex',
      payment_app: 'Cash App'
    }
  });
  const review = await decideBotReply({ store: store7, contact, messageText: 'alexcash' });
  assertEqual(review.kind, 'registration_review');
  assertEqual(JSON.stringify(review.replies[0].buttons), JSON.stringify(REVIEW_BUTTONS));
  console.log('ok review buttons');

  // 8) Confirm
  const store8 = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'review',
    registration_info: {
      preferred_appbeg_username: 'luckyalex',
      payment_app: 'Cash App',
      payment_tag: 'alexcash'
    }
  });
  const done = await decideBotReply({ store: store8, contact, action: 'bot:confirm' });
  assertEqual(done.completeRegistration, true);
  assertEqual(done.logEvent.event, 'registration_completed');
  console.log('ok confirm');

  // 9) Concurrent users — independent stores/state
  const users = [201, 202, 203, 204, 205].map((id) => ({
    contact: { ...contact, id, telegram_id: id, display_name: `User ${id}` },
    store: createFakeStore()
  }));
  const results = await Promise.all(users.map(async ({ contact: c, store }) => {
    const w = await decideBotReply({ store, contact: c, messageText: 'hello' });
    const r = await decideBotReply({ store, contact: c, action: 'bot:register' });
    return { welcomeKind: w.kind, registerStep: r.statePatch.currentStep, contactId: c.id };
  }));
  assertEqual(results.every((item) => item.welcomeKind === 'welcome' && item.registerStep === 'username'), true);
  assertEqual(new Set(results.map((item) => item.contactId)).size, 5);
  console.log('ok multi-user isolation');

  console.log('ALL BUTTON FLOW CHECKS PASSED');
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
