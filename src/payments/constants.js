export const ROUTING_STATUS = {
  UNROUTED: 'unrouted',
  APPBEG_OWNED: 'appbeg_owned',
  TELELEDGER_PENDING: 'teleledger_pending',
  NOT_OUR_APPBEG: 'not_our_appbeg',
  EXPIRED_DEPOSIT: 'expired_deposit',
  DUPLICATE_IGNORED: 'duplicate_ignored',
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
