import assert from 'node:assert/strict';
import {
  normalizeCallbackAction,
  decideBotReply,
  WELCOME_BUTTONS,
  REGISTERED_BUTTONS,
  REVIEW_BUTTONS
} from '../src/telegram/chatbotEngine.js';
import {
  resolveEffectiveRegistrationState,
  menuKindWelcomeText,
  computeBotRegistrationProgress,
  redactRegistrationInfoForApi,
  guestMenuButtons,
  registeredMenuButtons
} from '../src/telegram/botRegistrationState.js';
import { shouldUseRegistrationBot } from '../src/telegram/chatbotProcessor.js';

function createMockStore({ automationState, methods = [{ id: 1, name: 'Chime', key: 'chime' }] } = {}) {
  let state = {
    current_flow: automationState?.current_flow || null,
    current_step: automationState?.current_step || null,
    registration_info: { ...(automationState?.registration_info || {}) },
    last_auto_welcome_at: automationState?.last_auto_welcome_at || null
  };
  return {
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async listActivePaymentMethodsForRegistration() {
      return methods;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: methods[0].id,
        paymentMethodName: methods[0].name,
        paymentMethodKey: methods[0].key,
        qr: { id: 10, file_path: '/tmp/qr.png' }
      };
    },
    async getActiveDefaultPaymentQr(methodId) {
      return methodId ? { id: 10, file_path: '/tmp/qr.png' } : null;
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    }
  };
}

async function run() {
  console.log('Phase 1 / Royal VIP bot onboarding compatibility tests');

  assert.equal(normalizeCallbackAction('menu:register'), 'bot:register');
  assert.equal(normalizeCallbackAction('register:confirm'), 'bot:confirm');
  assert.deepEqual(guestMenuButtons().flat().map((button) => button.text), ['Register', 'Help', 'Contact']);
  assert.ok(registeredMenuButtons().flat().some((b) => b.text === 'Deposit'));
  assert.ok(REVIEW_BUTTONS.flat().some((b) => b.data === 'register:confirm'));
  assert.equal(WELCOME_BUTTONS[0][0].data, 'menu:register');
  assert.ok(REGISTERED_BUTTONS.flat().some((b) => b.text === 'Support'));

  const staleRegistered = await resolveEffectiveRegistrationState({
    contact: { id: 5, registration_status: 'Registered' },
    automationState: { registration_info: {} }
  });
  assert.equal(staleRegistered.is_registered, false);
  assert.equal(staleRegistered.menu_kind, 'guest');

  const registered = await resolveEffectiveRegistrationState({
    contact: {
      id: 6,
      registration_status: 'Registered',
      appbeg_account_id: 'uid-abcdefgh',
      appbeg_link_status: 'linked'
    },
    automationState: {
      registration_info: { appbeg_player_uid: 'uid-abcdefgh', preferred_appbeg_username: 'Rajex01', appbeg_creation_complete: true }
    },
    appbegPlayer: { uid: 'uid-abcdefgh', status: 'active' }
  });
  assert.equal(registered.is_registered, true);
  assert.equal(registered.menu_kind, 'registered');
  assert.match(menuKindWelcomeText({ display_name: 'Alex' }, registered), /Welcome back!/);

  assert.equal(shouldUseRegistrationBot({ job_type: 'inbound_message', input_text: '/start' }, {}), true);
  assert.equal(shouldUseRegistrationBot({ job_type: 'inbound_message', input_text: 'hello' }, { current_flow: 'bot_registration' }), true);

  const store = createMockStore();
  const start = await decideBotReply({
    store,
    contact: { id: 1, display_name: 'Alex', telegram_id: 9, registration_status: 'New' },
    messageText: '/start'
  });
  assert.equal(start.kind, 'welcome');
  assert.match(start.replies[0].text, /How registration works/);
  assert.doesNotMatch(start.replies[0].text, /AppBeg/);

  const register = await decideBotReply({
    store: createMockStore(),
    contact: { id: 1, display_name: 'Alex', telegram_id: 9, registration_status: 'New' },
    messageText: '',
    action: 'bot:register'
  });
  assert.equal(register.kind, 'registration_ask_payment_name');
  assert.equal(register.statePatch.currentStep, 'payment_name');

  const progress = computeBotRegistrationProgress(
    { registration_status: 'Collecting Info' },
    { payment_display_name: 'John Smith', first_deposit_amount: 10, payment_confirmed: true, preferred_appbeg_username: 'JohnVIP01' },
    { current_flow: 'bot_registration', current_step: 'password' }
  );
  assert.ok(progress.percent > 0);
  assert.ok(progress.steps.some((s) => s.key === 'payment_name' && s.done));

  const redacted = redactRegistrationInfoForApi({ appbeg_password: 'secret1', preferred_appbeg_username: 'JohnVIP01' });
  assert.equal(redacted.appbeg_password, '[redacted]');

  console.log('All Phase 1 bot onboarding tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
