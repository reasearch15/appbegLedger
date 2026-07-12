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
  const normalized = normalizeButtonRows(WELCOME_BUTTONS);
  assert.equal(normalized[0][0].data, 'menu:register');
  assert.equal(normalizeCallbackAction(normalized[0][0].data), 'bot:register');
  assert.equal(normalized.length, 1);
  console.log('ok welcome button normalization helpers');

  assert.equal(normalizeCallbackAction('register'), 'bot:register');
  assert.equal(normalizeCallbackAction('staff'), 'staff:takeover');
  assert.equal(normalizeCallbackAction('menu:register'), 'bot:register');
  console.log('ok callback aliases');

  const review = normalizeButtonRows(REVIEW_BUTTONS);
  const reviewData = review.flat().map((b) => b.data);
  assert.ok(reviewData.includes('register:confirm'));
  assert.ok(reviewData.some((d) => String(d).includes('edit') || String(d).includes('payment')));
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
  assert.equal(Boolean(welcome.replies[0].buttons), true);
  assert.ok(welcome.replies[0].text.includes('not registered'));
  console.log('ok decideBotReply welcome includes Bot API buttons');

  const started = await decideBotReply({
    store: createFakeStore(),
    contact: {
      id: 1,
      display_name: 'Alex',
      registration_status: 'New',
      telegram_id: 9
    },
    messageText: '/register'
  });
  assert.equal(started.kind, 'registration_ask_payment_name');
  console.log('ok /register text starts flow');

  console.log('ALL BUTTON DELIVERY CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
