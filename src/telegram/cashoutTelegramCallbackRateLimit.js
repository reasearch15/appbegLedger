/**
 * Lightweight in-memory rate limit for Telegram cash-out callbacks.
 * Canonical AppBeg idempotency remains the financial safety net.
 */

const buckets = new Map();

export function resetCashoutTelegramCallbackRateLimitsForTests() {
  buckets.clear();
}

/**
 * @returns {{ allowed: boolean, retryAfterMs?: number }}
 */
export function consumeCashoutTelegramCallbackRateLimit({
  key,
  limit = 20,
  windowMs = 60_000,
  nowMs = Date.now()
} = {}) {
  const id = String(key || '').trim();
  if (!id) return { allowed: true };

  const bucket = buckets.get(id) || { count: 0, windowStartMs: nowMs };
  if (nowMs - bucket.windowStartMs >= windowMs) {
    bucket.count = 0;
    bucket.windowStartMs = nowMs;
  }
  bucket.count += 1;
  buckets.set(id, bucket);

  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, windowMs - (nowMs - bucket.windowStartMs))
    };
  }
  return { allowed: true };
}
