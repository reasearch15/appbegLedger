import { amountsMatch, normalizePaymentName, paymentAppsMatch, paymentNameMatchMethod, paymentNamesMatch } from './matchUtils.js';
import { PAYMENT_WINDOW_FLOW, UNMATCHED_REASON } from './constants.js';

const ELIGIBLE_FLOW_TYPES = new Set([
  PAYMENT_WINDOW_FLOW.REGISTRATION,
  PAYMENT_WINDOW_FLOW.DEPOSIT
]);

/**
 * A window may auto-claim a payment only when all of these are true.
 */
export function isEligibleActivePaymentWindow(window, { now = new Date() } = {}) {
  if (!window) return false;
  if (String(window.status || '').toLowerCase() !== 'active') return false;
  if (window.status_raw && String(window.status_raw).toLowerCase() !== 'active') return false;

  const flowType = window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION;
  if (!ELIGIBLE_FLOW_TYPES.has(flowType)) return false;

  if (window.matched_payment_event_id != null && window.matched_payment_event_id !== '') {
    return false;
  }

  const expiresAt = new Date(window.expires_at).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return false;
  if (!(expiresAt > nowMs)) return false;

  return true;
}

/**
 * Shared match rule for registration and registered-deposit windows.
 * Name + amount required; payment method/app matched when both sides have a value.
 * Callers must pass only eligible active windows (or use findMatchingActivePaymentWindow).
 */
export function windowMatchesParsed(window, parsed, { requireMethod = false } = {}) {
  if (!paymentNameMatchMethod(window.payment_display_name, parsed.payment_sender_name)) return false;
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

export function windowMatchDetails(window, parsed, { requireMethod = false } = {}) {
  const nameMethod = paymentNameMatchMethod(window.payment_display_name, parsed.payment_sender_name);
  if (!nameMethod) return null;
  if (!amountsMatch(window.first_deposit_amount, parsed.amount)) return null;

  const expectedApp = window.payment_method_key || window.payment_method_name || window.expected_payment_app;
  const parsedApp = parsed.payment_app;
  if (expectedApp && parsedApp) {
    if (!paymentAppsMatch(expectedApp, parsedApp)) return null;
  } else if (requireMethod && expectedApp && !parsedApp) {
    return null;
  }

  return {
    window,
    method: nameMethod,
    normalizedExpectedName: normalizePaymentName(window.payment_display_name),
    normalizedParsedName: normalizePaymentName(parsed.payment_sender_name)
  };
}

/**
 * Filters to eligible active windows, then matches by name + amount.
 * @returns {{ result: 'exact_match'|'no_match'|'ambiguous_match', window?: object, windows?: object[], eligibleWindows?: object[] }}
 */
export function findMatchingActivePaymentWindow(windows = [], parsed, { now = new Date() } = {}) {
  const eligibleWindows = (windows || []).filter((window) => isEligibleActivePaymentWindow(window, { now }));
  const matchDetails = eligibleWindows
    .map((window) => windowMatchDetails(window, parsed))
    .filter(Boolean);
  const exactMatches = matchDetails.filter((match) => match.method === 'exact_name');
  if (exactMatches.length === 1) {
    return { result: 'exact_match', window: exactMatches[0].window, windows: exactMatches.map((match) => match.window), eligibleWindows, matchMethod: 'exact_name', match: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return { result: 'ambiguous_match', window: null, windows: exactMatches.map((match) => match.window), eligibleWindows, matchMethod: 'ambiguous', unmatchedReason: UNMATCHED_REASON.AMBIGUOUS_MATCH };
  }

  const initialMatches = matchDetails.filter((match) => match.method === 'surname_initial');
  if (initialMatches.length === 1) {
    return { result: 'exact_match', window: initialMatches[0].window, windows: initialMatches.map((match) => match.window), eligibleWindows, matchMethod: 'surname_initial', match: initialMatches[0] };
  }
  if (initialMatches.length > 1) {
    return {
      result: 'ambiguous_match',
      window: null,
      windows: initialMatches.map((match) => match.window),
      eligibleWindows,
      matchMethod: 'ambiguous',
      unmatchedReason: UNMATCHED_REASON.AMBIGUOUS_ABBREVIATED_NAME
    };
  }
  return { result: 'no_match', window: null, windows: [], eligibleWindows, matchMethod: 'no_match' };
}

export function classifyUnmatchedReason({
  activeWindows = [],
  parsed = null
} = {}) {
  if (!parsed) return UNMATCHED_REASON.NO_ACTIVE_WINDOW;

  const eligible = (activeWindows || []).filter((window) => isEligibleActivePaymentWindow(window));
  const nameHits = eligible.filter((window) => (
    paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)
  ));
  const amountHits = eligible.filter((window) => (
    amountsMatch(window.first_deposit_amount, parsed.amount)
  ));

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
