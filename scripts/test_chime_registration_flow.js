import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { parseFirstDepositAmount } from '../src/registration/utils.js';

function createFakeStore(initial = {}) {
  let state = {
    current_flow: initial.current_flow || null,
    current_step: initial.current_step || null,
    registration_info: { ...(initial.registration_info || {}) },
    last_auto_welcome_at: initial.last_auto_welcome_at || null
  };
  const paymentWindows = [...(initial.payment_windows || [])];
  let nextWindowId = paymentWindows.length + 1;

  return {
    state,
    paymentWindows,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getActiveRegistrationPaymentWindow(contactId) {
      return paymentWindows.find((item) => item.contact_id === contactId && item.status === 'active') || null;
    },
    async getActiveDefaultChimeQr() {
      return initial.chime_qr || null;
    },
    async createRegistrationPaymentWindow(payload) {
      const row = {
        id: nextWindowId++,
        status: 'active',
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        ...payload
      };
      paymentWindows.push(row);
      return row;
    }
  };
}

async function run() {
  assertEqual(parseFirstDepositAmount('10'), 10);
  assertEqual(parseFirstDepositAmount('10.5'), 10.5);
  assertEqual(parseFirstDepositAmount('25.00'), 25);
  assertEqual(parseFirstDepositAmount('100.75'), 100.75);
  assertEqual(parseFirstDepositAmount('0'), null);
  assertEqual(parseFirstDepositAmount('-5'), null);
  assertEqual(parseFirstDepositAmount('abc'), null);
  assertEqual(parseFirstDepositAmount('$10'), null);
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
  assertEqual(started.statePatch.currentStep, 'payment_app');
  assertIncludes(started.replies[0].text, 'Chime');
  console.log('ok register starts payment app prompt');

  store.state.current_flow = 'bot_registration';
  store.state.current_step = 'payment_app';
  const cashApp = await decideBotReply({ store, contact, messageText: 'Cash App' });
  assertIncludes(cashApp.replies[0].text, 'only have Chime');
  console.log('ok cash app rejected');

  store.state.current_step = 'payment_app';
  const chime = await decideBotReply({ store, contact, messageText: '1' });
  assertEqual(chime.kind, 'registration_ask_chime_payment_name');
  assertIncludes(chime.replies[0].text, 'not a $tag');
  console.log('ok chime asks payment name');

  store.state.current_step = 'chime_payment_name';
  const named = await decideBotReply({ store, contact, messageText: 'John Smith' });
  assertEqual(named.kind, 'registration_ask_first_deposit_amount');
  assertEqual(named.logEvent.event, 'chime_payment_name_collected');
  console.log('ok chime payment name collected');

  store.state.current_step = 'first_deposit_amount';
  store.state.registration_info = { chime_payment_name: 'John Smith', payment_app: 'chime' };
  const badAmount = await decideBotReply({ store, contact, messageText: 'free' });
  assertEqual(badAmount.logEvent.event, 'first_deposit_amount_invalid');
  assertIncludes(badAmount.replies[0].text, 'valid deposit amount');
  console.log('ok invalid deposit amount rejected');

  const goodAmount = await decideBotReply({ store, contact, messageText: '25.50' });
  assertEqual(goodAmount.kind, 'registration_send_chime_qr');
  assertEqual(goodAmount.sendChimeQr.firstDepositAmount, 25.5);
  assertEqual(goodAmount.logEvent.event, 'first_deposit_amount_collected');
  console.log('ok valid deposit queues chime qr send');

  const expiredStore = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'await_payment_done',
    payment_windows: [{
      id: 9,
      contact_id: 101,
      status: 'active',
      expires_at: new Date(Date.now() - 60 * 1000).toISOString()
    }]
  });
  const expiredDone = await decideBotReply({
    store: expiredStore,
    contact,
    messageText: 'Done'
  });
  assertIncludes(expiredDone.replies[0].text, 'expired');
  assertEqual(expiredDone.expirePaymentWindowId, 9);
  console.log('ok expired done message');

  const activeStore = createFakeStore({
    current_flow: 'bot_registration',
    current_step: 'await_payment_done',
    payment_windows: [{
      id: 10,
      contact_id: 101,
      status: 'active',
      expires_at: new Date(Date.now() + 60 * 1000).toISOString()
    }]
  });
  const activeDone = await decideBotReply({
    store: activeStore,
    contact,
    messageText: 'done'
  });
  assertEqual(activeDone.kind, 'registration_payment_done');
  assertEqual(activeDone.completePaymentWindowId, 10);
  assertEqual(activeDone.statePatch.currentStep, 'username');
  console.log('ok active done advances to username');

  activeStore.state.current_step = 'username';
  activeStore.state.registration_info = {
    chime_payment_name: 'John Smith',
    first_deposit_amount: 25.5,
    payment_app: 'chime'
  };
  const username = await decideBotReply({
    store: activeStore,
    contact,
    messageText: 'luckyalex'
  });
  assertEqual(username.kind, 'registration_review');
  assertIncludes(username.replies[0].text, 'Chime payment name');
  console.log('ok username after payment goes to review');

  console.log('ALL CHIME REGISTRATION FLOW CHECKS PASSED');
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
