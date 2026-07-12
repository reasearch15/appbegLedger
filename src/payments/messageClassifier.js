/**
 * Classify Telegram payment-group messages before routing / review.
 * Goal: keep noise out of Manual Review and Payments.
 */

import { isChimePaymentMessage } from './parser.js';

export const MANUAL_REVIEW_REASON = {
  MULTIPLE_ACTIVE_MATCHING_WINDOWS: 'multiple_active_matching_windows',
  /** Alias stored historically as ambiguous_match */
  AMBIGUOUS_MATCH: 'ambiguous_match',
  MALFORMED_PAYMENT_MESSAGE: 'malformed_payment_message',
  UNSUPPORTED_PAYMENT_FORMAT: 'unsupported_payment_format',
  MISSING_AMOUNT: 'missing_amount',
  MISSING_PAYMENT_NAME: 'missing_payment_name',
  NON_PAYMENT_MESSAGE: 'non_payment_message',
  CASHOUT_MESSAGE: 'cashout_message',
  DUPLICATE_PAYMENT: 'duplicate_payment',
  PARSER_EXCEPTION: 'parser_exception',
  INVALID_PAYMENT_APP: 'invalid_payment_app',
  STAFF_REVIEW_REQUESTED: 'staff_review_requested'
};

export const MANUAL_REVIEW_REASON_LABELS = {
  [MANUAL_REVIEW_REASON.MULTIPLE_ACTIVE_MATCHING_WINDOWS]: 'Multiple active matching windows',
  [MANUAL_REVIEW_REASON.AMBIGUOUS_MATCH]: 'Multiple active matching windows',
  [MANUAL_REVIEW_REASON.MALFORMED_PAYMENT_MESSAGE]: 'Malformed payment message',
  [MANUAL_REVIEW_REASON.UNSUPPORTED_PAYMENT_FORMAT]: 'Unsupported payment format',
  [MANUAL_REVIEW_REASON.MISSING_AMOUNT]: 'Missing amount',
  [MANUAL_REVIEW_REASON.MISSING_PAYMENT_NAME]: 'Missing payment name',
  [MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE]: 'Non-payment Telegram message',
  [MANUAL_REVIEW_REASON.CASHOUT_MESSAGE]: 'Cashout message detected',
  [MANUAL_REVIEW_REASON.DUPLICATE_PAYMENT]: 'Duplicate payment',
  [MANUAL_REVIEW_REASON.PARSER_EXCEPTION]: 'Parser exception',
  [MANUAL_REVIEW_REASON.INVALID_PAYMENT_APP]: 'Invalid payment app',
  [MANUAL_REVIEW_REASON.STAFF_REVIEW_REQUESTED]: 'Staff review requested',
  no_active_window: 'No active matching window',
  window_expired: 'Payment window expired',
  amount_mismatch: 'Amount mismatch',
  name_mismatch: 'Name mismatch',
  unsupported_payment_method: 'Unsupported payment method'
};

export function manualReviewReasonLabel(reason) {
  if (!reason) return 'Needs staff review';
  const key = String(reason).trim();
  return MANUAL_REVIEW_REASON_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const CASHOUT_PATTERNS = [
  /^\/OUT\b/i,
  /^\/out\b/i,
  /\bcash\s*out\b/i,
  /\bwithdraw(?:al)?\s+(?:request|please|now)\b/i,
  /\brequest(?:ing)?\s+(?:a\s+)?cash\s*out\b/i,
  /\bpayout\s+request\b/i
];

const PAYMENT_LIKE_PATTERNS = [
  /you\s+received\s+\$/i,
  /\$\d+(?:\.\d+)?\s+from\s+/i,
  /\breceived\s+\$\d+/i,
  /\bpayment\s+(?:of|received)\b/i
];

/**
 * @returns {{ kind: 'payment'|'payment_like'|'cashout'|'non_payment', reason: string|null }}
 */
export function classifyPaymentGroupMessage(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) {
    return { kind: 'non_payment', reason: MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE };
  }

  if (CASHOUT_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'cashout', reason: MANUAL_REVIEW_REASON.CASHOUT_MESSAGE };
  }

  if (isChimePaymentMessage(text)) {
    return { kind: 'payment', reason: null };
  }

  if (PAYMENT_LIKE_PATTERNS.some((re) => re.test(text))) {
    if (!/\$\d/.test(text) && !/received\s+\$/i.test(text)) {
      return { kind: 'payment_like', reason: MANUAL_REVIEW_REASON.MISSING_AMOUNT };
    }
    if (/you\s+received/i.test(text) && !/\bfrom\s+\S+/i.test(text)) {
      return { kind: 'payment_like', reason: MANUAL_REVIEW_REASON.MISSING_PAYMENT_NAME };
    }
    return { kind: 'payment_like', reason: MANUAL_REVIEW_REASON.MALFORMED_PAYMENT_MESSAGE };
  }

  // Short chatter, punctuation-only, slash commands (non-cashout), unrelated text
  if (
    text.length <= 4
    || /^[!?.…]+$/u.test(text)
    || /^\/\w+/.test(text)
    || /^(this one too\.?|ok|okay|thanks|thank you|yes|no|hi|hello)$/i.test(text)
  ) {
    return { kind: 'non_payment', reason: MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE };
  }

  return { kind: 'non_payment', reason: MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE };
}

export function shouldEnterManualReview(classification) {
  return classification.kind === 'payment_like';
}

export function shouldAutoIgnore(classification) {
  return classification.kind === 'non_payment' || classification.kind === 'cashout';
}

/** Normalize historical ambiguous_match → display/filter bucket. */
export function normalizeManualReviewReason(reason, routingStatus = null) {
  const raw = String(reason || '').trim();
  if (raw === 'ambiguous_match' || raw === MANUAL_REVIEW_REASON.MULTIPLE_ACTIVE_MATCHING_WINDOWS) {
    return MANUAL_REVIEW_REASON.AMBIGUOUS_MATCH;
  }
  if (raw) return raw;
  if (routingStatus === 'parse_failed') return MANUAL_REVIEW_REASON.MALFORMED_PAYMENT_MESSAGE;
  if (routingStatus === 'route_failed') return MANUAL_REVIEW_REASON.PARSER_EXCEPTION;
  if (routingStatus === 'expired_deposit') return 'window_expired';
  return MANUAL_REVIEW_REASON.STAFF_REVIEW_REQUESTED;
}

export function manualReviewFilterBucket(reason, routingStatus = null) {
  const normalized = normalizeManualReviewReason(reason, routingStatus);
  if (normalized === MANUAL_REVIEW_REASON.AMBIGUOUS_MATCH
    || normalized === MANUAL_REVIEW_REASON.MULTIPLE_ACTIVE_MATCHING_WINDOWS) {
    return 'ambiguous';
  }
  if ([
    MANUAL_REVIEW_REASON.MALFORMED_PAYMENT_MESSAGE,
    MANUAL_REVIEW_REASON.UNSUPPORTED_PAYMENT_FORMAT,
    MANUAL_REVIEW_REASON.PARSER_EXCEPTION,
    MANUAL_REVIEW_REASON.INVALID_PAYMENT_APP
  ].includes(normalized) || routingStatus === 'parse_failed' || routingStatus === 'route_failed') {
    return 'parse_failure';
  }
  if ([
    MANUAL_REVIEW_REASON.MISSING_AMOUNT,
    MANUAL_REVIEW_REASON.MISSING_PAYMENT_NAME
  ].includes(normalized)) {
    return 'missing_data';
  }
  if (normalized === MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE) return 'non_payment';
  if (normalized === MANUAL_REVIEW_REASON.CASHOUT_MESSAGE) return 'cashout';
  return 'other';
}
