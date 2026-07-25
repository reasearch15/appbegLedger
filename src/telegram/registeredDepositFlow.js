/**
 * Registered-user deposit wizard.
 * Deposit → payment name (if needed) → amount → QR → 7-minute deposit window.
 */

import {
  centsToDollars,
  MIN_REGISTRATION_DEPOSIT,
  parseMoneyToCents
} from '../registration/utils.js';
import { formatDepositAmount } from '../payments/methodUtils.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { resolveRegistrationDefaultQr } from './royalVipBotRegistration.js';
import { registeredMenuButtons } from './botRegistrationState.js';

export const REGISTERED_DEPOSIT_FLOW = 'registered_deposit';

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
    [{ label: '❌ Cancel Deposit', action: 'deposit:cancel', text: 'Cancel Deposit', data: 'deposit:cancel' }]
  ];
}

export function isRegisteredDepositFlow(flow, step) {
  if (flow === REGISTERED_DEPOSIT_FLOW) return true;
  return [
    'deposit_payment_name',
    'deposit_amount',
    'deposit_await_payment'
  ].includes(String(step || ''));
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
  const amount = activeWindow.first_deposit_amount ?? info.deposit_requested_amount;
  return {
    kind: 'deposit_waiting_payment',
    replies: [{
      text: [
        'We are waiting to verify your deposit payment.',
        `Amount: $${formatDepositAmount(amount)}`,
        'You have 7 minutes from when the QR was sent.',
        'We will confirm automatically once payment is verified.'
      ].join('\n'),
      buttons: depositCancelButtons()
    }],
    statePatch: {
      currentFlow: REGISTERED_DEPOSIT_FLOW,
      currentStep: 'deposit_await_payment',
      registrationInfo: {
        ...info,
        deposit_in_progress: true,
        deposit_awaiting_payment: true,
        deposit_requested_amount: amount,
        deposit_payment_window_id: activeWindow.id,
        payment_window_id: activeWindow.id,
        payment_window_expires_at: activeWindow.expires_at,
        payment_display_name: activeWindow.payment_display_name || info.payment_display_name || info.payment_name,
        payment_name: activeWindow.payment_display_name || info.payment_name || info.payment_display_name
      }
    },
    escalate: false,
    logEvent: { event: 'deposit_active_window_resumed', windowId: activeWindow.id }
  };
}

/**
 * Start or restart a registered deposit after normalizing any expired attempt.
 * Persists a fresh amount-entry session (caller must apply statePatch before/with the prompt).
 */
export async function beginRegisteredDeposit(store, contact, info = {}) {
  const normalized = await normalizeRegisteredDepositAttempt(store, contact.id, info);
  if (normalized.activeWindow) {
    return resumeActiveDepositDecision(normalized.activeWindow, normalized.info);
  }
  return startRegisteredDeposit(contact, normalized.info);
}

export async function startRegisteredDeposit(contact, info = {}) {
  const cleaned = clearStaleDepositSessionFields(info);
  const knownName = String(cleaned.payment_display_name || cleaned.payment_name || '').trim();
  if (knownName) {
    return {
      kind: 'deposit_ask_amount',
      replies: [{
        text: [
          `Deposit for payment name: ${knownName}`,
          '',
          DEPOSIT_AMOUNT_PROMPT
        ].join('\n'),
        buttons: depositCancelButtons()
      }],
      sendPaymentQr: null,
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_amount',
        registrationInfo: {
          ...cleaned,
          deposit_in_progress: true,
          deposit_awaiting_payment: false,
          payment_display_name: knownName,
          payment_name: knownName
        }
      },
      escalate: false,
      logEvent: { event: 'deposit_flow_started', step: 'deposit_amount' }
    };
  }

  return {
    kind: 'deposit_ask_payment_name',
    replies: [{ text: DEPOSIT_NAME_PROMPT, buttons: depositCancelButtons() }],
    statePatch: {
      currentFlow: REGISTERED_DEPOSIT_FLOW,
      currentStep: 'deposit_payment_name',
      registrationInfo: {
        ...cleaned,
        deposit_in_progress: true,
        deposit_awaiting_payment: false
      }
    },
    escalate: false,
    logEvent: { event: 'deposit_flow_started', step: 'deposit_payment_name' }
  };
}

export async function continueRegisteredDeposit({
  store,
  contact,
  text,
  action,
  step,
  info
}) {
  const normalizedStep = String(step || 'deposit_payment_name');

  if (action === 'deposit:cancel' || action === 'bot:stop') {
    if (info.deposit_payment_window_id && store.expireRegistrationPaymentWindow) {
      await store.expireRegistrationPaymentWindow(info.deposit_payment_window_id, { suppressNotification: true }).catch(() => null);
    }
    return {
      kind: 'deposit_cancelled',
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
      escalate: false
    };
  }

  if (action === 'bot:deposit') {
    return beginRegisteredDeposit(store, contact, info);
  }

  if (action === 'deposit:retry_qr') {
    const amount = info.deposit_requested_amount ?? info.first_deposit_amount;
    const name = info.payment_display_name || info.payment_name;
    if (amount == null || !name) {
      return beginRegisteredDeposit(store, contact, info);
    }
    const qrSource = await resolveRegistrationDefaultQr(store);
    if (!qrSource) {
      return {
        kind: 'deposit_qr_unavailable',
        replies: [{
          text: 'We could not load the payment QR right now. Please try again or contact support.',
          buttons: [
            [{ label: '🔄 Try Again', action: 'deposit:retry_qr', text: 'Try Again', data: 'deposit:retry_qr' }],
            ...registeredMenuButtons()
          ]
        }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_amount',
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
        paymentDisplayName: name,
        firstDepositAmount: amount,
        flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
      },
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_amount',
        registrationInfo: {
          ...info,
          payment_method_id: qrSource.paymentMethodId,
          deposit_requested_amount: amount,
          deposit_in_progress: true
        }
      },
      escalate: false
    };
  }

  if (normalizedStep === 'deposit_payment_name') {
    const name = String(text || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80) {
      return {
        kind: 'deposit_ask_payment_name',
        replies: [{
          text: 'Please enter a valid payment name.\n\n' + DEPOSIT_NAME_PROMPT,
          buttons: depositCancelButtons()
        }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_payment_name',
          registrationInfo: info
        },
        escalate: false
      };
    }
    return {
      kind: 'deposit_ask_amount',
      replies: [{
        text: [
          `Thank you, ${name}.`,
          '',
          DEPOSIT_AMOUNT_PROMPT
        ].join('\n'),
        buttons: depositCancelButtons()
      }],
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_amount',
        registrationInfo: {
          ...clearStaleDepositSessionFields(info),
          payment_name: name,
          payment_display_name: name,
          deposit_in_progress: true,
          deposit_awaiting_payment: false
        }
      },
      escalate: false
    };
  }

  if (normalizedStep === 'deposit_amount') {
    const amountCents = parseMoneyToCents(text);
    const minCents = MIN_REGISTRATION_DEPOSIT * 100;
    if (!Number.isSafeInteger(amountCents) || amountCents < minCents) {
      return {
        kind: 'deposit_ask_amount',
        replies: [{
          text: [
            `Please enter a valid deposit amount of at least $${MIN_REGISTRATION_DEPOSIT}.`,
            '',
            'Numbers only. Example: 10'
          ].join('\n'),
          buttons: depositCancelButtons()
        }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_amount',
          registrationInfo: info
        },
        escalate: false
      };
    }
    const amount = centsToDollars(amountCents);

    // Normalize again so an expired attempt cannot be reused at QR time.
    const normalized = await normalizeRegisteredDepositAttempt(store, contact.id, info);
    if (normalized.activeWindow) {
      const activeCents = parseMoneyToCents(String(normalized.activeWindow.first_deposit_amount));
      if (activeCents === amountCents) {
        return resumeActiveDepositDecision(normalized.activeWindow, {
          ...normalized.info,
          deposit_requested_amount: amount
        });
      }
      if (store.expireRegistrationPaymentWindow) {
        await store.expireRegistrationPaymentWindow(normalized.activeWindow.id, {
          suppressNotification: true
        }).catch(() => null);
      }
    }

    const qrSource = await resolveRegistrationDefaultQr(store);
    if (!qrSource) {
      return {
        kind: 'deposit_qr_unavailable',
        replies: [{
          text: 'We could not load the payment QR right now. Please try again or contact support.',
          buttons: [
            [{ label: '🔄 Try Again', action: 'deposit:retry_qr', text: 'Try Again', data: 'deposit:retry_qr' }],
            ...registeredMenuButtons()
          ]
        }],
        statePatch: {
          currentFlow: REGISTERED_DEPOSIT_FLOW,
          currentStep: 'deposit_amount',
          registrationInfo: {
            ...normalized.info,
            deposit_requested_amount: amount,
            deposit_in_progress: true
          }
        },
        escalate: false,
        logEvent: { event: 'registration_qr_missing', amount, flowType: PAYMENT_WINDOW_FLOW.DEPOSIT }
      };
    }

    const paymentDisplayName = normalized.info.payment_display_name || normalized.info.payment_name;
    return {
      kind: 'registration_send_payment_qr',
      replies: [],
      sendPaymentQr: {
        paymentMethodId: qrSource.paymentMethodId,
        paymentMethodName: qrSource.paymentMethodName,
        paymentDisplayName,
        firstDepositAmount: amount,
        flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
      },
      statePatch: {
        currentFlow: REGISTERED_DEPOSIT_FLOW,
        currentStep: 'deposit_amount',
        registrationInfo: {
          ...normalized.info,
          payment_method_id: qrSource.paymentMethodId,
          payment_method_name: qrSource.paymentMethodName,
          deposit_requested_amount: amount,
          deposit_in_progress: true,
          deposit_awaiting_payment: false
        }
      },
      escalate: false,
      logEvent: {
        event: 'registration_amount_accepted',
        amount,
        paymentMethodId: qrSource.paymentMethodId,
        flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
      }
    };
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
