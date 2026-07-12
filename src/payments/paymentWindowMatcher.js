import { amountsMatch, paymentAppsMatch, paymentNamesMatch } from './matchUtils.js';
import { PAYMENT_WINDOW_FLOW, UNMATCHED_REASON } from './constants.js';

/**
 * Shared match rule for registration and registered-deposit windows.
 * Name + amount required; payment method/app matched when both sides have a value.
 */
export function windowMatchesParsed(window, parsed, { requireMethod = false } = {}) {
  if (!paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)) return false;
  if (!amountsMatch(window.first_deposit_amount, parsed.amount)) return false;

  const expectedApp = window.payment_method_key || window.payment_method_name || window.expected_payment_app;
  const parsedApp = parsed.payment_app;
  if (expectedApp && parsedApp) {
    if (!paymentAppsMatch(expectedApp, parsedApp)) return false;
  } else if (requireMethod && expectedApp && !parsedApp) {
    return false;
  }
  return true;
}

/**
 * @returns {{ result: 'exact_match'|'no_match'|'ambiguous_match', window?: object, windows?: object[] }}
 */
export function findMatchingActivePaymentWindow(windows = [], parsed) {
  const matches = (windows || []).filter((window) => windowMatchesParsed(window, parsed));
  if (matches.length === 1) {
    return { result: 'exact_match', window: matches[0], windows: matches };
  }
  if (matches.length > 1) {
    return { result: 'ambiguous_match', window: null, windows: matches };
  }
  return { result: 'no_match', window: null, windows: [] };
}

export function classifyUnmatchedReason({
  activeWindows = [],
  expiredWindows = [],
  parsed = null
} = {}) {
  if (!parsed) return UNMATCHED_REASON.NO_ACTIVE_WINDOW;

  const nameHits = [...activeWindows, ...expiredWindows].filter((window) => (
    paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)
  ));
  const amountHits = [...activeWindows, ...expiredWindows].filter((window) => (
    amountsMatch(window.first_deposit_amount, parsed.amount)
  ));

  if (expiredWindows.some((window) => windowMatchesParsed(window, parsed))) {
    return UNMATCHED_REASON.WINDOW_EXPIRED;
  }
  if (nameHits.length && !amountHits.length) return UNMATCHED_REASON.AMOUNT_MISMATCH;
  if (amountHits.length && !nameHits.length) return UNMATCHED_REASON.NAME_MISMATCH;
  return UNMATCHED_REASON.NO_ACTIVE_WINDOW;
}

export function isRegistrationWindow(window) {
  return !window?.flow_type || window.flow_type === PAYMENT_WINDOW_FLOW.REGISTRATION;
}

export function isDepositWindow(window) {
  return window?.flow_type === PAYMENT_WINDOW_FLOW.DEPOSIT;
}
