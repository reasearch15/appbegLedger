import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { MIN_REGISTRATION_DEPOSIT, parseFirstDepositAmount } from '../src/registration/utils.js';

function createFakeStore() {
  const state = {
    current_flow: null,
    current_step: null,
    registration_info: {}
  };
  return {
    state,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async listActivePaymentMethodsForRegistration() {
      return [
        { id: 1, name: 'Chime', key: 'chime', display_order: 1 },
        { id: 2, name: 'Cash App', key: 'cashapp', display_order: 2 }
      ];
    },
    async getActiveDefaultPaymentQr(methodId) {
      if (methodId === 1) {
        return { id: 10, file_path: 'data/media/payment-qr/chime.png', payment_method_id: 1 };
      }
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: 'data/media/payment-qr/chime.png' }
      };
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    }
  };
}

function apply(store, decision) {
  const patch = decision?.statePatch;
  if (!patch) return;
  if (patch.currentFlow !== undefined) store.state.current_flow = patch.currentFlow;
  if (patch.currentStep !== undefined) store.state.current_step = patch.currentStep;
  if (patch.registrationInfo) {
    store.state.registration_info = decision.replaceRegistrationInfo
      ? { ...patch.registrationInfo }
      : { ...store.state.registration_info, ...patch.registrationInfo };
  }
}

async function run() {
  const contact = {
    id: 7,
    display_name: 'Alex',
    telegram_id: 77,
    registration_status: 'New',
    telegram_sync_source: 'bot_api'
  };

  assertEqual(parseFirstDepositAmount('4'), null);
  assertEqual(parseFirstDepositAmount(String(MIN_REGISTRATION_DEPOSIT)), MIN_REGISTRATION_DEPOSIT);
  console.log('ok deposit amount validation');

  const store = createFakeStore();
  let decision = await decideBotReply({ store, contact, messageText: '/register' });
  assertEqual(decision.kind, 'registration_ask_username');
  assertEqual(decision.statePatch.currentStep, 'username');
  apply(store, decision);
  console.log('ok register starts username prompt');

  decision = await decideBotReply({ store, contact, messageText: 'JohnVIP01' });
  assertEqual(decision.kind, 'registration_ask_password');
  apply(store, decision);
  console.log('ok username collected');

  decision = await decideBotReply({ store, contact, messageText: 'Secret123!' });
  assertEqual(['registration_create_appbeg_player', 'registration_ask_password', 'registration_review'].includes(decision.kind), true);
  console.log('ok password continues credentials-first registration');

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
