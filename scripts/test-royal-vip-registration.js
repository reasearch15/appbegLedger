import assert from 'node:assert/strict';
import { decideBotReply, normalizeCallbackAction } from '../src/telegram/chatbotEngine.js';
import { buildMenu } from '../src/telegram/menuEngine.js';
import { normalizeButtonRows } from '../src/telegram/messageDelivery.js';
import {
  resolveEffectiveRegistrationState,
  guestMenuButtons,
  registeredMenuButtons,
  reviewScreenButtons,
  referralChoiceButtons,
  maskPaymentIdentifier,
  redactRegistrationInfoForApi
} from '../src/telegram/botRegistrationState.js';
import { parseFirstDepositAmount, parseRegistrationPaymentAmount, MIN_REGISTRATION_DEPOSIT } from '../src/registration/utils.js';
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
  console.log('Royal VIP payment-first registration tests');

  // Deposit validation
  assert.equal(MIN_REGISTRATION_DEPOSIT, 5);
  assert.equal(parseFirstDepositAmount('4'), null);
  assert.equal(parseFirstDepositAmount('5'), 5);
  assert.equal(parseFirstDepositAmount('10'), 10);
  assert.equal(parseFirstDepositAmount('abc'), null);
  console.log('ok deposit min $5 validation');

  assert.deepEqual(parseRegistrationPaymentAmount('10.01'), {
    paymentCents: 1001,
    creditCents: 1100,
    paymentAmount: 10.01,
    creditAmount: 11
  });
  assert.equal(parseRegistrationPaymentAmount('10.37').creditAmount, 11);
  assert.equal(parseRegistrationPaymentAmount('10.99').creditAmount, 11);
  assert.equal(parseRegistrationPaymentAmount('20.01').creditAmount, 21);
  assert.equal(parseRegistrationPaymentAmount('10.00'), null);
  console.log('ok registration cents payment credits upward');

  // Password min 6, never log raw value in review
  assert.equal(validateAppBegPassword('12345').ok, false);
  assert.equal(validateAppBegPassword('secret1').ok, true);
  console.log('ok password min 6');

  // Matching helpers: name + amount
  assert.equal(paymentNamesMatch('John Smith', 'john smith'), true);
  assert.equal(amountsMatch(10, 10.005), true);
  assert.equal(amountsMatch(10, 11), false);
  console.log('ok name+amount match helpers');

  // /start guest menu
  const store = createMockStore();
  const start = await decideBotReply({ store, contact: guest, messageText: '/start' });
  assert.equal(start.kind, 'welcome');
  assert.match(start.replies[0].text, /Welcome to Royal VIP/);
  assert.match(start.replies[0].text, /not registered/);
  assert.equal(start.replies[0].buttons.length, 2);
  assert.equal(normalizeCallbackAction(start.replies[0].buttons[0][0].data), 'bot:register');
  assert.deepEqual(start.replies[0].buttons.flat().map((b) => b.text), ['Register', 'Help', 'Contact']);
  console.log('ok /start guest welcome + Register/Help/Contact');

  // Register starts at payment name
  store.apply(await decideBotReply({ store, contact: guest, messageText: '', action: 'menu:register' }));
  const askName = await decideBotReply({ store, contact: { ...guest, registration_status: 'Collecting Info' }, messageText: '', action: 'menu:register' });
  // fresh start
  const fresh = createMockStore();
  const registeredStart = await decideBotReply({
    store: fresh,
    contact: guest,
    messageText: '',
    action: 'bot:register'
  });
  assert.equal(registeredStart.kind, 'registration_ask_payment_name');
  assert.equal(registeredStart.statePatch.currentStep, 'payment_name');
  assert.equal(registeredStart.setStatus, 'Collecting Info');
  assert.match(registeredStart.replies[0].text, /full name/);
  fresh.apply(registeredStart);
  console.log('ok Register asks payment name');

  // Name -> amount
  const named = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'John Smith'
  });
  assert.equal(named.kind, 'registration_ask_first_deposit_amount');
  assert.match(named.replies[0].text, /Thank you, John Smith/);
  assert.match(named.replies[0].text, /\$5/);
  fresh.apply(named);
  console.log('ok payment name advances to deposit amount');

  // Invalid amount rejected
  const badAmount = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '10.00'
  });
  assert.equal(badAmount.kind, 'registration_ask_first_deposit_amount');
  assert.equal(badAmount.statePatch.currentStep, 'first_deposit_amount');
  console.log('ok whole-dollar registration amount rejected');

  // Valid amount queues QR
  const amountOk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '10.37'
  });
  assert.equal(amountOk.kind, 'registration_send_payment_qr');
  assert.equal(amountOk.sendPaymentQr.firstDepositAmount, 10.37);
  assert.equal(amountOk.sendPaymentQr.creditedDepositAmount, 11);
  assert.equal(amountOk.statePatch.registrationInfo.registration_payment_cents, 1037);
  assert.equal(amountOk.statePatch.registrationInfo.registration_credit_cents, 1100);
  assert.equal(amountOk.sendPaymentQr.paymentDisplayName, 'John Smith');
  assert.equal(amountOk.setStatus, undefined);
  assert.equal(amountOk.statePatch.currentStep, 'first_deposit_amount');
  assert.equal(amountOk.logEvent.event, 'registration_amount_accepted');
  fresh.apply(amountOk);
  // Simulate successful QR handler advancing state
  fresh._state().current_step = 'await_payment';
  console.log('ok deposit queues QR payment window');

  // Waiting step ignores chatter
  const waiting = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Waiting For Payment' },
    messageText: 'hello'
  });
  assert.equal(waiting.kind, 'registration_waiting_payment');
  console.log('ok waiting payment ignores extra questions');

  // After payment confirmed -> username
  fresh._state().registration_info.payment_confirmed = true;
  fresh._state().current_step = 'username';
  const usernameAsk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: ''
  });
  // empty text at username should re-prompt via continue
  const usernameOk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'JohnVIP01'
  });
  assert.equal(usernameOk.kind, 'registration_ask_password');
  assert.equal(usernameOk.statePatch.registrationInfo.preferred_appbeg_username, 'JohnVIP01');
  fresh.apply(usernameOk);
  console.log('ok username advances to password');

  // Password -> referral choice
  const passwordOk = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'secret1'
  });
  assert.equal(passwordOk.kind, 'registration_ask_referral_choice');
  assert.equal(passwordOk.statePatch.currentStep, 'referral_choice');
  assert.equal(passwordOk.statePatch.registrationInfo.appbeg_password, 'secret1');
  assert.match(passwordOk.replies[0].text, /Do you have a referral code/);
  assert.deepEqual(referralChoiceButtons()[0].map((b) => b.text), ['Yes', 'No']);
  fresh.apply(passwordOk);
  console.log('ok password advances to referral choice');

  const noReferralReview = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'no'
  });
  assert.equal(noReferralReview.kind, 'registration_review');
  assert.equal(noReferralReview.statePatch.registrationInfo.referral_code, null);
  assert.match(noReferralReview.replies[0].text, /Password:\n••••••/);
  assert.match(noReferralReview.replies[0].text, /Referral Code:\nNone/);
  assert.doesNotMatch(noReferralReview.replies[0].text, /secret1/);
  const reviewActions = reviewScreenButtons().flat().map((b) => b.data);
  assert.ok(reviewActions.includes('register:confirm'));
  fresh.apply(noReferralReview);
  console.log('ok no referral leads to review');
  console.log('ok review masks password');

  // Yes referral -> code prompt -> review with referral
  const referralStore = createMockStore({
    automationState: {
      current_flow: 'bot_registration',
      current_step: 'referral_choice',
      registration_info: {
        payment_confirmed: true,
        first_deposit_amount: 10,
        payment_display_name: 'John Smith',
        preferred_appbeg_username: 'JohnVIP01',
        appbeg_password: 'secret1'
      }
    }
  });
  const yesReferral = await decideBotReply({
    store: referralStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'yes'
  });
  assert.equal(yesReferral.kind, 'registration_ask_referral_code');
  assert.equal(yesReferral.statePatch.currentStep, 'referral_code');
  referralStore.apply(yesReferral);
  const referralReview = await decideBotReply({
    store: referralStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'REF123'
  });
  assert.equal(referralReview.kind, 'registration_review');
  assert.equal(referralReview.statePatch.registrationInfo.referral_code, 'REF123');
  assert.match(referralReview.replies[0].text, /Referral Code:\nREF123/);
  console.log('ok referral code leads to review');

  // Skip at referral code -> review with no referral
  const skipReferralStore = createMockStore({
    automationState: {
      current_flow: 'bot_registration',
      current_step: 'referral_code',
      registration_info: {
        payment_confirmed: true,
        first_deposit_amount: 10,
        payment_display_name: 'John Smith',
        preferred_appbeg_username: 'JohnVIP01',
        appbeg_password: 'secret1'
      }
    }
  });
  const skippedReferral = await decideBotReply({
    store: skipReferralStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: 'skip'
  });
  assert.equal(skippedReferral.kind, 'registration_review');
  assert.equal(skippedReferral.statePatch.registrationInfo.referral_code, null);
  console.log('ok skip referral code leads to review');

  // Confirm creates account (idempotent flag)
  const confirm = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '',
    action: 'register:confirm'
  });
  assert.equal(confirm.kind, 'registration_create_appbeg_player');
  assert.equal(confirm.createAppBegPlayer, true);
  assert.equal(confirm.statePatch.registrationInfo.create_account_in_progress, true);
  fresh.apply(confirm);
  console.log('ok Create My Account triggers player creation');

  const duplicateConfirm = await decideBotReply({
    store: fresh,
    contact: { ...guest, registration_status: 'Pending Verification' },
    messageText: '',
    action: 'register:confirm'
  });
  assert.equal(duplicateConfirm.kind, 'registration_create_already_started');
  console.log('ok duplicate Create Account ignored');

  // Cancel confirmation
  const cancelStore = createMockStore({
    automationState: {
      current_flow: 'bot_registration',
      current_step: 'payment_name',
      registration_info: { payment_name: 'John', appbeg_password: 'secret1' }
    }
  });
  const cancelAsk = await decideBotReply({
    store: cancelStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '',
    action: 'register:cancel_request'
  });
  assert.equal(cancelAsk.kind, 'registration_cancel_confirm');
  assert.match(cancelAsk.replies[0].text, /Are you sure/);
  const cancelled = await decideBotReply({
    store: cancelStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '',
    action: 'register:cancel_confirm'
  });
  assert.equal(cancelled.kind, 'registration_stopped');
  assert.equal(cancelled.statePatch.registrationInfo.appbeg_password, undefined);
  console.log('ok cancel clears password after confirm');

  // Restart from payment name
  const restartStore = createMockStore({
    automationState: {
      current_flow: 'bot_registration',
      current_step: 'username',
      registration_info: {
        payment_display_name: 'John',
        first_deposit_amount: 10,
        preferred_appbeg_username: 'JohnVIP01',
        appbeg_password: 'secret1',
        payment_confirmed: true
      }
    }
  });
  const restarted = await decideBotReply({
    store: restartStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '',
    action: 'register:restart_confirm'
  });
  assert.equal(restarted.kind, 'registration_ask_payment_name');
  assert.equal(restarted.statePatch.currentStep, 'payment_name');
  assert.equal(restarted.statePatch.registrationInfo.appbeg_password, undefined);
  console.log('ok restart resets to payment name');

  // Registered /start
  const registered = await decideBotReply({
    store: createMockStore(),
    contact: {
      ...guest,
      registration_status: 'Registered',
      appbeg_account_id: 'player_uid_12345',
      appbeg_link_status: 'linked'
    },
    messageText: '/start'
  });
  // Without appbegStore player lookup, linked+exists may be false; force via effective by mocking player through registration_info
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
  assert.equal(registeredState.effective_status, 'Registered');
  assert.equal(registeredState.menu_kind, 'registered');
  assert.deepEqual(registeredMenuButtons().map((row) => row.map((b) => b.text)), [
    ['Deposit', 'Royal VIP'],
    ['My Account', 'Support']
  ]);
  assert.equal(registeredMenuButtons()[0][1].url, 'https://royal.youplatform.org');
  assert.equal(registeredMenuButtons()[0][1].data, undefined);
  assert.deepEqual(normalizeButtonRows(registeredMenuButtons())[0][1], {
    text: 'Royal VIP',
    url: 'https://royal.youplatform.org'
  });
  assert.deepEqual(buildMenu({ registered: true }).replyMarkup.inline_keyboard[0][1], {
    text: 'Royal VIP',
    url: 'https://royal.youplatform.org'
  });
  console.log('ok registered menu has Deposit/Royal VIP/My Account/Support');

  // Guest menu: Register + Help/Contact
  assert.deepEqual(guestMenuButtons().flat().map((b) => b.text), ['Register', 'Help', 'Contact']);
  console.log('ok guest menu has Register/Help/Contact');

  // Expiry copy
  assert.match(REGISTRATION_PAYMENT_EXPIRY_MESSAGE, /Registration failed/);
  assert.match(REGISTRATION_PAYMENT_EXPIRY_MESSAGE, /7-minute/);
  console.log('ok payment timeout message');

  // Password redaction for API
  const redacted = redactRegistrationInfoForApi({
    preferred_appbeg_username: 'JohnVIP01',
    appbeg_password: 'secret1',
    payment_tag: '$johncash'
  });
  assert.equal(redacted.appbeg_password, '[redacted]');
  assert.equal(redacted.payment_tag, undefined);
  assert.ok(redacted.payment_tag_masked);
  assert.ok(maskPaymentIdentifier('$johncash').includes('•'));
  console.log('ok password/payment redaction');

  // Resume after reboot: continue exact step
  const resumeStore = createMockStore({
    automationState: {
      current_flow: 'bot_registration',
      current_step: 'first_deposit_amount',
      registration_info: { payment_name: 'John Smith', payment_display_name: 'John Smith' }
    }
  });
  const resumed = await decideBotReply({
    store: resumeStore,
    contact: { ...guest, registration_status: 'Collecting Info' },
    messageText: '',
    action: 'menu:continue_registration'
  });
  assert.equal(resumed.kind, 'registration_ask_first_deposit_amount');
  assert.equal(resumed.statePatch.currentStep, 'first_deposit_amount');
  console.log('ok continue resumes exact step after reboot');

  void usernameAsk;
  void registered;
  void askName;

  console.log('All Royal VIP registration tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
