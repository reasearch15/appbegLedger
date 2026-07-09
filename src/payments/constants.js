export const ROUTING_STATUS = {
  UNROUTED: 'unrouted',
  REGISTERED_PLAYER_DEPOSIT: 'registered_player_deposit',
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
  MATCHED_REGISTRATION_WINDOW: 'Matched registration payment window',
  REGISTRATION_WINDOW_EXPIRED: 'Registration window expired',
  UNABLE_TO_PARSE: 'Unable to parse payment',
  NO_ACTIVE_REGISTRATION_WINDOW: 'No active registration window',
  NO_REGISTERED_PLAYER_MATCH: 'No registered player match',
  WAITING_MANUAL_REVIEW: 'Waiting for manual review'
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

export function buildIdempotencyKey(telegramGroupId, telegramMessageId) {
  return `${telegramGroupId}:${telegramMessageId}`;
}

export function depositWindowMinutes() {
  return Math.max(Number(process.env.DEPOSIT_WINDOW_MINUTES || 30), 1);
}

export function paymentRoutingLabel(routingStatus) {
  switch (routingStatus) {
    case ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT:
      return 'Registered Player Deposit';
    case ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED:
    case ROUTING_STATUS.APPBEG_OWNED:
      return 'Registration Matched';
    case ROUTING_STATUS.MANUAL_REVIEW:
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return 'Frozen / Manual Review';
    case ROUTING_STATUS.EXPIRED_DEPOSIT:
      return 'Expired Registration Window';
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
  if (routing === ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT) return 'pending_review';
  if (routing === ROUTING_STATUS.MANUAL_REVIEW || routing === ROUTING_STATUS.UNTOUCHED_UNMATCHED) return 'frozen';
  if (routing === ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED || routing === ROUTING_STATUS.APPBEG_OWNED) {
    return 'matched';
  }
  if (routing === ROUTING_STATUS.PARSE_FAILED) return 'parse_failed';
  if (routing === ROUTING_STATUS.EXPIRED_DEPOSIT) return 'expired_window';
  return String(payment.processing_status || 'new').toLowerCase();
}
