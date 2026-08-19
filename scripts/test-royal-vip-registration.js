import assert from 'node:assert/strict';
import { decideBotReply, normalizeCallbackAction } from '../src/telegram/chatbotEngine.js';
import {
  resolveEffectiveRegistrationState,
  guestMenuButtons,
  registeredMenuButtons,
  reviewScreenButtons,
  referralChoiceButtons,
  maskPaymentIdentifier,
  redactRegistrationInfoForApi
} from '../src/telegram/botRegistrationState.js';
import { parseFirstDepositAmount, parseMoneyToCents, parseRegistrationPaymentAmount, MIN_REGISTRATION_DEPOSIT } from '../src/registration/utils.js';
import {
  DEPOSIT_AMOUNT_PROMPT,
  REGISTRATION_AMOUNT_INVALID_MESSAGE
} from '../src/telegram/royalVipBotRegistration.js';
import { validateAppBegPassword } from '../src/registration/appbegValidation.js';
import { amountsMatch, paymentNamesMatch } from '../src/payments/matchUtils.js';
import { REGISTRATION_PAYMENT_EXPIRY_MESSAGE } from '../src/telegram/paymentWindowExpiryWorker.js';

function createMockStore({ automationState = {}, methods = [{ id: 1, name: 'Chime', key: 'chime' }] } = {}) {
  let state = {
    current_flow: automationState.current_flow || null,
    current_step: automationState.current_step || null,
    registration_info: { ...(automationState.registration_info || {}) },
    last_auto_welcome_at: automationState.last_auto_welcome_at || null
  };
  return {
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async listActivePaymentMethodsForRegistration() {
      return methods;
    },
    async getActiveDefaultPaymentQr(methodId) {
      return methodId ? { id: 10, file_path: '/tmp/qr.png' } : null;
    },
    async getRegistrationDefaultPaymentQr() {
      const method = methods[0];
      return {
        paymentMethodId: method.id,
        paymentMethodName: method.name,
        paymentMethodKey: method.key,
        qr: { id: 10, file_path: '/tmp/qr.png' }
      };
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async captureVendorReferralForContact() {
      return { captured: true };
    },
    _state: () => state,
    apply(decision) {
      const patch = decision?.statePatch;
      if (!patch) return;
      if (patch.currentFlow !== undefined) state.current_flow = patch.currentFlow;
      if (patch.currentStep !== undefined) state.current_step = patch.currentStep;
      if (patch.registrationInfo) {
        state.registration_info = decision.replaceRegistrationInfo
          ? { ...patch.registrationInfo }
          : { ...state.registration_info, ...patch.registrationInfo };
      }
    }
  };
}

const guest = {
  id: 1,
  display_name: 'Alex',
  username: 'alex',
  telegram_id: 1001,
  registration_status: 'New',
  telegram_sync_source: 'bot_api',
  active_messaging_source: 'bot_api'
};

async function run() {
  console.log('Royal VIP credentials-first registration tests');

  assert.equal(MIN_REGISTRATION_DEPOSIT, 5);
  assert.equal(parseFirstDepositAmount('5'), 5);
  assert.deepEqual(parseRegistrationPaymentAmount('10.01'), {
    paymentCents: 1001,
    creditCents: 1100,
    paymentAmount: 10.01,
    creditAmount: 11
  });
  assert.equal(parseMoneyToCents('5.25'), 525);
  assert.equal(parseRegistrationPaymentAmount('10.00'), null);
  console.log('ok parser helpers still work');

  assert.equal(validateAppBegPassword('12345').ok, false);
  assert.equal(validateAppBegPassword('secret1').ok, true);
  assert.equal(paymentNamesMatch('John Smith', 'john smith'), true);
  assert.equal(amountsMatch(10, 10.005), true);
  console.log('ok password and match helpers');

  const store = createMockStore();
  const start = await decideBotReply({ store, contact: guest, messageText: '/start' });
  assert.equal(start.kind, 'welcome');
  assert.match(start.replies[0].text, /How registration works/);
  assert.equal(normalizeCallbackAction(start.replies[0].buttons[0][0].data), 'bot:register');
  console.log('ok /start guest welcome');

  const playStart = await decideBotReply({ store, contact: guest, messageText: '/start play' });
  assert.equal(playStart.kind, 'registration_ask_username');
  assert.equal(playStart.statePatch.currentStep, 'username');
  assert.match(playStart.replies[0].text, /Choose your Royal VIP username/);
  assert.doesNotMatch(playStart.replies[0].text, /payment name/i);
  console.log('ok /start play begins username/password registration');

  const fresh = createMockStore();
  const registeredStart = await decideBotReply({
    store: fresh,
    contact: guest,
    messageText: '',
    action: 'bot:register'
  });
  assert.equal(registeredStart.kind, 'registration_ask_username');
  fresh.apply(registeredStart);

  const invalidUser = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'ab'
  });
  assert.equal(invalidUser.kind, 'registration_ask_username');

  const usernameOk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'JohnVIP01'
  });
  assert.equal(usernameOk.kind, 'registration_ask_password');
  fresh.apply(usernameOk);

  const passwordOk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'secret1'
  });
  assert.equal(passwordOk.kind, 'registration_create_appbeg_player');
  assert.equal(passwordOk.createAppBegPlayer, true);
  console.log('ok username/password registration without payment');

  const vendorStart = await decideBotReply({
    store: createMockStore(),
    contact: guest,
    messageText: '/start VND-123456'
  });
  assert.ok(vendorStart);
  console.log('ok /start VND- still handled');

  const registeredState = await resolveEffectiveRegistrationState({
    contact: {
      ...guest,
      registration_status: 'Registered',
      appbeg_account_id: 'playeruid123456',
      appbeg_link_status: 'linked'
    },
    automationState: { registration_info: { appbeg_creation_complete: true } },
    appbegPlayer: { uid: 'playeruid123456', status: 'active', username: 'JohnVIP01' }
  });
  assert.equal(registeredState.menu_kind, 'registered');
  const registeredLabels = registeredMenuButtons().flat().map((b) => b.text);
  assert.ok(registeredLabels.includes('PLAY'));
  assert.ok(registeredLabels.includes('DEPOSIT'));
  assert.ok(registeredLabels.includes('FREEPLAY'));
  assert.ok(guestMenuButtons().flat().some((b) => /REGISTER/i.test(b.text)));
  assert.match(REGISTRATION_PAYMENT_EXPIRY_MESSAGE, /15-minute/);

  const redacted = redactRegistrationInfoForApi({
    preferred_appbeg_username: 'JohnVIP01',
    appbeg_password: 'secret1',
    payment_tag: '$johncash'
  });
  assert.equal(redacted.appbeg_password, '[redacted]');
  assert.ok(maskPaymentIdentifier('$johncash').includes('•'));

  void DEPOSIT_AMOUNT_PROMPT;
  void REGISTRATION_AMOUNT_INVALID_MESSAGE;
  void reviewScreenButtons;
  void referralChoiceButtons;

  console.log('All Royal VIP registration tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
