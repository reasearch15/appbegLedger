import { decideBotReply, WELCOME_BUTTONS } from '../src/telegram/chatbotEngine.js';
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

  // 1) First inbound → welcome
  const store = createFakeStore();
  const first = await decideBotReply({ store, contact, messageText: 'hi' });
  assertEqual(first.kind, 'welcome');
  assertEqual(first.markWelcomeSent, true);
  assertEqual(JSON.stringify(first.replies[0].buttons), JSON.stringify(WELCOME_BUTTONS));

  // Simulate welcome sent marker (time throttle, not permanent block)
  store.state.last_auto_welcome_at = new Date().toISOString();
  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'welcome';

  // 2) Later "hello" while still on welcome → must still reply (nudge or full welcome)
  const second = await decideBotReply({ store, contact, messageText: 'hello' });
  assertEqual(['welcome', 'welcome_nudge'].includes(second.kind), true);
  assertEqual(second.replies[0].buttons.length > 0, true);
  assertEqual(second.statePatch.currentStep, 'welcome');
  // Must NOT treat random text as registration start
  assertEqual(second.kind !== 'registration_ask_username', true);
  console.log('ok follow-up hello still gets welcome/nudge buttons');

  // 3) After cooldown elapses, full welcome available again
  const cooldown = chatbotWelcomeCooldownMs();
  store.state.last_auto_welcome_at = new Date(Date.now() - cooldown - 1000).toISOString();
  const third = await decideBotReply({ store, contact, messageText: 'hey again' });
  assertEqual(third.kind, 'welcome');
  console.log('ok welcome cooldown is time-based not permanent');

  // 4) Register button still starts username step
  const started = await decideBotReply({ store, contact, action: 'bot:register' });
  assertEqual(started.kind, 'registration_ask_username');
  assertEqual(started.statePatch.currentStep, 'username');
  console.log('ok register button');

  // 5) Active flow message advances step
  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'username';
  const advanced = await decideBotReply({ store, contact, messageText: 'luckyalex' });
  assertEqual(advanced.kind, 'registration_ask_payment_app');
  assertEqual(advanced.statePatch.currentStep, 'payment_app');
  console.log('ok active flow uses inbound as answer');

  console.log('ALL AUTO-REPLY FIX CHECKS PASSED');
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
