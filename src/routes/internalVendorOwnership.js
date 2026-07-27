import crypto from 'node:crypto';

const MAX_VENDOR_OWNERSHIP_UIDS = 500;
const MAX_VENDOR_OWNERSHIP_UID_LENGTH = 128;

function configuredInternalKey() {
  return String(
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY
      || process.env.APPBEG_LEDGER_INTERNAL_API_KEY
      || ''
  ).trim();
}

function providedInternalKey(req) {
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

function requireVendorInternalAuth(req, res, next) {
  const expected = configuredInternalKey();
  if (!expected) {
    console.error('[internal-vendor-ownership] internal API key is not configured');
    return res.status(503).json({ configured: false });
  }
  if (!timingSafeEqualText(expected, providedInternalKey(req))) {
    console.warn('[internal-vendor-ownership] rejected unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function normalizeRequestedPlayerUids(req) {
  if (!req.body || !Array.isArray(req.body.playerUids)) {
    return { ok: false, status: 400, error: 'playerUids must be an array.' };
  }
  if (req.body.playerUids.length > MAX_VENDOR_OWNERSHIP_UIDS) {
    return {
      ok: false,
      status: 413,
      error: `playerUids may include at most ${MAX_VENDOR_OWNERSHIP_UIDS} values.`
    };
  }
  const uids = [];
  for (const value of req.body.playerUids) {
    if (typeof value !== 'string') {
      return { ok: false, status: 400, error: 'playerUids must contain only strings.' };
    }
    const uid = value.trim();
    if (!uid) continue;
    if (uid.length > MAX_VENDOR_OWNERSHIP_UID_LENGTH) {
      return {
        ok: false,
        status: 400,
        error: `playerUids values may be at most ${MAX_VENDOR_OWNERSHIP_UID_LENGTH} characters.`
      };
    }
    uids.push(uid);
  }
  return { ok: true, playerUids: [...new Set(uids)] };
}

function safeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function safeDateText(value) {
  const text = safeText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function vendorOwnershipPayload(row) {
  if (!row) return { owned: false };
  return {
    owned: true,
    vendorName: safeText(row.vendor_name) || '',
    vendorCode: safeText(row.vendor_code) || '',
    vendorStatus: safeText(row.vendor_status) || 'active',
    linkedStaffUid: safeText(row.linked_staff_uid),
    ownershipDate: safeDateText(row.ownership_date || row.linked_at)
  };
}

export function registerInternalVendorOwnershipRoutes(app, { store }) {
  async function handleVendorOwnership(req, res) {
    const validation = normalizeRequestedPlayerUids(req);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const { playerUids } = validation;
    if (!playerUids.length) {
      return res.json({ configured: true, players: {} });
    }

    if (typeof store.listVendorOwnershipByPlayerUids !== 'function') {
      return res.json({ configured: false });
    }

    try {
      const rows = await store.listVendorOwnershipByPlayerUids(playerUids);
      const rowsByUid = new Map(rows.map((row) => [String(row.appbeg_player_uid || '').trim(), row]));
      const players = {};
      for (const uid of playerUids) {
        players[uid] = vendorOwnershipPayload(rowsByUid.get(uid));
      }
      return res.json({ configured: true, players });
    } catch (error) {
      console.error('[internal-vendor-ownership] ownership lookup failed');
      return res.json({ configured: false });
    }
  }

  app.post('/api/internal/vendor-ownership', requireVendorInternalAuth, handleVendorOwnership);
}
