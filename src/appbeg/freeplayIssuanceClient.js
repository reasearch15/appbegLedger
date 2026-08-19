/**
 * AppBeg Freeplay issuance boundary.
 *
 * Ledger has no client that actually issues Freeplay. AppBeg financial cache
 * only mentions `authority_freeplay_claim` as a player-side claim event, not
 * an admin issuance API.
 *
 * Do not invent an HTTP contract. Staff Give/Decline is implemented locally;
 * issuance remains blocked until a proven AppBeg endpoint exists.
 */

export const FREEPLAY_ISSUANCE_BLOCKER = 'no_proven_appbeg_freeplay_endpoint';

export function buildFreeplayIdempotencyKey(requestId) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid Freeplay request id is required for issuance idempotency.');
  }
  return `appbegledger-freeplay-request:${id}`;
}

export async function issueAppBegFreeplay() {
  const error = new Error(
    'AppBeg Freeplay issuance is not available: no proven Ledger client or internal API contract exists in this repository.'
  );
  error.code = FREEPLAY_ISSUANCE_BLOCKER;
  error.retryable = false;
  throw error;
}
