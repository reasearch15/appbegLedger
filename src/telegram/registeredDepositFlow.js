/**
 * Registered-user deposit wizard.
 * Deposit → My Account / Another Player → QR → 15-minute deposit window.
 */

import {
  centsToDollars,
  MIN_REGISTRATION_DEPOSIT,
  parseMoneyToCents
} from '../registration/utils.js';
import { formatDepositAmount, formatExactPaymentAmount } from '../payments/methodUtils.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { resolveRegistrationDefaultQr } from './royalVipBotRegistration.js';
import { registeredMenuButtons } from './botRegistrationState.js';

export const REGISTERED_DEPOSIT_FLOW = 'registered_deposit';

/** Explicit bot_sessions workflow keys used while deposit amount entry is active. */
export const DEPOSIT_BOT_SESSION_FLOW = 'deposit';
export const DEPOSIT_BOT_SESSION_STEP_AMOUNT = 'waiting_amount';
export const DEPOSIT_BOT_SESSION_STEP_NAME = 'waiting_payment_name';
export const DEPOSIT_BOT_SESSION_STEP_AWAIT = 'await_payment';
export const DEPOSIT_BOT_SESSION_STEP_RECIPIENT = 'waiting_recipient';

export const DEPOSIT_LOAD_PROMPT = [
  'Who are you loading?',
].join('\n');

export const DEPOSIT_OTHER_USERNAME_PROMPT = [
  'Enter the other player\'s Royal VIP username.'
].join('\n');

export const DEPOSIT_NAME_PROMPT = [
  'What payment name should we match for this deposit?',
  '',
  'Use the exact name that will appear on the payment.'
].join('\n');

export const DEPOSIT_AMOUNT_PROMPT = [
  'How much would you like to deposit?',
  '',
  'Minimum deposit:',
  `$${MIN_REGISTRATION_DEPOSIT}`
].join('\n');

function depositCancelButtons() {
  return [
    [{ label: '❌ CANCEL DEPOSIT', action: 'deposit:cancel', text: 'Cancel Deposit', data: 'deposit:cancel' }]
  ];
}

function depositTargetButtons() {
  return [
    [{ label: '👤 MY ACCOUNT', action: 'deposit:my_account', text: 'MY ACCOUNT', data: 'deposit:my_account' }],
    [{ label: '👥 ANOTHER PLAYER', action: 'deposit:other', text: 'ANOTHER PLAYER', data: 'deposit:other' }],
    ...depositCancelButtons()
  ];
}

function activeDepositReuseButtons() {
  return [
    [{ label: '📱 SHOW PAYMENT QR', action: 'deposit:show_qr', text: 'SHOW PAYMENT QR', data: 'deposit:show_qr' }],
    [{ label: '❌ CANCEL DEPOSIT', action: 'deposit:cancel', text: 'Cancel Deposit', data: 'deposit:cancel' }]
  ];
}

export function isRegisteredDepositFlow(flow, step) {
  if (flow === REGISTERED_DEPOSIT_FLOW || flow === DEPOSIT_BOT_SESSION_FLOW) return true;
  return [
    'deposit_payment_name',
    'deposit_amount',
    'deposit_await_payment',
    'deposit_choose_target',
    'deposit_other_username',
    'deposit_confirm_other',
    DEPOSIT_BOT_SESSION_STEP_AMOUNT,
    DEPOSIT_BOT_SESSION_STEP_NAME,
    DEPOSIT_BOT_SESSION_STEP_RECIPIENT
  ].includes(String(step || ''));
}

export function isDepositBotSessionActive(botSession = null) {
  if (!botSession) return false;
  const flow = String(botSession.workflow_key || botSession.workflowKey || '').trim();
  if (flow !== DEPOSIT_BOT_SESSION_FLOW) return false;
  const step = String(botSession.workflow_step || botSession.workflowStep || '').trim();
  return [
    DEPOSIT_BOT_SESSION_STEP_RECIPIENT,
    'deposit_choose_target',
    'deposit_other_username',
    'deposit_confirm_other',
    'deposit_amount',
    'deposit_payment_name',
    'deposit_await_payment'
  ].includes(step);
}

/** True when automation state and/or bot_sessions say deposit is waiting for user input. */
export function isActiveDepositSession(automationState = {}, botSession = null) {
  if (isDepositBotSessionActive(botSession)) return true;
  const flow = automationState?.current_flow || automationState?.currentFlow || null;
  const step = String(automationState?.current_step || automationState?.currentStep || '');
  const info = automationState?.registration_info || automationState?.registrationInfo || {};
  if (flow === REGISTERED_DEPOSIT_FLOW || flow === DEPOSIT_BOT_SESSION_FLOW) return true;
  if ([
    'deposit_payment_name',
    'deposit_amount',
    'deposit_await_payment',
    DEPOSIT_BOT_SESSION_STEP_AMOUNT,
    DEPOSIT_BOT_SESSION_STEP_NAME
  ].includes(step)) return true;
  return Boolean(info.deposit_in_progress || info.deposit_awaiting_payment);
}

export function depositStepFromBotSession(botSession = null) {
  const step = String(botSession?.workflow_step || botSession?.workflowStep || '').trim();
  if (step === DEPOSIT_BOT_SESSION_STEP_NAME || step === 'deposit_payment_name') return 'deposit_payment_name';
  if (step === DEPOSIT_BOT_SESSION_STEP_AWAIT || step === 'deposit_await_payment') return 'deposit_await_payment';
  if (step === DEPOSIT_BOT_SESSION_STEP_RECIPIENT || step === 'deposit_other_username') return 'deposit_other_username';
  if (step === 'deposit_choose_target') return 'deposit_choose_target';
  return null;
}

async function writeDepositBotSession(store, contactId, {
  step = DEPOSIT_BOT_SESSION_STEP_AMOUNT,
  context = null,
  reset = true
} = {}) {
  if (!store || !contactId) return null;
  if (reset && typeof store.resetBotState === 'function') {
    await store.resetBotState(contactId, { actorName: 'Bot', action: 'deposit' }).catch(() => null);
  }
  if (typeof store.setBotScreen === 'function') {
    return store.setBotScreen(contactId, 'Deposit', {
      actorName: 'Bot',
      pushCurrent: false,
      workflowKey: DEPOSIT_BOT_SESSION_FLOW,
      workflowStep: step,
      context: context || {}
    }).catch(() => null);
  }
  return null;
}

async function clearDepositBotSession(store, contactId) {
  if (!store || !contactId || typeof store.resetBotState !== 'function') return null;
  return store.resetBotState(contactId, { actorName: 'Bot', action: 'home' }).catch(() => null);
}

/**
 * Resolve the active deposit wizard step even when flow/step were partially wiped
 * (Help/Support/main-menu read-only surfaces leave deposit_in_progress behind).
 */
export function resolveRegisteredDepositStep(step, info = {}) {
  const raw = String(step || '').trim();
  if (raw === DEPOSIT_BOT_SESSION_STEP_AMOUNT) return 'deposit_amount';
  if (raw === DEPOSIT_BOT_SESSION_STEP_NAME) return 'deposit_payment_name';
  if (raw === DEPOSIT_BOT_SESSION_STEP_AWAIT) return 'deposit_await_payment';
  if (raw === DEPOSIT_BOT_SESSION_STEP_RECIPIENT || raw === 'deposit_other_username') return 'deposit_other_username';
  if (['deposit_payment_name', 'deposit_amount', 'deposit_await_payment', 'deposit_choose_target', 'deposit_other_username', 'deposit_confirm_other'].includes(raw)) {
    return raw;
  }
  if (info.deposit_awaiting_payment) return 'deposit_await_payment';
  if (info.deposit_in_progress) return 'deposit_choose_target';
  return raw || 'deposit_choose_target';
}

/** Temporary wizard fields that must not block a fresh deposit after expiry/cancel. */
export function clearStaleDepositSessionFields(info = {}) {
  const next = { ...(info || {}) };
  delete next.deposit_in_progress;
  delete next.deposit_awaiting_payment;
  delete next.deposit_requested_amount;
  delete next.deposit_payment_window_id;
  delete next.payment_window_id;
  delete next.payment_window_expires_at;
  delete next.payment_qr_code_id;
  delete next.payment_qr_telegram_message_id;
  delete next.deposit_qr_telegram_message_id;
  return next;
}

/**
 * A deposit window is active only when pending, unexpired, and unmatched.
 * Cancelled / completed / failed / expired windows are never active.
 */
export function isGenuinelyActiveDepositWindow(window, { now = new Date() } = {}) {
  if (!window) return false;
  const status = String(window.status || '').toLowerCase();
  if (status !== 'active') return false;
  if (window.matched_payment_event_id != null && window.matched_payment_event_id !== '') return false;
  const flow = window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION;
  if (flow !== PAYMENT_WINDOW_FLOW.DEPOSIT) return false;
  const expiresAt = new Date(window.expires_at).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return false;
  return expiresAt > nowMs;
}

/**
 * Before a new Deposit attempt: mark due windows expired and strip stale session fields.
 * Does not delete historical rows. Returns any still-active unexpired deposit window.
 */
export async function normalizeRegisteredDepositAttempt(store, contactId, info = {}) {
  const sessionWindowId = info?.deposit_payment_window_id ?? info?.payment_window_id ?? null;

  if (sessionWindowId != null && typeof store.expireRegistrationPaymentWindowIfDue === 'function') {
    await store.expireRegistrationPaymentWindowIfDue(sessionWindowId).catch(() => null);
  }

  // Soft-expire any other due deposit windows for this contact (status still active, past expires_at).
  if (typeof store.listRegistrationPaymentWindowsForExpiryWorker === 'function'
    && typeof store.expireRegistrationPaymentWindowIfDue === 'function') {
    const due = await store.listRegistrationPaymentWindowsForExpiryWorker(50).catch(() => []);
    for (const window of due || []) {
      if (Number(window.contact_id) !== Number(contactId)) continue;
      if ((window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION) !== PAYMENT_WINDOW_FLOW.DEPOSIT) continue;
      if (String(window.status || '').toLowerCase() !== 'active') continue;
      await store.expireRegistrationPaymentWindowIfDue(window.id).catch(() => null);
    }
  }

  let activeWindow = null;
  if (typeof store.getActiveRegistrationPaymentWindow === 'function') {
    activeWindow = await store.getActiveRegistrationPaymentWindow(contactId, {
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
    }).catch(() => null);
  }

  if (isGenuinelyActiveDepositWindow(activeWindow)) {
    return {
      activeWindow,
      info: { ...(info || {}) },
      staleCleared: false
    };
  }

  return {
    activeWindow: null,
    info: clearStaleDepositSessionFields(info),
    staleCleared: true
  };
}

function resumeActiveDepositDecision(activeWindow, info = {}) {
  const recipient = activeWindow.recipient_username || info.deposit_recipient_username || 'your account';
  return {
    kind: 'deposit_waiting_payment',
    replies: [{
      text: [
        '💵 You already have an active deposit.',
        '',
        `Loading: ${recipient}`,
        'This window stays open for 15 minutes.',
        'Send payment using the QR instructions. Do not enter an amount here.'
      ].join('\n'),
      buttons: activeDepositReuseButtons()
    }],
    statePatch: {
      currentFlow: REGISTERED_DEPOSIT_FLOW,
      currentStep: 'deposit_await_payment',
      registrationInfo: {
        ...info,
        deposit_in_progress: true,
        deposit_awaiting_payment: true,
        deposit_payment_window_id: activeWindow.id,
        payment_window_id: activeWindow.id,
        payment_window_expires_at: activeWindow.expires_at
      }
    },
    escalate: false,
    logEvent: { event: 'deposit_active_window_resumed', windowId: activeWindow.id }
  };
}

/**
 * Start or restart a registered deposit after normalizing any expired attempt.
 * Always replaces prior bot flow/session state with a clean deposit wizard.
 * Persists a fresh amount-entry session (caller must apply statePatch before/with the prompt).
 */
export async function beginRegisteredDeposit(store, contact, info = {}) {
  const normalized = await normalizeRegisteredDepositAttempt(store, contact.id, info);
  if (normalized.activeWindow) {
    await writeDepositBotSession(store, contact.id, {
      step: DEPOSIT_BOT_SESSION_STEP_AWAIT,
      context: { window_id: normalized.activeWindow.id }
    });
    const resumed = resumeActiveDepositDecision(normalized.activeWindow, normalized.info);
    console.log(
      `[chatbot] deposit_session_started contact=${contact.id} ` +
      `flow=${DEPOSIT_BOT_SESSION_FLOW} step=${DEPOSIT_BOT_SESSION_STEP_AWAIT} ` +
      `automation_flow=${REGISTERED_DEPOSIT_FLOW} automation_step=deposit_await_payment ` +
      `reason=resume_active_window`
    );
    return resumed;
  }

  const started = await startRegisteredDeposit(contact, normalized.info);
  await writeDepositBotSession(store, contact.id, {
    step: 'deposit_choose_target',
    context: {}
  });
  return started;
}

export async function startRegisteredDeposit(contact, info = {}) {
  const cleaned = clearStaleDepositSessionFields(info);
  return {
    kind: 'deposit_choose_target',
    replies: [{
      text: DEPOSIT_LOAD_PROMPT,
      buttons: depositTargetButtons()
    }],
    statePatch: {
      currentFlow: REGISTERED_DEPOSIT_FLOW,
      currentStep: 'deposit_choose_target',
      registrationInfo: {
        ...cleaned,
        deposit_in_progress: true,
        deposit_awaiting_payment: false
      }
    },
    escalate: false,
    logEvent: { event: 'deposit_flow_started', step: 'deposit_choose_target' }
  };
}

async function sendAmountlessDepositQr(store, contact, info, {
  recipientContactId,
  recipientUsername,
  recipientPlayerUid
}) {
  const qrSource = await resolveRegistrationDefaultQr(store);
  if (!qrSource) {
    return {
      kind: 'deposit_qr_unavailable',
      replies: [{
        text: 'We could not load the payment QR right now. Please try again or contact support.',
        buttons: [
          [{ label: '🔄 Try Again', action: 'bot:deposit', text: 'Try Again', data: 'bot:deposit' }],
          ...registeredMenuButtons()
        ]
      }],
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_choose_target',
        registrationInfo: info
      },
      escalate: false
    };
  }
  return {
    kind: 'registration_send_payment_qr',
    replies: [],
    sendPaymentQr: {
      paymentMethodId: qrSource.paymentMethodId,
      paymentMethodName: qrSource.paymentMethodName,
      paymentDisplayName: null,
      firstDepositAmount: null,
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
      requesterContactId: contact.id,
      recipientContactId,
      recipientUsername,
      recipientPlayerUid
    },
    statePatch: {
      currentFlow: REGISTERED_DEPOSIT_FLOW,
      currentStep: 'deposit_await_payment',
      registrationInfo: {
        ...info,
        payment_method_id: qrSource.paymentMethodId,
        deposit_in_progress: true,
        deposit_awaiting_payment: true,
        deposit_recipient_contact_id: recipientContactId,
        deposit_recipient_username: recipientUsername,
        deposit_recipient_player_uid: recipientPlayerUid
      }
    },
    escalate: false,
    logEvent: { event: 'deposit_qr_requested', recipientContactId }
  };
}

export async function continueRegisteredDeposit({
  store,
  contact,
  text,
  action,
  step,
  info,
  callbackMessageId = null
}) {
  const normalizedStep = resolveRegisteredDepositStep(step, info);

  if (action === 'deposit:cancel' || action === 'bot:stop') {
    const awaitingPayment = Boolean(
      info.deposit_awaiting_payment
      || normalizedStep === 'deposit_await_payment'
      || normalizedStep === DEPOSIT_BOT_SESSION_STEP_AWAIT
    );
    let qrMessageId = Number(
      info.deposit_qr_telegram_message_id
      || info.payment_qr_telegram_message_id
      || 0
    ) || null;
    if (!qrMessageId && typeof store.getBotSession === 'function') {
      const botSession = await store.getBotSession(contact.id).catch(() => null);
      let sessionContext = botSession?.context || null;
      if (!sessionContext && botSession?.context_json) {
        try {
          sessionContext = JSON.parse(botSession.context_json);
        } catch {
          sessionContext = null;
        }
      }
      qrMessageId = Number(
        sessionContext?.qr_telegram_message_id
        || sessionContext?.deposit_qr_telegram_message_id
        || 0
      ) || null;
    }
    const pressedMessageId = Number(callbackMessageId || 0) || null;
    // Cancel Deposit on the QR photo: the callback message IS the photo to remove.
    // Prefer stored id, but always include the pressed QR message when awaiting payment.
    if (!qrMessageId && awaitingPayment && pressedMessageId) {
      qrMessageId = pressedMessageId;
    }

    if (info.deposit_payment_window_id && typeof store.cancelDepositWindow === 'function') {
      await store.cancelDepositWindow({
        contactId: contact.id,
        windowId: info.deposit_payment_window_id
      }).catch(() => null);
    } else if (info.deposit_payment_window_id && store.expireRegistrationPaymentWindow) {
      await store.expireRegistrationPaymentWindow(info.deposit_payment_window_id, { suppressNotification: true }).catch(() => null);
    }
    await clearDepositBotSession(store, contact.id);
    console.log(
      `[chatbot] deposit_cancel_requested contact=${contact.id} ` +
      `qr_message_id=${qrMessageId || 'none'} callback_message_id=${pressedMessageId || 'none'} ` +
      `awaiting_payment=${awaitingPayment}`
    );
    return {
      kind: 'deposit_cancelled',
      removeDepositPaymentMessage: {
        messageId: qrMessageId,
        callbackMessageId: pressedMessageId,
        awaitingPayment
      },
      replies: [{
        text: 'Deposit cancelled. Press Deposit when you are ready to try again.',
        buttons: registeredMenuButtons()
      }],
      statePatch: {
        currentFlow: null,
        currentStep: null,
        registrationInfo: clearStaleDepositSessionFields({
          ...info,
          deposit_in_progress: false,
          deposit_awaiting_payment: false
        })
      },
      escalate: false,
      logEvent: { event: 'deposit_cancelled', qrMessageId, callbackMessageId: pressedMessageId }
    };
  }

  if (action === 'bot:deposit') {
    return beginRegisteredDeposit(store, contact, info);
  }

  if (action === 'deposit:show_qr') {
    const normalized = await normalizeRegisteredDepositAttempt(store, contact.id, info);
    if (!normalized.activeWindow) return beginRegisteredDeposit(store, contact, normalized.info);
    return sendAmountlessDepositQr(store, contact, normalized.info, {
      recipientContactId: normalized.activeWindow.recipient_contact_id || contact.id,
      recipientUsername: normalized.activeWindow.recipient_username,
      recipientPlayerUid: normalized.activeWindow.recipient_player_uid
    });
  }

  if (action === 'deposit:my_account') {
    const username = info.preferred_appbeg_username || contact.appbeg_account_id || 'your account';
    return sendAmountlessDepositQr(store, contact, info, {
      recipientContactId: contact.id,
      recipientUsername: username,
      recipientPlayerUid: info.appbeg_player_uid || contact.appbeg_account_id
    });
  }

  if (action === 'deposit:other') {
    await writeDepositBotSession(store, contact.id, {
      step: DEPOSIT_BOT_SESSION_STEP_RECIPIENT,
      reset: false,
      context: {}
    });
    return {
      kind: 'deposit_ask_other_username',
      replies: [{ text: DEPOSIT_OTHER_USERNAME_PROMPT, buttons: depositCancelButtons() }],
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_other_username',
        registrationInfo: info
      },
      escalate: false
    };
  }

  if (action === 'deposit:continue_other' && info.deposit_pending_recipient_contact_id) {
    return sendAmountlessDepositQr(store, contact, info, {
      recipientContactId: info.deposit_pending_recipient_contact_id,
      recipientUsername: info.deposit_pending_recipient_username,
      recipientPlayerUid: info.deposit_pending_recipient_player_uid
    });
  }

  if (action === 'deposit:retry_qr') {
    return beginRegisteredDeposit(store, contact, info);
  }

  if (normalizedStep === 'deposit_other_username' || action === 'deposit:other') {
    const username = String(text || '').trim();
    if (!username) {
      return {
        kind: 'deposit_ask_other_username',
        replies: [{ text: DEPOSIT_OTHER_USERNAME_PROMPT, buttons: depositCancelButtons() }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_other_username',
          registrationInfo: info
        },
        escalate: false
      };
    }
    const settings = typeof store.getCoadminSettings === 'function'
      ? await store.getCoadminSettings().catch(() => null)
      : null;
    const recipient = typeof store.findRegisteredRoyalVipPlayerByUsername === 'function'
      ? await store.findRegisteredRoyalVipPlayerByUsername(username, {
        coadminUid: info.appbeg_coadmin_uid || settings?.appbeg_coadmin_uid || null
      })
      : null;
    if (!recipient || Number(recipient.id) === Number(contact.id)) {
      return {
        kind: 'deposit_other_not_found',
        replies: [{
          text: [
            'That player is not a registered Royal VIP player.',
            'You can only load another player who already registered through Royal VIP.'
          ].join('\n'),
          buttons: depositTargetButtons()
        }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_choose_target',
          registrationInfo: info
        },
        escalate: false
      };
    }
    const recipientUsername = recipient.royal_vip_username || username;
    return {
      kind: 'deposit_confirm_other',
      replies: [{
        text: [
          'You are loading:',
          recipientUsername
        ].join('\n'),
        buttons: [
          [{ label: '✅ CONTINUE', action: 'deposit:continue_other', text: 'CONTINUE', data: 'deposit:continue_other' }],
          [{ label: '❌ CANCEL', action: 'deposit:cancel', text: 'CANCEL', data: 'deposit:cancel' }]
        ]
      }],
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_confirm_other',
        registrationInfo: {
          ...info,
          deposit_pending_recipient_contact_id: recipient.id,
          deposit_pending_recipient_username: recipientUsername,
          deposit_pending_recipient_player_uid: recipient.registration_info?.appbeg_player_uid || recipient.appbeg_account_id
        }
      },
      escalate: false
    };
  }

  if (normalizedStep === 'deposit_choose_target' || normalizedStep === 'deposit_payment_name' || normalizedStep === 'deposit_amount') {
    return startRegisteredDeposit(contact, info);
  }

  if (normalizedStep === 'deposit_await_payment') {
    const normalized = await normalizeRegisteredDepositAttempt(store, contact.id, info);
    if (!normalized.activeWindow) {
      return startRegisteredDeposit(contact, normalized.info);
    }
    return resumeActiveDepositDecision(normalized.activeWindow, normalized.info);
  }

  return beginRegisteredDeposit(store, contact, info);
}
