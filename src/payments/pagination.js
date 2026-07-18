export const PAYMENT_PAGE_SIZE = 15;

export function parsePaymentPageLimit(value, { defaultLimit = PAYMENT_PAGE_SIZE, maxLimit = PAYMENT_PAGE_SIZE } = {}) {
  if (value == null || value === '') {
    return { ok: true, limit: defaultLimit };
  }
  const limit = Number(value);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    return { ok: false, error: `limit must be between 1 and ${maxLimit}.` };
  }
  return { ok: true, limit };
}
