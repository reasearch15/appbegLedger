import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { parseFirstDepositAmount } from '../src/registration/utils.js';
import { parsePaymentMethodSelection, registrationPaymentAppPrompt } from '../src/payments/methodUtils.js';

function createFakeStore(initial = {}) {
  const methods = initial.payment_methods || [
    { id: 1, name: 'Chime', key: 'chime', display_order: 1 },
    { id: 2, name: 'Cash App', key: 'cashapp', display_order: 2 }
  ];
  const paymentWindows = [...(initial.payment_windows || [])];
  let nextWindowId = paymentWindows.length + 1;

  return {
    async ensureAutomationState() {
      return {
        current_flow: initial.current_flow || null,
        current_step: initial.current_step || null,
        registration_info: { ...(initial.registration_info || {}) }
      };
    },
    async listActivePaymentMethodsForRegistration() {
      return methods;
    },
    async getActiveDefaultPaymentQr(methodId) {
      if (methodId === 1) {
        return initial.payment_qr || { id: 10, file_path: 'data/media/payment-qr/test.png', payment_method_id: 1 };
      }
      return null;
    },
    async getActiveRegistrationPaymentWindow(contactId) {
      return paymentWindows.find((item) => item.contact_id === contactId && item.status === 'active') || null;
    }
  };
}

async function run() {
  const methods = [
    { id: 1, name: 'Chime', key: 'chime' },
    { id: 2, name: 'Cash App', key: 'cashapp' }
  ];
  assertIncludes(registrationPaymentAppPrompt(methods), 'Chime');
  assertIncludes(registrationPaymentAppPrompt(methods), 'Cash App');
  assertEqual(parsePaymentMethodSelection('1', methods)?.key, 'chime');
  assertEqual(parsePaymentMethodSelection('cash app', methods)?.key, 'cashapp');
  console.log('ok dynamic payment method prompt');

  assertEqual(parseFirstDepositAmount('10'), 10);
  assertEqual(parseFirstDepositAmount('15.50'), 15.5);
  console.log('ok deposit amount validation');

  const contact = {
    id: 101,
    display_name: 'Alex Test',
    username: 'alex',
    telegram_id: '555',
    registration_status: 'New'
  };

  const store = createFakeStore();
  const started = await decideBotReply({ store, contact, messageText: 'register' });
  assertEqual(started.kind, 'registration_ask_payment_app');
  assertIncludes(started.replies[0].text, 'Chime');
  console.log('ok register starts dynamic payment app prompt');

  const paymentAppStore = {
    ...store,
    async ensureAutomationState() {
      return { current_flow: 'bot_registration', current_step: 'payment_app', registration_info: {} };
    }
  };

  const unavailable = await decideBotReply({ store: paymentAppStore, contact, messageText: '2' });
  assertIncludes(unavailable.replies[0].text, 'Cash App payments are currently unavailable');
  console.log('ok unavailable method message is dynamic');

  const chime = await decideBotReply({ store: paymentAppStore, contact, messageText: 'Chime' });
  assertEqual(chime.kind, 'registration_ask_payment_display_name');
  assertIncludes(chime.replies[0].text, 'not a $tag');
  console.log('ok chime asks payment display name');

  const named = await decideBotReply({
    store,
    contact,
    messageText: 'John Smith',
    ...{ step: 'payment_display_name' }
  });
  // simulate state via automation - use continue flow
  const namedStore = {
    ...store,
    async ensureAutomationState() {
      return {
        current_flow: 'bot_registration',
        current_step: 'payment_display_name',
        registration_info: {
          payment_method_id: 1,
          payment_method_name: 'Chime',
          payment_method_key: 'chime'
        }
      };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    }
  };
  const namedDecision = await decideBotReply({ store: namedStore, contact, messageText: 'John Smith' });
  assertEqual(namedDecision.kind, 'registration_ask_first_deposit_amount');
  console.log('ok payment display name collected');

  const amountStore = {
    ...namedStore,
    async ensureAutomationState() {
      return {
        current_flow: 'bot_registration',
        current_step: 'first_deposit_amount',
        registration_info: {
          payment_method_id: 1,
          payment_method_name: 'Chime',
          payment_method_key: 'chime',
          payment_display_name: 'John Smith'
        }
      };
    }
  };
  const goodAmount = await decideBotReply({ store: amountStore, contact, messageText: '25.50' });
  assertEqual(goodAmount.kind, 'registration_send_payment_qr');
  assertEqual(goodAmount.sendPaymentQr.firstDepositAmount, 25.5);
  assertEqual(goodAmount.sendPaymentQr.paymentMethodId, 1);
  console.log('ok valid deposit queues payment qr send');

  console.log('ALL PAYMENT METHOD REGISTRATION CHECKS PASSED');
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
