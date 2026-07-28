import crypto from 'node:crypto';

export function configuredInternalKey() {
  return String(
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY
      || process.env.APPBEG_LEDGER_INTERNAL_API_KEY
      || ''
  ).trim();
}

export function providedInternalKey(req) {
  const auth = String(req.get?.('Authorization') || '').trim();
  const match = auth.match(/^Bearer ([^\s]+)$/);
  return match ? match[1] : '';
}

function timingSafeEqualText(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireVendorInternalAuth(req, res, next) {
  const expected = configuredInternalKey();
  if (!expected) {
    console.error('[internal-vendor-auth] internal API key is not configured');
    return res.status(503).json({ configured: false });
  }
  if (!timingSafeEqualText(expected, providedInternalKey(req))) {
    console.warn('[internal-vendor-auth] rejected unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}
