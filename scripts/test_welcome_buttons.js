import assert from 'node:assert/strict';
import { normalizeButtonRows } from '../src/telegram/messageDelivery.js';
import { WELCOME_BUTTONS, REVIEW_BUTTONS, normalizeCallbackAction, decideBotReply } from '../src/telegram/chatbotEngine.js';

function createFakeStore() {
  const state = {
    current_flow: null,
    current_step: null,
    registration_info: {},
    last_auto_welcome_at: null
  };
  return {
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    }
  };
}

async function run() {
  const normalized = normalizeButtonRows(WELCOME_BUTTONS);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0][0].text, '📝 Register');
  assert.equal(normalized[0][0].data, 'register');
  assert.equal(normalized[1][0].text, '💬 Talk to Staff');
  assert.equal(normalized[1][0].data, 'staff');
  console.log('ok welcome button normalization');

  assert.equal(normalizeCallbackAction('register'), 'bot:register');
  assert.equal(normalizeCallbackAction('staff'), 'staff:takeover');
  assert.equal(normalizeCallbackAction('confirm'), 'bot:confirm');
  console.log('ok callback aliases');

  const review = normalizeButtonRows(REVIEW_BUTTONS);
  assert.equal(review[0].map((b) => b.data).join(','), 'confirm,edit');
  assert.equal(review[1][0].data, 'cancel');
  console.log('ok review button normalization');

  const welcome = await decideBotReply({
    store: createFakeStore(),
    contact: {
      id: 1,
      display_name: 'Alex',
      first_name: 'Alex',
      username: 'alex',
      telegram_id: 9,
      registration_status: 'New'
    },
    messageText: 'hi'
  });
  assert.equal(welcome.kind, 'welcome');
  const welcomeNorm = normalizeButtonRows(welcome.replies[0].buttons);
  assert.equal(welcomeNorm[0][0].data, 'register');
  assert.equal(welcomeNorm[1][0].data, 'staff');
  console.log('ok decideBotReply welcome buttons');

  const started = await decideBotReply({
    store: createFakeStore(),
    contact: {
      id: 1,
      display_name: 'Alex',
      registration_status: 'New',
      telegram_id: 9
    },
    action: 'register'
  });
  assert.equal(started.kind, 'registration_ask_username');
  console.log('ok register callback alias starts flow');

  console.log('ALL BUTTON DELIVERY CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
