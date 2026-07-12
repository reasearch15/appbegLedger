/**
 * Registered-user deposit wizard.
 * Deposit → payment name (if needed) → amount → QR → 7-minute deposit window.
 */

import {
  MIN_REGISTRATION_DEPOSIT,
  parseFirstDepositAmount
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

export async function startRegisteredDeposit(contact, info = {}) {
  const knownName = info.payment_display_name || info.payment_name || null;
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
          ...info,
          deposit_in_progress: true,
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
        ...info,
        deposit_in_progress: true
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
        registrationInfo: {
          ...info,
          deposit_in_progress: false,
          deposit_awaiting_payment: false,
          deposit_requested_amount: undefined,
          deposit_payment_window_id: undefined
        }
      },
      escalate: false
    };
  }

  if (action === 'deposit:retry_qr') {
    const amount = info.deposit_requested_amount ?? info.first_deposit_amount;
    const name = info.payment_display_name || info.payment_name;
    if (amount == null || !name) {
      return startRegisteredDeposit(contact, info);
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
          deposit_requested_amount: amount
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
          ...info,
          payment_name: name,
          payment_display_name: name,
          deposit_in_progress: true
        }
      },
      escalate: false
    };
  }

  if (normalizedStep === 'deposit_amount') {
    const amount = parseFirstDepositAmount(text);
    if (amount == null) {
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
            ...info,
            deposit_requested_amount: amount
          }
        },
        escalate: false,
        logEvent: { event: 'registration_qr_missing', amount, flowType: PAYMENT_WINDOW_FLOW.DEPOSIT }
      };
    }

    const paymentDisplayName = info.payment_display_name || info.payment_name;
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
          ...info,
          payment_method_id: qrSource.paymentMethodId,
          payment_method_name: qrSource.paymentMethodName,
          deposit_requested_amount: amount,
          deposit_in_progress: true
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
    return {
      kind: 'deposit_waiting_payment',
      replies: [{
        text: [
          'We are waiting to verify your deposit payment.',
          `Amount: $${formatDepositAmount(info.deposit_requested_amount ?? info.first_deposit_amount)}`,
          'You have 7 minutes from when the QR was sent.',
          'We will confirm automatically once payment is verified.'
        ].join('\n'),
        buttons: depositCancelButtons()
      }],
      statePatch: null,
      escalate: false
    };
  }

  return startRegisteredDeposit(contact, info);
}
