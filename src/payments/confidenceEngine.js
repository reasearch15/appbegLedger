import { normalizePaymentName, paymentNameMatchMethod } from './matchUtils.js';

export const CONFIDENCE = {
  UNKNOWN: 'UNKNOWN',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
  VERY_HIGH_CONFIDENCE: 'VERY_HIGH_CONFIDENCE',
  AMBIGUOUS: 'AMBIGUOUS'
};

export const EVIDENCE = {
  FIRST_SEEN_NAME: 'first_seen_name',
  CONFIRMED_PAYER_HISTORY: 'confirmed_payer_history',
  MULTIPLE_CONFIRMED_PAYERS: 'multiple_confirmed_payers',
  PREVIOUS_REJECTION: 'previous_rejection',
  EXACT_NAME_HISTORY: 'exact_name_history',
  SURNAME_INITIAL_ONLY: 'surname_initial_only',
  NO_ACTIVE_WINDOW: 'no_active_window',
  RECIPIENT_CONFLICT: 'recipient_conflict',
  MODE_OFF: 'mode_off',
  LEGACY_UNTRUSTED: 'legacy_untrusted'
};

export const CONFIRMED_EVIDENCE_KINDS = new Set([
  'staff_confirmed',
  'system_confirmed'
]);

export const LEGACY_EVIDENCE_KIND = 'legacy_assumed_payer_eq_recipient';
export const REJECTED_EVIDENCE_KIND = 'rejected';

export function paymentIdentityKey(displayName = '') {
  return normalizePaymentName(displayName);
}

export function uniqueContactIds(rows = []) {
  const ids = new Set();
  for (const row of rows || []) {
    const id = Number(row.contact_id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * Explainable confidence. Never uses an opaque score as the financial decision.
 * Legacy matches assumed payer = recipient and cannot produce VERY_HIGH.
 */
export function evaluatePaymentConfidence({
  displayName = '',
  evidenceRows = [],
  activeWindowsForPayer = [],
  allActiveWindows = [],
  confidenceModeOn = false,
  frozen = false,
  ignored = false,
  alreadyAssigned = false,
  alreadyCredited = false
} = {}) {
  const reasons = [];
  const nameMethod = paymentNameMatchMethod(displayName, displayName) || 'exact_name';
  const confirmed = uniqueContactIds(
    (evidenceRows || []).filter((row) => CONFIRMED_EVIDENCE_KINDS.has(row.evidence_kind))
  );
  const rejected = uniqueContactIds(
    (evidenceRows || []).filter((row) => row.evidence_kind === REJECTED_EVIDENCE_KIND)
  );
  const legacy = uniqueContactIds(
    (evidenceRows || []).filter((row) => row.evidence_kind === LEGACY_EVIDENCE_KIND)
  );
  const payerWindows = (activeWindowsForPayer || []).filter(Boolean);
  const allWindows = (allActiveWindows || []).filter(Boolean);

  if (!confidenceModeOn) reasons.push(EVIDENCE.MODE_OFF);
  if (nameMethod === 'surname_initial') reasons.push(EVIDENCE.SURNAME_INITIAL_ONLY);
  if (rejected.length) reasons.push(EVIDENCE.PREVIOUS_REJECTION);
  if (confirmed.length > 1) reasons.push(EVIDENCE.MULTIPLE_CONFIRMED_PAYERS);
  if (confirmed.length === 1) {
    reasons.push(EVIDENCE.CONFIRMED_PAYER_HISTORY);
    reasons.push(EVIDENCE.EXACT_NAME_HISTORY);
  }
  if (!confirmed.length && legacy.length) reasons.push(EVIDENCE.LEGACY_UNTRUSTED);
  if (!confirmed.length && !legacy.length) reasons.push(EVIDENCE.FIRST_SEEN_NAME);
  if (!payerWindows.length) reasons.push(EVIDENCE.NO_ACTIVE_WINDOW);
  if (payerWindows.length > 1 || (confirmed.length > 1 && allWindows.length > 1)) {
    reasons.push(EVIDENCE.RECIPIENT_CONFLICT);
  }

  let classification = CONFIDENCE.UNKNOWN;
  if (confirmed.length > 1 || payerWindows.length > 1) {
    classification = CONFIDENCE.AMBIGUOUS;
  } else if (rejected.length || nameMethod === 'surname_initial') {
    classification = CONFIDENCE.LOW_CONFIDENCE;
  } else if (!confirmed.length) {
    classification = legacy.length ? CONFIDENCE.LOW_CONFIDENCE : CONFIDENCE.UNKNOWN;
  } else if (confirmed.length === 1 && payerWindows.length === 1 && nameMethod === 'exact_name') {
    classification = CONFIDENCE.VERY_HIGH_CONFIDENCE;
  } else if (confirmed.length === 1) {
    classification = CONFIDENCE.HIGH_CONFIDENCE;
  }

  const uniqueReasons = [...new Set(reasons)];
  const autoCreditEligible = Boolean(
    confidenceModeOn
    && classification === CONFIDENCE.VERY_HIGH_CONFIDENCE
    && payerWindows.length === 1
    && confirmed.length === 1
    && !rejected.length
    && nameMethod === 'exact_name'
    && !frozen
    && !ignored
    && !alreadyAssigned
    && !alreadyCredited
    && !uniqueReasons.includes(EVIDENCE.NO_ACTIVE_WINDOW)
    && !uniqueReasons.includes(EVIDENCE.MULTIPLE_CONFIRMED_PAYERS)
    && !uniqueReasons.includes(EVIDENCE.PREVIOUS_REJECTION)
    && !uniqueReasons.includes(EVIDENCE.LEGACY_UNTRUSTED)
    && !uniqueReasons.includes(EVIDENCE.SURNAME_INITIAL_ONLY)
    && !uniqueReasons.includes(EVIDENCE.MODE_OFF)
  );

  return {
    classification,
    reasons: uniqueReasons,
    confirmedPayerIds: confirmed,
    rejectedPayerIds: rejected,
    legacyPayerIds: legacy,
    nameMethod,
    autoCreditEligible,
    candidateWindow: payerWindows.length === 1 ? payerWindows[0] : null
  };
}

export function staffReviewReasonLines(evaluation = {}) {
  const map = {
    [EVIDENCE.FIRST_SEEN_NAME]: 'First payment from this name',
    [EVIDENCE.CONFIRMED_PAYER_HISTORY]: 'Trusted payer history exists',
    [EVIDENCE.MULTIPLE_CONFIRMED_PAYERS]: 'Multiple confirmed payers share this name',
    [EVIDENCE.PREVIOUS_REJECTION]: 'Previous rejection for this identity',
    [EVIDENCE.EXACT_NAME_HISTORY]: 'Exact name history',
    [EVIDENCE.SURNAME_INITIAL_ONLY]: 'Name is surname/initial only',
    [EVIDENCE.NO_ACTIVE_WINDOW]: 'No active deposit window',
    [EVIDENCE.RECIPIENT_CONFLICT]: 'Recipient conflict / multiple windows',
    [EVIDENCE.MODE_OFF]: 'Confidence Mode is OFF',
    [EVIDENCE.LEGACY_UNTRUSTED]: 'Legacy history assumed payer = recipient'
  };
  return (evaluation.reasons || []).map((code) => map[code] || code);
}
