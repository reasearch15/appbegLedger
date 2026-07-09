export const ROUTING_STATUS = {
  UNROUTED: 'unrouted',
  REGISTERED_PLAYER_DEPOSIT: 'registered_player_deposit',
  REGISTRATION_PAYMENT_MATCHED: 'registration_payment_matched',
  UNTOUCHED_UNMATCHED: 'untouched_unmatched',
  /** @deprecated legacy alias */
  APPBEG_OWNED: 'appbeg_owned',
  TELELEDGER_PENDING: 'teleledger_pending',
  NOT_OUR_APPBEG: 'not_our_appbeg',
  EXPIRED_DEPOSIT: 'expired_deposit',
  DUPLICATE_IGNORED: 'duplicate_ignored',
  IGNORED: 'ignored',
  PARSE_FAILED: 'parse_failed',
  ROUTE_FAILED: 'route_failed'
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
    case ROUTING_STATUS.UNTOUCHED_UNMATCHED:
      return 'Frozen / Manual Review';
    case ROUTING_STATUS.EXPIRED_DEPOSIT:
      return 'Expired Window Match';
    case ROUTING_STATUS.PARSE_FAILED:
      return 'Parse Failed';
    case ROUTING_STATUS.IGNORED:
      return 'Ignored';
    case ROUTING_STATUS.DUPLICATE_IGNORED:
      return 'Duplicate Skipped';
    default:
      return routingStatus || 'Pending';
  }
}

export function paymentProcessingLabel(payment = {}) {
  const routing = payment.routing_status;
  if (routing === 'registered_player_deposit') return 'pending_review';
  if (routing === 'untouched_unmatched') return 'frozen';
  if (routing === 'registration_payment_matched' || routing === 'appbeg_owned') {
    return 'matched';
  }
  if (routing === 'parse_failed') return 'parse_failed';
  if (routing === 'expired_deposit') return 'expired_window';
  return String(payment.processing_status || 'new').toLowerCase();
}
