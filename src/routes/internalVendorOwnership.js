import { requireVendorInternalAuth } from '../middleware/vendorInternalAuth.js';

const MAX_VENDOR_OWNERSHIP_UIDS = 500;
const MAX_VENDOR_OWNERSHIP_UID_LENGTH = 128;

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
    vendorId: Number.isFinite(Number(row.vendor_id)) ? Number(row.vendor_id) : null,
    vendorName: safeText(row.vendor_name) || '',
    vendorCode: safeText(row.vendor_code) || '',
    vendorStatus: safeText(row.vendor_status) || 'active',
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
