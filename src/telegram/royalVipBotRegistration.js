/**
 * Royal VIP BotFather registration wizard (payment-first).
 *
 * Flow:
 * payment_name → first_deposit_amount → QR / await payment
 * → username → password → review → create account
 */

import {
  MIN_REGISTRATION_DEPOSIT,
  parseFirstDepositAmount,
  chatbotWelcomeCooldownMs,
  isReferralSkipInput
} from '../registration/utils.js';
import {
  APPBEG_PASSWORD_HELP,
  APPBEG_USERNAME_HELP,
  validateAppBegPassword,
  validateAppBegUsername
} from '../registration/appbegValidation.js';
import { formatDepositAmount } from '../payments/methodUtils.js';
import {
  BOT_REGISTRATION_FLOW,
  clearedBotRegistrationInfo,
  guestMenuButtons,
  paymentQrRetryButtons,
  referralChoiceButtons,
  registrationNavButtons,
  registeredMenuButtons,
  resolveEffectiveRegistrationState,
  reviewScreenButtons,
  waitingPaymentCancelButtons
} from './botRegistrationState.js';
import { REGISTRATION_QR_LOAD_FAILED_MESSAGE } from '../payments/methodUtils.js';

const GREETING_PATTERNS = /^(hi|hello|hey|yo|hola|howdy|sup|what'?s up|good morning|good afternoon|good evening)\b/i;

export const PAYMENT_NAME_PROMPT = [
  'What is your full name as it appears on your payment account?',
  '',
  'Example:',
  'John Smith'
].join('\n');

export const DEPOSIT_AMOUNT_PROMPT = [
  'How much would you like to deposit today?',
  '',
  'Minimum deposit:',
  `$${MIN_REGISTRATION_DEPOSIT}`
].join('\n');

export const USERNAME_PROMPT = [
  'Payment received and verified!',
  '',
  'Now choose your Royal VIP username.',
  '',
  'Example:',
  'JohnVIP01',
  '',
  APPBEG_USERNAME_HELP
].join('\n');

export const PASSWORD_PROMPT = [
  'Create a password for your Royal VIP account.',
  '',
  'Minimum:',
  '6 characters'
].join('\n');

export const REFERRAL_CHOICE_PROMPT = 'Do you have a referral code?';

export const REFERRAL_CODE_PROMPT = [
  'Please enter your referral code.',
  '',
  'You can also type Skip.'
].join('\n');

export const ACCOUNT_CREATE_PROGRESS = [
  'Creating your Royal VIP account...',
  '',
  '✓ Verifying payment',
  '✓ Checking username',
  '✓ Creating account',
  '✓ Finalizing setup'
].join('\n');

export function isCasualOffTopicMessage(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (GREETING_PATTERNS.test(value)) return true;
  if (/^(ok|okay|thanks|thank you|cool|sure|yes|no|yep|nope)$/i.test(value)) return true;
  return false;
}

export async function resolveRegistrationDefaultQr(store) {
  if (typeof store.getRegistrationDefaultPaymentQr === 'function') {
    return store.getRegistrationDefaultPaymentQr();
  }
  const methods = await store.listActivePaymentMethodsForRegistration?.() || [];
  for (const method of methods) {
    const qr = typeof store.getActivePaymentQrForRegistration === 'function'
      ? await store.getActivePaymentQrForRegistration(method.id)
      : await store.getActiveDefaultPaymentQr?.(method.id);
    if (qr?.file_path) {
      return {
        paymentMethodId: method.id,
        paymentMethodName: method.name,
        paymentMethodKey: method.key,
        qr
      };
    }
  }
  return null;
}

function buildSendPaymentQrPayload(info, qrSource, amount) {
  return {
    paymentMethodId: qrSource.paymentMethodId,
    paymentMethodName: qrSource.paymentMethodName,
    paymentDisplayName: info.payment_display_name || info.payment_name,
    firstDepositAmount: amount
  };
}

function flowReminder(promptText, info, step, buttons = registrationNavButtons()) {
  return {
    kind: 'registration_flow_reminder',
    replies: [{
      text: [
        "We're currently registering your account.",
        '',
        'Please complete the current step first.',
        '',
        promptText
      ].join('\n'),
      buttons
    }],
    statePatch: {
      currentFlow: BOT_REGISTRATION_FLOW,
      currentStep: step,
      registrationInfo: info
    },
    escalate: false,
    logEvent: { event: 'flow_ignored_greeting', step }
  };
}

function offTopicGuard(text, promptText, info, step, buttons) {
  if (!isCasualOffTopicMessage(text)) return null;
  return flowReminder(promptText, info, step, buttons);
}

function isReferralYesInput(text = '') {
  return /^(yes|y)$/i.test(String(text || '').trim());
}

function isReferralNoInput(text = '') {
  return /^(no|n|skip)$/i.test(String(text || '').trim());
}

function validateReferralCodeInput(text = '') {
  const value = String(text || '').trim();
  if (!value) {
    return { ok: false, error: 'Referral code cannot be blank. Enter the code or tap Skip.' };
  }
  if (value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return { ok: false, error: 'That referral code format is not valid. Enter letters, numbers, dashes, or underscores only, or tap Skip.' };
  }
  return { ok: true, referralCode: value };
}

export function reviewDecision(info) {
  const amount = info.first_deposit_amount ?? info.requested_deposit_amount;
  const text = [
    '━━━━━━━━━━━━━━',
    'Payment Name:',
    info.payment_display_name || info.payment_name || '—',
    '',
    'First Deposit:',
    amount != null ? formatDepositAmount(amount) : '—',
    '',
    'Royal VIP Username:',
    info.preferred_appbeg_username || '—',
    '',
    'Password:',
    info.appbeg_password ? '••••••' : '—',
    '',
    'Referral Code:',
    info.referral_code || 'None',
    '━━━━━━━━━━━━━━'
  ].join('\n');

  return {
    kind: 'registration_review',
    replies: [{ text, buttons: reviewScreenButtons() }],
    statePatch: {
      currentFlow: BOT_REGISTRATION_FLOW,
      currentStep: 'review',
      registrationInfo: {
        ...info,
        ready_to_create_player: true
      }
    },
    escalate: false,
    logEvent: { event: 'flow_step', step: 'review' }
  };
}

export async function startRoyalVipRegistration(contact, info, store, { resumed = false } = {}) {
  const qrSource = await resolveRegistrationDefaultQr(store);
  if (!qrSource) {
    return {
      kind: 'registration_no_payment_methods',
      replies: [{
        text: 'Registration payments are not available right now. Please contact staff.',
        buttons: guestMenuButtons()
      }],
      statePatch: null,
      escalate: false
    };
  }

  const existingInfo = info && typeof info === 'object' ? info : {};
  return {
    kind: 'registration_ask_payment_name',
    replies: [{
      text: PAYMENT_NAME_PROMPT,
      buttons: registrationNavButtons()
    }],
    statePatch: {
      currentFlow: BOT_REGISTRATION_FLOW,
      currentStep: 'payment_name',
      registrationInfo: {
        ...clearedBotRegistrationInfo(contact, existingInfo),
        telegram_display_name: contact.display_name,
        telegram_username: contact.username || null,
        telegram_user_id: contact.telegram_id,
        registration_method: 'chatbot',
        payment_method_id: qrSource.paymentMethodId,
        payment_method_name: qrSource.paymentMethodName,
        payment_method_key: qrSource.paymentMethodKey,
        payment_app: qrSource.paymentMethodName
      }
    },
    setStatus: 'Collecting Info',
    replaceRegistrationInfo: true,
    escalate: false,
    logEvent: {
      event: resumed ? 'flow_resumed' : 'flow_started',
      step: 'payment_name'
    }
  };
}

async function askUsernameAvailability(username) {
  const appbeg = globalThis.appbegStore;
  if (!appbeg?.configured || typeof appbeg.getPlayerByUsername !== 'function') {
    return { available: true, checked: false };
  }
  try {
    const existing = await appbeg.getPlayerByUsername(username);
    return { available: !existing, checked: true };
  } catch (error) {
    console.log(`[chatbot] username_availability_check_failed error=${error.message}`);
    return { available: null, checked: false, error: true };
  }
}

export async function continueRoyalVipRegistration({
  store,
  contact,
  text,
  action,
  step,
  info,
  automationState = null,
  effective = null
}) {
  const normalizedStep = String(step || 'welcome');
  const cancelButtons = waitingPaymentCancelButtons();

  if (action === 'bot:confirm') {
    if (info.appbeg_creation_complete || info.create_account_in_progress) {
      return {
        kind: 'registration_create_already_started',
        replies: [{
          text: 'Your account is already being created or has been created. Please wait a moment.',
          buttons: registeredMenuButtons()
        }],
        statePatch: null,
        escalate: false,
        logEvent: { event: 'create_account_duplicate_ignored' }
      };
    }
    if (!info.payment_confirmed) {
      return {
        kind: 'registration_waiting_payment',
        replies: [{
          text: 'We are still waiting to verify your payment. Please complete the QR payment first.',
          buttons: cancelButtons
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
        escalate: false
      };
    }
    if (!info.preferred_appbeg_username || !info.appbeg_password) {
      return reviewDecision(info);
    }
    return {
      kind: 'registration_create_appbeg_player',
      replies: [{ text: ACCOUNT_CREATE_PROGRESS }],
      createAppBegPlayer: true,
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'creating_account',
        registrationInfo: {
          ...info,
          create_account_in_progress: true,
          registration_method: 'chatbot',
          registration_confirmed: true
        }
      },
      setStatus: 'Pending Verification',
      escalate: false,
      logEvent: { event: 'create_player_requested' }
    };
  }

  if (action === 'bot:edit' || action === 'bot:change_payment_details') {
    return {
      kind: 'registration_ask_payment_name',
      replies: [{ text: PAYMENT_NAME_PROMPT, buttons: registrationNavButtons() }],
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'payment_name',
        registrationInfo: {
          ...info,
          preferred_appbeg_username: undefined,
          appbeg_password: undefined,
          ready_to_create_player: false
        }
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'payment_name', reason: 'edit' }
    };
  }

  if (action === 'bot:edit_username') {
    return {
      kind: 'registration_ask_username',
      replies: [{ text: USERNAME_PROMPT, buttons: registrationNavButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
      escalate: false
    };
  }

  if (action === 'bot:edit_password') {
    return {
      kind: 'registration_ask_password',
      replies: [{ text: PASSWORD_PROMPT, buttons: registrationNavButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'password', registrationInfo: info },
      escalate: false
    };
  }

  if (action === 'bot:edit_referral') {
    return {
      kind: 'registration_ask_referral_choice',
      replies: [{ text: REFERRAL_CHOICE_PROMPT, buttons: referralChoiceButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'referral_choice', registrationInfo: info },
      escalate: false
    };
  }

  if (action === 'bot:enter_referral') {
    console.log('[chatbot] referral_choice_recorded', JSON.stringify({ contactId: contact?.id, choice: 'yes' }));
    return {
      kind: 'registration_ask_referral_code',
      replies: [{ text: REFERRAL_CODE_PROMPT, buttons: referralChoiceButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'referral_code', registrationInfo: info },
      escalate: false,
      logEvent: { event: 'referral_choice_recorded', choice: 'yes' }
    };
  }

  if (action === 'bot:skip_referral') {
    console.log('[chatbot] referral_choice_recorded', JSON.stringify({ contactId: contact?.id, choice: 'no' }));
    return reviewDecision({ ...info, referral_code: null });
  }

  if (action === 'bot:payment_instructions') {
    const amount = info.first_deposit_amount ?? info.requested_deposit_amount;
    return {
      kind: 'registration_payment_instructions',
      replies: [{
        text: [
          `Please send ${amount != null ? formatDepositAmount(amount) : 'your deposit'} using the QR code we sent.`,
          `Payment Name: ${info.payment_display_name || info.payment_name || '—'}`,
          'We will continue automatically after payment is verified.'
        ].join('\n'),
        buttons: cancelButtons
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (action === 'bot:retry_payment_qr') {
    const amount = info.first_deposit_amount ?? info.requested_deposit_amount;
    if (amount == null) {
      return {
        kind: 'registration_ask_first_deposit_amount',
        replies: [{
          text: [
            `Thank you, ${info.payment_display_name || info.payment_name || 'there'}.`,
            '',
            DEPOSIT_AMOUNT_PROMPT
          ].join('\n'),
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'first_deposit_amount', registrationInfo: info },
        escalate: false
      };
    }
    const qrSource = await resolveRegistrationDefaultQr(store);
    if (!qrSource) {
      return {
        kind: 'registration_qr_unavailable',
        replies: [{
          text: REGISTRATION_QR_LOAD_FAILED_MESSAGE,
          buttons: paymentQrRetryButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'first_deposit_amount', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'registration_qr_missing', amount }
      };
    }
    return {
      kind: 'registration_send_payment_qr',
      replies: [],
      sendPaymentQr: buildSendPaymentQrPayload(info, qrSource, amount),
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'first_deposit_amount',
        registrationInfo: {
          ...info,
          payment_method_id: qrSource.paymentMethodId,
          payment_method_name: qrSource.paymentMethodName,
          payment_method_key: qrSource.paymentMethodKey,
          payment_app: qrSource.paymentMethodName
        }
      },
      escalate: false,
      logEvent: {
        event: 'registration_qr_retry',
        amount,
        paymentMethodId: qrSource.paymentMethodId
      }
    };
  }

  if (normalizedStep === 'welcome') {
    if (/^register$/i.test(String(text || '').trim())) {
      return startRoyalVipRegistration(contact, info, store);
    }
    const state = effective || await resolveEffectiveRegistrationState({ contact, automationState });
    return {
      kind: state.menu_kind === 'guest' ? 'welcome' : `menu_${state.menu_kind}`,
      replies: [{
        text: state.menu_kind === 'registered'
          ? 'Welcome back!'
          : [
            '👋 Welcome to Royal VIP!',
            '',
            'It looks like you are not registered with us yet.'
          ].join('\n'),
        buttons: state.menu_kind === 'registered' ? registeredMenuButtons() : guestMenuButtons()
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (normalizedStep === 'payment_name' || normalizedStep === 'payment_display_name') {
    const offTopic = offTopicGuard(text, PAYMENT_NAME_PROMPT, info, 'payment_name');
    if (offTopic) return offTopic;

    const name = String(text || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80 || name.startsWith('/')) {
      return {
        kind: 'registration_ask_payment_name',
        replies: [{
          text: [
            'Please enter your full name as it appears on your payment account.',
            '',
            'Example:',
            'John Smith'
          ].join('\n'),
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'payment_name', registrationInfo: info },
        escalate: false
      };
    }

    const nextInfo = {
      ...info,
      payment_name: name,
      payment_display_name: name
    };
    return {
      kind: 'registration_ask_first_deposit_amount',
      replies: [{
        text: [
          `Thank you, ${name}.`,
          '',
          DEPOSIT_AMOUNT_PROMPT
        ].join('\n'),
        buttons: registrationNavButtons()
      }],
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'first_deposit_amount',
        registrationInfo: nextInfo
      },
      setStatus: 'Collecting Info',
      escalate: false,
      logEvent: { event: 'flow_step', step: 'first_deposit_amount' }
    };
  }

  if (normalizedStep === 'first_deposit_amount') {
    const amountPrompt = [
      `Thank you, ${info.payment_display_name || info.payment_name || 'there'}.`,
      '',
      DEPOSIT_AMOUNT_PROMPT
    ].join('\n');
    const offTopic = offTopicGuard(text, amountPrompt, info, 'first_deposit_amount');
    if (offTopic) return offTopic;

    const amount = parseFirstDepositAmount(text);
    if (amount == null) {
      return {
        kind: 'registration_ask_first_deposit_amount',
        replies: [{
          text: [
            `Please enter a valid deposit amount of at least $${MIN_REGISTRATION_DEPOSIT}.`,
            '',
            'Numbers only. Example: 10'
          ].join('\n'),
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'first_deposit_amount', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'deposit_amount_invalid' }
      };
    }

    const qrSource = await resolveRegistrationDefaultQr(store);
    if (!qrSource) {
      return {
        kind: 'registration_qr_unavailable',
        replies: [{
          text: REGISTRATION_QR_LOAD_FAILED_MESSAGE,
          buttons: paymentQrRetryButtons()
        }],
        statePatch: {
          currentFlow: BOT_REGISTRATION_FLOW,
          currentStep: 'first_deposit_amount',
          registrationInfo: {
            ...info,
            first_deposit_amount: amount,
            requested_deposit_amount: amount,
            payment_confirmed: false
          }
        },
        escalate: false,
        logEvent: { event: 'registration_qr_missing', amount }
      };
    }

    const nextInfo = {
      ...info,
      payment_method_id: qrSource.paymentMethodId,
      payment_method_name: qrSource.paymentMethodName,
      payment_method_key: qrSource.paymentMethodKey,
      payment_app: qrSource.paymentMethodName,
      first_deposit_amount: amount,
      requested_deposit_amount: amount,
      payment_confirmed: false
    };

    return {
      kind: 'registration_send_payment_qr',
      replies: [],
      sendPaymentQr: buildSendPaymentQrPayload(nextInfo, qrSource, amount),
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        // Stay on amount step until QR send succeeds — handler advances to await_payment.
        currentStep: 'first_deposit_amount',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: {
        event: 'registration_amount_accepted',
        amount,
        paymentMethodId: qrSource.paymentMethodId,
        qrId: qrSource.qr?.id
      }
    };
  }

  if (
    normalizedStep === 'await_payment'
    || normalizedStep === 'await_payment_done'
    || normalizedStep === 'waiting_for_payment_confirmation'
  ) {
    if (info.payment_confirmed) {
      return {
        kind: 'registration_ask_username',
        replies: [{ text: USERNAME_PROMPT, buttons: registrationNavButtons() }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
        escalate: false
      };
    }
    if (text && !isCasualOffTopicMessage(text) && !/^(done|paid|i have paid)$/i.test(text)) {
      return {
        kind: 'registration_waiting_payment',
        replies: [{
          text: [
            'We are still waiting to verify your payment.',
            'No further questions are needed right now.',
            'We will continue automatically once payment is verified.'
          ].join('\n'),
          buttons: cancelButtons
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
        escalate: false
      };
    }
    return {
      kind: 'registration_waiting_payment',
      replies: [{
        text: [
          'We will automatically verify your payment and continue your registration.',
          'Please complete the QR payment within 7 minutes.'
        ].join('\n'),
        buttons: cancelButtons
      }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
      escalate: false
    };
  }

  if (normalizedStep === 'username') {
    if (!info.payment_confirmed) {
      return {
        kind: 'registration_waiting_payment',
        replies: [{
          text: 'We are still waiting to verify your payment before choosing a username.',
          buttons: cancelButtons
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
        escalate: false
      };
    }

    const offTopic = offTopicGuard(text, USERNAME_PROMPT, info, 'username');
    if (offTopic) return offTopic;

    const usernameResult = validateAppBegUsername(text);
    if (!usernameResult.ok) {
      return {
        kind: 'registration_ask_username',
        replies: [{
          text: `${usernameResult.error}\n\n${usernameResult.help}`,
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
        escalate: false
      };
    }

    const availability = await askUsernameAvailability(usernameResult.username);
    if (availability.error) {
      return {
        kind: 'registration_ask_username',
        replies: [{
          text: 'We could not check that username right now. Your progress has been saved. Please try again.',
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'username_availability_api_unavailable' }
      };
    }
    if (availability.checked && !availability.available) {
      return {
        kind: 'registration_ask_username',
        replies: [{
          text: [
            'Username already exists.',
            'Please choose another username.'
          ].join('\n'),
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'username_unavailable' }
      };
    }

    const nextInfo = { ...info, preferred_appbeg_username: usernameResult.username };
    return {
      kind: 'registration_ask_password',
      replies: [{ text: PASSWORD_PROMPT, buttons: registrationNavButtons() }],
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'password',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'password' }
    };
  }

  if (normalizedStep === 'password') {
    if (!info.payment_confirmed) {
      return {
        kind: 'registration_waiting_payment',
        replies: [{
          text: 'We are still waiting to verify your payment.',
          buttons: cancelButtons
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
        escalate: false
      };
    }

    const offTopic = offTopicGuard(text, PASSWORD_PROMPT, info, 'password');
    if (offTopic) return offTopic;

    const passwordResult = validateAppBegPassword(text);
    if (!passwordResult.ok) {
      return {
        kind: 'registration_ask_password',
        replies: [{
          text: `${passwordResult.error}\n\n${APPBEG_PASSWORD_HELP}`,
          buttons: registrationNavButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'password', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'password_validation_failed' }
      };
    }

    const nextInfo = { ...info, appbeg_password: passwordResult.password };
    return {
      kind: 'registration_ask_referral_choice',
      replies: [{ text: REFERRAL_CHOICE_PROMPT, buttons: referralChoiceButtons() }],
      statePatch: {
        currentFlow: BOT_REGISTRATION_FLOW,
        currentStep: 'referral_choice',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'referral_choice' }
    };
  }

  if (normalizedStep === 'referral_choice') {
    if (!info.payment_confirmed) {
      return {
        kind: 'registration_waiting_payment',
        replies: [{
          text: 'We are still waiting to verify your payment.',
          buttons: cancelButtons
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'await_payment', registrationInfo: info },
        escalate: false
      };
    }
    if (isReferralYesInput(text)) {
      console.log('[chatbot] referral_choice_recorded', JSON.stringify({ contactId: contact?.id, choice: 'yes' }));
      return {
        kind: 'registration_ask_referral_code',
        replies: [{ text: REFERRAL_CODE_PROMPT, buttons: referralChoiceButtons() }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'referral_code', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'referral_choice_recorded', choice: 'yes' }
      };
    }
    if (isReferralNoInput(text)) {
      console.log('[chatbot] referral_choice_recorded', JSON.stringify({ contactId: contact?.id, choice: 'no' }));
      return reviewDecision({ ...info, referral_code: null });
    }
    return {
      kind: 'registration_ask_referral_choice',
      replies: [{ text: REFERRAL_CHOICE_PROMPT, buttons: referralChoiceButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'referral_choice', registrationInfo: info },
      escalate: false
    };
  }

  if (normalizedStep === 'referral_code') {
    if (isReferralSkipInput(text)) {
      console.log('[chatbot] referral_code_recorded', JSON.stringify({ contactId: contact?.id, hasReferralCode: false }));
      return reviewDecision({ ...info, referral_code: null });
    }
    const referralResult = validateReferralCodeInput(text);
    if (!referralResult.ok) {
      return {
        kind: 'registration_ask_referral_code',
        replies: [{
          text: referralResult.error,
          buttons: referralChoiceButtons()
        }],
        statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'referral_code', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'referral_code_invalid' }
      };
    }
    console.log('[chatbot] referral_code_recorded', JSON.stringify({ contactId: contact?.id, hasReferralCode: true }));
    return reviewDecision({ ...info, referral_code: referralResult.referralCode });
  }

  if (normalizedStep === 'review' || normalizedStep === 'creating_account') {
    return reviewDecision(info);
  }

  console.log(`[chatbot] invalid_registration_step contact=${contact?.id} step=${normalizedStep}`);
  if (info.payment_confirmed && info.preferred_appbeg_username && info.appbeg_password) {
    return reviewDecision(info);
  }
  if (info.payment_confirmed) {
    return {
      kind: 'registration_ask_username',
      replies: [{ text: USERNAME_PROMPT, buttons: registrationNavButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'username', registrationInfo: info },
      escalate: false
    };
  }
  if (info.payment_display_name || info.payment_name) {
    return {
      kind: 'registration_ask_first_deposit_amount',
      replies: [{ text: DEPOSIT_AMOUNT_PROMPT, buttons: registrationNavButtons() }],
      statePatch: { currentFlow: BOT_REGISTRATION_FLOW, currentStep: 'first_deposit_amount', registrationInfo: info },
      escalate: false
    };
  }
  return startRoyalVipRegistration(contact, info, store, { resumed: true });
}

export function isWelcomeThrottled(automationState) {
  const cooldown = chatbotWelcomeCooldownMs();
  if (!cooldown) return false;
  const last = automationState?.last_auto_welcome_at;
  if (!last) return false;
  const elapsed = Date.now() - new Date(last).getTime();
  if (Number.isNaN(elapsed)) return false;
  return elapsed < cooldown;
}
