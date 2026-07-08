import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { chatbotWelcomeCooldownMs } from '../src/registration/utils.js';

function createFakeStore(initial = {}) {
  let state = {
    current_flow: initial.current_flow || null,
    current_step: initial.current_step || null,
    registration_info: { ...(initial.registration_info || {}) },
    last_auto_welcome_at: initial.last_auto_welcome_at || null
  };
  return {
    state,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
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

  const store = createFakeStore();
  const first = await decideBotReply({ store, contact, messageText: 'hi' });
  assertEqual(first.kind, 'welcome');
  assertEqual(first.markWelcomeSent, true);
  assertEqual(Boolean(first.replies[0].buttons), false);
  assertIncludes(first.replies[0].text, 'Register');
  assertIncludes(first.replies[0].text, 'Staff');

  store.state.last_auto_welcome_at = new Date().toISOString();
  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'welcome';

  const second = await decideBotReply({ store, contact, messageText: 'hello' });
  assertEqual(['welcome', 'welcome_nudge'].includes(second.kind), true);
  assertEqual(second.statePatch.currentStep, 'welcome');
  assertEqual(second.kind !== 'registration_ask_username', true);
  console.log('ok follow-up hello still gets welcome/nudge text');

  const cooldown = chatbotWelcomeCooldownMs();
  store.state.last_auto_welcome_at = new Date(Date.now() - cooldown - 1000).toISOString();
  const third = await decideBotReply({ store, contact, messageText: 'hey again' });
  assertEqual(third.kind, 'welcome');
  console.log('ok welcome cooldown is time-based not permanent');

  const started = await decideBotReply({ store, contact, messageText: 'Register' });
  assertEqual(started.kind, 'registration_ask_payment_app');
  assertEqual(started.statePatch.currentStep, 'payment_app');
  console.log('ok Register text command');

  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'username';
  store.state.registration_info = {
    chime_payment_name: 'John Smith',
    first_deposit_amount: 25,
    payment_app: 'chime'
  };
  const advanced = await decideBotReply({ store, contact, messageText: 'luckyalex' });
  assertEqual(advanced.kind, 'registration_review');
  assertEqual(advanced.statePatch.currentStep, 'review');
  console.log('ok username after chime payment goes to review');

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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
