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
  // Helpers still normalize if Bot API is used later.
  const normalized = normalizeButtonRows(WELCOME_BUTTONS);
  assert.equal(normalized[0][0].data, 'register');
  assert.equal(normalized[1][0].data, 'staff');
  console.log('ok welcome button normalization helpers');

  assert.equal(normalizeCallbackAction('register'), 'bot:register');
  assert.equal(normalizeCallbackAction('staff'), 'staff:takeover');
  console.log('ok callback aliases');

  const review = normalizeButtonRows(REVIEW_BUTTONS);
  assert.equal(review[0].map((b) => b.data).join(','), 'confirm,edit');
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
  assert.equal(Boolean(welcome.replies[0].buttons), false);
  assert.ok(welcome.replies[0].text.includes("I'm here to help you get started."));
  console.log('ok decideBotReply welcome is text-only');

  const started = await decideBotReply({
    store: createFakeStore(),
    contact: {
      id: 1,
      display_name: 'Alex',
      registration_status: 'New',
      telegram_id: 9
    },
    messageText: 'Register'
  });
  assert.equal(started.kind, 'registration_ask_username');
  console.log('ok Register text starts flow');

  console.log('ALL BUTTON DELIVERY CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
