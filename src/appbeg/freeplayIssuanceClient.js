/**
 * AppBeg Freeplay issuance boundary.
 *
 * Re-investigated locally: Ledger has deposit credit (`/api/internal/ledger/credit-deposit`),
 * player create, and cashout clients. Freeplay appears only as a player-side
 * `authority_freeplay_claim` financial-cache event, not an admin issuance API.
 *
 * Do not invent an HTTP contract. Staff may APPROVE a request locally.
 * `decision = given` is allowed only after a proven AppBeg issuance succeeds.
 *
 * The idempotency key is stable per support_requests.id so RETRY cannot mint
 * a second financial identity for the same Freeplay request.
 */

export const FREEPLAY_ISSUANCE_BLOCKER = 'no_proven_appbeg_freeplay_endpoint';

export const FREEPLAY_DECISION = {
  APPROVED: 'approved',
  GIVEN: 'given',
  DECLINED: 'declined'
};

export const FREEPLAY_ISSUANCE_STATUS = {
  PENDING: 'pending',
  ISSUING: 'issuing',
  ISSUED: 'issued',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable'
};

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
