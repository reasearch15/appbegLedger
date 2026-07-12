export const ROUTING_STATUS = {
  UNROUTED: 'unrouted',
  REGISTERED_PLAYER_DEPOSIT: 'registered_player_deposit',
  DEPOSIT_WINDOW_MATCHED: 'deposit_window_matched',
  REGISTRATION_PAYMENT_MATCHED: 'registration_payment_matched',
  MANUAL_REVIEW: 'manual_review',
  /** @deprecated use MANUAL_REVIEW */
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

/** @deprecated Use paymentWindowMinutes — all live payment windows are 7 minutes. */
export function depositWindowMinutes() {
  return paymentWindowMinutes();
}

export function paymentRoutingLabel(routingStatus) {
  switch (routingStatus) {
    case ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT:
    case ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED:
      return 'Registered Deposit Matched';
    case ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED:
    case ROUTING_STATUS.APPBEG_OWNED:
      return 'Registration Matched';
    case ROUTING_STATUS.MANUAL_REVIEW:
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return 'Frozen / Manual Review';
    case ROUTING_STATUS.EXPIRED_DEPOSIT:
      return 'Expired Payment Window';
    case ROUTING_STATUS.PARSE_FAILED:
      return 'Parse Failed';
    case ROUTING_STATUS.IGNORED:
      return 'Ignored';
    case ROUTING_STATUS.DUPLICATE_IGNORED:
      return 'Duplicate Skipped';
    case ROUTING_STATUS.UNROUTED:
      return 'Pending Routing';
    default:
      return routingStatus || 'Pending';
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
    case ROUTING_STATUS.MANUAL_REVIEW:
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return ROUTING_REASON.WAITING_MANUAL_REVIEW;
    default:
      return payment.parse_error ? ROUTING_REASON.UNABLE_TO_PARSE : '—';
  }
}

export function paymentProcessingLabel(payment = {}) {
  const routing = payment.routing_status;
  if (
    routing === ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT
    || routing === ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED
  ) {
    return 'matched';
  }
  if (routing === ROUTING_STATUS.MANUAL_REVIEW || routing === ROUTING_STATUS.UNTOUCHED_UNMATCHED) return 'frozen';
  if (routing === ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED || routing === ROUTING_STATUS.APPBEG_OWNED) {
    return 'matched';
  }
  if (routing === ROUTING_STATUS.PARSE_FAILED) return 'parse_failed';
  if (routing === ROUTING_STATUS.EXPIRED_DEPOSIT) return 'expired_window';
  return String(payment.processing_status || 'new').toLowerCase();
}

export function normalizePaymentWindowStatus(status) {
  if (status === 'completed') return PAYMENT_WINDOW_STATUS.MATCHED;
  return status || null;
}

export function isMatchedPaymentWindowStatus(status) {
  return status === 'matched' || status === 'completed';
}
