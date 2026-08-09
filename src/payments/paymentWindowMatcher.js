import { amountCents, normalizePaymentName, paymentAppsMatch, paymentNameMatchMethod, paymentNamesMatch } from './matchUtils.js';
import { PAYMENT_WINDOW_FLOW, UNMATCHED_REASON } from './constants.js';
import { formatExactPaymentAmount } from './methodUtils.js';

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

export function windowExpectedAmountCents(window) {
  if (!window) return null;
  if (window.expected_payment_cents != null && window.expected_payment_cents !== '') {
    const expectedCents = Number(window.expected_payment_cents);
    if (Number.isSafeInteger(expectedCents)) return expectedCents;
  }
  return amountCents(window.first_deposit_amount);
}

function windowAmountMatchesParsed(window, parsed) {
  const expectedCents = windowExpectedAmountCents(window);
  if (expectedCents == null) return false;
  return expectedCents === amountCents(parsed.amount);
}

function formatMoneyFromCents(cents) {
  if (!Number.isSafeInteger(cents)) return null;
  return formatExactPaymentAmount(cents / 100);
}

function pickClosestAmountWindow(windows, parsed) {
  const receivedCents = amountCents(parsed?.amount);
  if (!Number.isSafeInteger(receivedCents) || !windows?.length) return windows?.[0] || null;
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    const expectedCents = windowExpectedAmountCents(window);
    if (!Number.isSafeInteger(expectedCents)) continue;
    const delta = Math.abs(expectedCents - receivedCents);
    if (delta < bestDelta) {
      best = window;
      bestDelta = delta;
    }
  }
  return best || windows[0];
}

/**
 * Staff-facing unmatched detail for amount mismatches.
 * Example:
 *   Amount mismatch
 *   Received: $5.00
 *   Expected: $5.50
 */
export function formatAmountMismatchDetail(parsed, window) {
  const received = formatExactPaymentAmount(parsed?.amount)
    || formatMoneyFromCents(amountCents(parsed?.amount))
    || '-';
  const expectedCents = windowExpectedAmountCents(window);
  const expected = formatMoneyFromCents(expectedCents)
    || formatExactPaymentAmount(window?.first_deposit_amount)
    || '-';
  return [
    'Amount mismatch',
    `Received: ${received}`,
    `Expected: ${expected}`
  ].join('\n');
}

export function formatNameMismatchDetail(parsed, window) {
  return [
    'Payment name mismatch',
    `Received: ${parsed?.payment_sender_name || '-'}`,
    `Expected: ${window?.payment_display_name || '-'}`
  ].join('\n');
}

/**
 * Shared match rule for registration and registered-deposit windows.
 * Name + amount required; payment method/app matched when both sides have a value.
 * Callers must pass only eligible active windows (or use findMatchingActivePaymentWindow).
 */
export function windowMatchesParsed(window, parsed, { requireMethod = false } = {}) {
  if (!paymentNameMatchMethod(window.payment_display_name, parsed.payment_sender_name)) return false;
  if (!windowAmountMatchesParsed(window, parsed)) return false;

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
  if (!windowAmountMatchesParsed(window, parsed)) return null;

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

/**
 * Classify why a payment did not auto-match.
 * Returns a structured result so staff UI can show received vs expected amounts.
 */
export function classifyUnmatchedPayment({
  activeWindows = [],
  parsed = null,
  now = new Date()
} = {}) {
  const empty = {
    reason: UNMATCHED_REASON.NO_ACTIVE_WINDOW,
    detail: null,
    candidateWindow: null,
    receivedAmount: parsed?.amount ?? null,
    expectedAmount: null
  };
  if (!parsed) return empty;

  const eligible = (activeWindows || []).filter((window) => isEligibleActivePaymentWindow(window, { now }));
  if (!eligible.length) {
    const expiredNameHits = (activeWindows || []).filter((window) => {
      const expiresAt = new Date(window?.expires_at).getTime();
      const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
      const expired = Number.isFinite(expiresAt) && Number.isFinite(nowMs) && expiresAt <= nowMs;
      const unmatched = window?.matched_payment_event_id == null || window.matched_payment_event_id === '';
      const flowType = window?.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION;
      return expired
        && unmatched
        && ELIGIBLE_FLOW_TYPES.has(flowType)
        && paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name);
    });
    if (expiredNameHits.length) {
      const candidate = pickClosestAmountWindow(expiredNameHits, parsed);
      return {
        reason: UNMATCHED_REASON.WINDOW_EXPIRED,
        detail: [
          'Payment window expired',
          `Received: ${formatExactPaymentAmount(parsed.amount) || '-'}`,
          `Expected: ${formatMoneyFromCents(windowExpectedAmountCents(candidate)) || formatExactPaymentAmount(candidate?.first_deposit_amount) || '-'}`
        ].join('\n'),
        candidateWindow: candidate,
        receivedAmount: parsed.amount ?? null,
        expectedAmount: candidate?.first_deposit_amount ?? null
      };
    }
    return empty;
  }

  const nameHits = eligible.filter((window) => (
    paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)
  ));
  const amountHits = eligible.filter((window) => windowAmountMatchesParsed(window, parsed));
  const nameHitsWithAmount = nameHits.filter((window) => windowAmountMatchesParsed(window, parsed));
  const amountHitsWithName = amountHits.filter((window) => (
    paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)
  ));

  // Name matched an active window, but none of those windows have the exact amount.
  if (nameHits.length && !nameHitsWithAmount.length) {
    const candidate = pickClosestAmountWindow(nameHits, parsed);
    const expectedCents = windowExpectedAmountCents(candidate);
    return {
      reason: UNMATCHED_REASON.AMOUNT_MISMATCH,
      detail: formatAmountMismatchDetail(parsed, candidate),
      candidateWindow: candidate,
      receivedAmount: parsed.amount ?? null,
      expectedAmount: Number.isSafeInteger(expectedCents) ? expectedCents / 100 : (candidate?.first_deposit_amount ?? null)
    };
  }

  // Amount matched an active window, but payment name did not.
  if (amountHits.length && !amountHitsWithName.length) {
    const candidate = amountHits[0];
    return {
      reason: UNMATCHED_REASON.NAME_MISMATCH,
      detail: formatNameMismatchDetail(parsed, candidate),
      candidateWindow: candidate,
      receivedAmount: parsed.amount ?? null,
      expectedAmount: candidate?.first_deposit_amount ?? null
    };
  }

  // Single active window with a different amount (even if name also differs).
  if (eligible.length === 1 && !windowAmountMatchesParsed(eligible[0], parsed)) {
    const candidate = eligible[0];
    const expectedCents = windowExpectedAmountCents(candidate);
    return {
      reason: UNMATCHED_REASON.AMOUNT_MISMATCH,
      detail: formatAmountMismatchDetail(parsed, candidate),
      candidateWindow: candidate,
      receivedAmount: parsed.amount ?? null,
      expectedAmount: Number.isSafeInteger(expectedCents) ? expectedCents / 100 : (candidate?.first_deposit_amount ?? null)
    };
  }

  // Active windows exist but nothing is a clear full match — prefer amount diagnostics when amounts differ.
  if (eligible.length) {
    const candidate = pickClosestAmountWindow(eligible, parsed);
    const expectedCents = windowExpectedAmountCents(candidate);
    if (candidate && !windowAmountMatchesParsed(candidate, parsed)) {
      return {
        reason: UNMATCHED_REASON.AMOUNT_MISMATCH,
        detail: formatAmountMismatchDetail(parsed, candidate),
        candidateWindow: candidate,
        receivedAmount: parsed.amount ?? null,
        expectedAmount: Number.isSafeInteger(expectedCents) ? expectedCents / 100 : (candidate?.first_deposit_amount ?? null)
      };
    }
  }

  return empty;
}

/** Back-compat wrapper: returns reason code string only. */
export function classifyUnmatchedReason(args = {}) {
  return classifyUnmatchedPayment(args).reason;
}

export function isRegistrationWindow(window) {
  return !window?.flow_type || window.flow_type === PAYMENT_WINDOW_FLOW.REGISTRATION;
}

export function isDepositWindow(window) {
  return window?.flow_type === PAYMENT_WINDOW_FLOW.DEPOSIT;
}
