export const ROUTING_STATUS = {
  UNROUTED: 'unrouted',
  SEARCHING: 'searching',
  REGISTERED_PLAYER_DEPOSIT: 'registered_player_deposit',
  DEPOSIT_WINDOW_MATCHED: 'deposit_window_matched',
  REGISTRATION_PAYMENT_MATCHED: 'registration_payment_matched',
  MANUAL_REVIEW: 'manual_review',
  /** Frozen after search window expires with no active match. */
  FROZEN: 'frozen',
  /** @deprecated use MANUAL_REVIEW or FROZEN */
  UNTOUCHED_UNMATCHED: 'untouched_unmatched',
  APPBEG_OWNED: 'appbeg_owned',
  TELELEDGER_PENDING: 'teleledger_pending',
  NOT_OUR_APPBEG: 'not_our_appbeg',
  EXPIRED_DEPOSIT: 'expired_deposit',
  DUPLICATE_IGNORED: 'duplicate_ignored',
  IGNORED: 'ignored',
  PARSE_FAILED: 'parse_failed',
  ROUTE_FAILED: 'route_failed'
};

/** Staff-facing payment queue status (derived from routing_status). */
export const MATCHING_STATUS = {
  SEARCHING: 'searching',
  MATCHED: 'matched',
  COMPLETED: 'completed',
  FROZEN: 'frozen',
  MANUAL_REVIEW: 'manual_review'
};

/** Default queue sort: Waiting → Manual Review → Frozen → Matched → Completed. */
export const MATCHING_STATUS_SORT_PRIORITY = {
  [MATCHING_STATUS.SEARCHING]: 1,
  [MATCHING_STATUS.MANUAL_REVIEW]: 2,
  [MATCHING_STATUS.FROZEN]: 3,
  [MATCHING_STATUS.MATCHED]: 4,
  [MATCHING_STATUS.COMPLETED]: 5
};

export const ROUTING_REASON = {
  MATCHED_REGISTERED_PLAYER: 'Matched registered player',
  MATCHED_DEPOSIT_WINDOW: 'Matched active deposit payment window',
  MATCHED_REGISTRATION_WINDOW: 'Matched registration payment window',
  REGISTRATION_WINDOW_EXPIRED: 'Registration window expired',
  DEPOSIT_WINDOW_EXPIRED: 'Deposit window expired',
  UNABLE_TO_PARSE: 'Unable to parse payment',
  NO_ACTIVE_WINDOW: 'No active payment window',
  NO_ACTIVE_REGISTRATION_WINDOW: 'No active registration window',
  NO_REGISTERED_PLAYER_MATCH: 'No registered player match',
  AMBIGUOUS_MATCH: 'Multiple active payment windows matched',
  WAITING_MANUAL_REVIEW: 'Waiting for manual review'
};

export const UNMATCHED_REASON = {
  NO_ACTIVE_WINDOW: 'no_active_window',
  WINDOW_EXPIRED: 'window_expired',
  AMOUNT_MISMATCH: 'amount_mismatch',
  NAME_MISMATCH: 'name_mismatch',
  AMBIGUOUS_MATCH: 'ambiguous_match',
  UNSUPPORTED_PAYMENT_METHOD: 'unsupported_payment_method'
};

export const ROUTING_OWNER = {
  APPBEG: 'appbeg',
  TELELEDGER: 'teleledger'
};

export const HANDLED_BY_APPBEG_BOT = 'AppBegBot';

export const DEPOSIT_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

export const PAYMENT_WINDOW_FLOW = {
  REGISTRATION: 'registration',
  DEPOSIT: 'deposit'
};

/** Canonical window duration for registration and registered deposits. */
export const PAYMENT_WINDOW_MINUTES = 7;

/** How long an unmatched payment keeps searching for an active window before freeze. */
export const PAYMENT_SEARCH_MINUTES = 5;

export const PAYMENT_WINDOW_STATUS = {
  ACTIVE: 'active',
  /** Stored historically as `completed`; hydrate maps both. */
  MATCHED: 'matched',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  MANUAL_REVIEW: 'manual_review'
};

export function buildIdempotencyKey(telegramGroupId, telegramMessageId) {
  return `${telegramGroupId}:${telegramMessageId}`;
}

export function paymentWindowMinutes() {
  return Math.max(Number(process.env.PAYMENT_WINDOW_MINUTES || PAYMENT_WINDOW_MINUTES), 1);
}

export function paymentSearchMinutes() {
  return Math.max(Number(process.env.PAYMENT_SEARCH_MINUTES || PAYMENT_SEARCH_MINUTES), 1);
}

/** @deprecated Use paymentWindowMinutes — all live payment windows are 7 minutes. */
export function depositWindowMinutes() {
  return paymentWindowMinutes();
}

export function computePaymentFreezeAt(fromDate = new Date(), searchMinutes = paymentSearchMinutes()) {
  const start = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  return new Date(base.getTime() + searchMinutes * 60 * 1000).toISOString();
}

export function paymentFlowType(payment = {}) {
  if (payment.flow_type === PAYMENT_WINDOW_FLOW.DEPOSIT || payment.flow_type === PAYMENT_WINDOW_FLOW.REGISTRATION) {
    return payment.flow_type;
  }
  if (payment.window_flow_type === PAYMENT_WINDOW_FLOW.DEPOSIT || payment.window_flow_type === PAYMENT_WINDOW_FLOW.REGISTRATION) {
    return payment.window_flow_type;
  }
  const routing = payment.routing_status;
  if (routing === ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED || routing === ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT) {
    return PAYMENT_WINDOW_FLOW.DEPOSIT;
  }
  if (routing === ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED || routing === ROUTING_STATUS.APPBEG_OWNED) {
    return PAYMENT_WINDOW_FLOW.REGISTRATION;
  }
  return null;
}

export function remainingSecondsUntil(freezeAt, now = new Date()) {
  if (!freezeAt) return null;
  const end = new Date(freezeAt).getTime();
  if (!Number.isFinite(end)) return null;
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Math.max(0, Math.floor((end - base) / 1000));
}

/**
 * Derive staff-facing matching_status from internal routing fields.
 * Possible values: searching | matched | completed | frozen | manual_review
 */
export function deriveMatchingStatus(payment = {}, now = new Date()) {
  const routing = payment.routing_status;
  const unmatched = payment.unmatched_reason || payment.unmatchedReason || null;
  const processing = String(payment.processing_status || '').toLowerCase();

  if (processing === 'completed') return MATCHING_STATUS.COMPLETED;

  if (routing === ROUTING_STATUS.SEARCHING || routing === ROUTING_STATUS.UNROUTED) {
    const remaining = remainingSecondsUntil(payment.freeze_at, now);
    if (remaining === 0) return MATCHING_STATUS.FROZEN;
    return MATCHING_STATUS.SEARCHING;
  }

  if (routing === ROUTING_STATUS.FROZEN) return MATCHING_STATUS.FROZEN;

  if (routing === ROUTING_STATUS.MANUAL_REVIEW || routing === ROUTING_STATUS.UNTOUCHED_UNMATCHED) {
    if (unmatched === UNMATCHED_REASON.AMBIGUOUS_MATCH) return MATCHING_STATUS.MANUAL_REVIEW;
    if (
      unmatched === UNMATCHED_REASON.NO_ACTIVE_WINDOW
      || unmatched === UNMATCHED_REASON.WINDOW_EXPIRED
      || unmatched === UNMATCHED_REASON.AMOUNT_MISMATCH
      || unmatched === UNMATCHED_REASON.NAME_MISMATCH
    ) {
      return MATCHING_STATUS.FROZEN;
    }
    // Legacy frozen/manual_review without reason → treat as frozen (search timed out).
    if (!unmatched) return MATCHING_STATUS.FROZEN;
    return MATCHING_STATUS.MANUAL_REVIEW;
  }

  if (
    routing === ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT
    || routing === ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED
    || routing === ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED
    || routing === ROUTING_STATUS.APPBEG_OWNED
  ) {
    return MATCHING_STATUS.MATCHED;
  }

  if (
    routing === ROUTING_STATUS.PARSE_FAILED
    || routing === ROUTING_STATUS.ROUTE_FAILED
    || routing === ROUTING_STATUS.EXPIRED_DEPOSIT
    || routing === ROUTING_STATUS.IGNORED
    || routing === ROUTING_STATUS.DUPLICATE_IGNORED
  ) {
    return MATCHING_STATUS.MANUAL_REVIEW;
  }

  return MATCHING_STATUS.MANUAL_REVIEW;
}

export function enrichPaymentQueueFields(payment = {}, now = new Date()) {
  const matching_status = deriveMatchingStatus(payment, now);
  const remaining_seconds = matching_status === MATCHING_STATUS.SEARCHING
    ? remainingSecondsUntil(payment.freeze_at, now)
    : null;
  const matched_window_id = payment.matched_window_id
    ?? payment.registration_payment_window_id
    ?? null;
  const matched_at = payment.matched_at
    || (
      matching_status === MATCHING_STATUS.MATCHED || matching_status === MATCHING_STATUS.COMPLETED
        ? (payment.routed_at || null)
        : null
    );
  return {
    ...payment,
    matching_status,
    remaining_seconds,
    freeze_at: payment.freeze_at || null,
    frozen_at: payment.frozen_at || null,
    unmatched_reason: payment.unmatched_reason || null,
    matched_window_id: matched_window_id != null ? Number(matched_window_id) : null,
    matched_at,
    flow_type: paymentFlowType(payment),
    server_now: now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  };
}

export function matchingStatusLabel(matchingStatus) {
  switch (matchingStatus) {
    case MATCHING_STATUS.SEARCHING: return 'Waiting';
    case MATCHING_STATUS.MATCHED: return 'Matched';
    case MATCHING_STATUS.COMPLETED: return 'Completed';
    case MATCHING_STATUS.FROZEN: return 'Frozen';
    case MATCHING_STATUS.MANUAL_REVIEW: return 'Manual Review';
    default: return matchingStatus || 'Waiting';
  }
}

export function matchingStatusEmoji(matchingStatus) {
  switch (matchingStatus) {
    case MATCHING_STATUS.SEARCHING: return '🟡';
    case MATCHING_STATUS.MATCHED: return '🟢';
    case MATCHING_STATUS.COMPLETED: return '🔵';
    case MATCHING_STATUS.FROZEN: return '🔴';
    case MATCHING_STATUS.MANUAL_REVIEW: return '🟠';
    default: return '🟡';
  }
}

/** Map staff filter / matching_status → SQL routing_status sets. */
export function routingStatusesForMatchingFilter(matchingStatus) {
  switch (matchingStatus) {
    case MATCHING_STATUS.SEARCHING:
      return [ROUTING_STATUS.SEARCHING, ROUTING_STATUS.UNROUTED];
    case MATCHING_STATUS.MATCHED:
      return [
        ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
        ROUTING_STATUS.APPBEG_OWNED,
        ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
        ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT
      ];
    case MATCHING_STATUS.COMPLETED:
      return [
        ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
        ROUTING_STATUS.APPBEG_OWNED,
        ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
        ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT
      ];
    case MATCHING_STATUS.FROZEN:
      return [ROUTING_STATUS.FROZEN, ROUTING_STATUS.MANUAL_REVIEW, ROUTING_STATUS.UNTOUCHED_UNMATCHED];
    case MATCHING_STATUS.MANUAL_REVIEW:
      return [
        ROUTING_STATUS.MANUAL_REVIEW,
        ROUTING_STATUS.UNTOUCHED_UNMATCHED,
        ROUTING_STATUS.PARSE_FAILED,
        ROUTING_STATUS.ROUTE_FAILED,
        ROUTING_STATUS.EXPIRED_DEPOSIT,
        ROUTING_STATUS.IGNORED
      ];
    default:
      return null;
  }
}

export function paymentRoutingLabel(routingStatus) {
  switch (routingStatus) {
    case ROUTING_STATUS.SEARCHING:
      return 'Waiting';
    case ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT:
    case ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED:
      return 'Matched';
    case ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED:
    case ROUTING_STATUS.APPBEG_OWNED:
      return 'Matched';
    case ROUTING_STATUS.FROZEN:
      return 'Frozen';
    case ROUTING_STATUS.MANUAL_REVIEW:
      return 'Manual Review';
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return 'Frozen';
    case ROUTING_STATUS.EXPIRED_DEPOSIT:
      return 'Manual Review';
    case ROUTING_STATUS.PARSE_FAILED:
      return 'Manual Review';
    case ROUTING_STATUS.IGNORED:
      return 'Manual Review';
    case ROUTING_STATUS.DUPLICATE_IGNORED:
      return 'Manual Review';
    case ROUTING_STATUS.UNROUTED:
      return 'Waiting';
    default:
      return matchingStatusLabel(deriveMatchingStatus({ routing_status: routingStatus }));
  }
}

export function paymentRoutingReason(payment = {}) {
  if (payment.routing_reason) return payment.routing_reason;
  switch (payment.routing_status) {
    case ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT:
      return ROUTING_REASON.MATCHED_REGISTERED_PLAYER;
    case ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED:
      return ROUTING_REASON.MATCHED_DEPOSIT_WINDOW;
    case ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED:
    case ROUTING_STATUS.APPBEG_OWNED:
      return ROUTING_REASON.MATCHED_REGISTRATION_WINDOW;
    case ROUTING_STATUS.EXPIRED_DEPOSIT:
      return ROUTING_REASON.REGISTRATION_WINDOW_EXPIRED;
    case ROUTING_STATUS.PARSE_FAILED:
      return ROUTING_REASON.UNABLE_TO_PARSE;
    case ROUTING_STATUS.FROZEN:
      return ROUTING_REASON.NO_ACTIVE_WINDOW;
    case ROUTING_STATUS.MANUAL_REVIEW:
      return ROUTING_REASON.WAITING_MANUAL_REVIEW;
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return ROUTING_REASON.NO_ACTIVE_WINDOW;
    case ROUTING_STATUS.SEARCHING:
    case ROUTING_STATUS.UNROUTED:
      return ROUTING_REASON.NO_ACTIVE_WINDOW;
    default:
      return payment.parse_error ? ROUTING_REASON.UNABLE_TO_PARSE : '—';
  }
}

export function paymentProcessingLabel(payment = {}) {
  return deriveMatchingStatus(payment);
}

export function normalizePaymentWindowStatus(status) {
  if (status === 'completed') return PAYMENT_WINDOW_STATUS.MATCHED;
  return status || null;
}

export function isMatchedPaymentWindowStatus(status) {
  return status === 'matched' || status === 'completed';
}
