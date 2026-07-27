function zeroFinancial() {
  return {
    total_in: 0,
    total_out: 0,
    net: 0,
    last_activity: null,
    active_today: false,
    financial_available: true,
    financial_unavailable_reason: null
  };
}

function roundCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100) / 100;
}

function normalizeFinancial(financial = {}) {
  const available = financial.financial_available ?? financial.financialAvailable ?? true;
  if (available === false) {
    return {
      total_in: null,
      total_out: null,
      net: null,
      last_activity: null,
      active_today: false,
      financial_available: false,
      financial_unavailable_reason: financial.financial_unavailable_reason || financial.financialUnavailableReason || 'Financial reporting is unavailable.'
    };
  }
  const totalIn = Number(financial.total_in ?? financial.totalIn ?? 0);
  const totalOut = Number(financial.total_out ?? financial.totalOut ?? 0);
  return {
    total_in: Number.isFinite(totalIn) ? totalIn : 0,
    total_out: Number.isFinite(totalOut) ? totalOut : 0,
    net: Number.isFinite(totalIn - totalOut) ? totalIn - totalOut : 0,
    last_activity: financial.last_activity ?? financial.lastActivity ?? null,
    active_today: financial.active_today === true || financial.activeToday === true || financial.active_today === 1 || financial.activeToday === 1,
    financial_available: true,
    financial_unavailable_reason: null
  };
}

function publicFinancial(financial = {}) {
  const normalized = normalizeFinancial(financial);
  const commissionPercentage = Number(financial.commission_percentage ?? financial.commissionPercentage ?? 0);
  const settlementAvailable = (financial.settlement_available ?? financial.settlementAvailable ?? true) !== false;
  const settlementTotal = settlementAvailable ? Number(financial.settlement_total ?? financial.settlementTotal ?? 0) : null;
  const lastSettlement = financial.last_settlement ?? financial.lastSettlement ?? null;
  const receivable = normalized.financial_available === false || normalized.net == null
    ? null
    : roundCurrency(normalized.net * ((Number.isFinite(commissionPercentage) ? commissionPercentage : 0) / 100));
  const outstanding = receivable == null || settlementAvailable === false
    ? null
    : roundCurrency(receivable - (Number.isFinite(settlementTotal) ? settlementTotal : 0));
  return {
    totalIn: normalized.total_in,
    total_in: normalized.total_in,
    totalOut: normalized.total_out,
    total_out: normalized.total_out,
    net: normalized.net,
    lastActivity: normalized.last_activity,
    last_activity: normalized.last_activity,
    activeToday: normalized.active_today,
    active_today: normalized.active_today,
    financialAvailable: normalized.financial_available,
    financial_available: normalized.financial_available,
    financialUnavailableReason: normalized.financial_unavailable_reason,
    financial_unavailable_reason: normalized.financial_unavailable_reason,
    settlementTotal,
    settlement_total: settlementTotal,
    settlementTotalCents: settlementAvailable ? Number(financial.settlement_total_cents || 0) : null,
    settlement_total_cents: settlementAvailable ? Number(financial.settlement_total_cents || 0) : null,
    lastSettlement,
    last_settlement: lastSettlement,
    receivable,
    outstanding
  };
}

function publicSettlementAvailability(vendor) {
  const available = vendor.settlement_available ?? vendor.settlementAvailable ?? true;
  return {
    settlementAvailable: available !== false,
    settlement_available: available !== false,
    settlementUnavailableReason: available === false
      ? (vendor.settlement_unavailable_reason || vendor.settlementUnavailableReason || 'Settlement reporting is unavailable.')
      : null,
    settlement_unavailable_reason: available === false
      ? (vendor.settlement_unavailable_reason || vendor.settlementUnavailableReason || 'Settlement reporting is unavailable.')
      : null
  };
}

function normalizeBotUsername(value) {
  const username = String(value || '').trim().replace(/^@+/, '').split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : '';
}

function botUsernameFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!/^(t\.me|telegram\.me)$/i.test(url.hostname)) return '';
    return normalizeBotUsername(url.pathname.replace(/^\/+/, '').split('/')[0]);
  } catch {
    return '';
  }
}

function configuredVendorBotUsername(env = process.env) {
  return normalizeBotUsername(env.VENDOR_TELEGRAM_BOT_USERNAME)
    || normalizeBotUsername(env.TELEGRAM_BOT_USERNAME)
    || botUsernameFromUrl(env.ROYAL_VIP_TELEGRAM_BOT_URL)
    || botUsernameFromUrl(env.TELEGRAM_BOT_URL)
    || normalizeBotUsername(globalThis.telegramBot?.botInfo?.username)
    || normalizeBotUsername(globalThis.telegramBot?.telegram?.botInfo?.username);
}

export function buildVendorBotLink(vendorCode, env = process.env) {
  const username = configuredVendorBotUsername(env);
  const code = String(vendorCode || '').trim();
  if (!username || !code) return null;
  return `https://t.me/${username}?start=${encodeURIComponent(code)}`;
}

function vendorPayload(vendor) {
  const financial = publicFinancial(vendor.financial || vendor);
  const settlementAvailability = publicSettlementAvailability(vendor);
  const financialAvailable = financial.financialAvailable !== false;
  const vendorBotLink = buildVendorBotLink(vendor.vendor_code);
  return {
    id: vendor.id,
    vendorCode: vendor.vendor_code,
    vendor_code: vendor.vendor_code,
    name: vendor.name,
    status: vendor.status,
    commissionPercentage: vendor.commission_percentage,
    commission_percentage: vendor.commission_percentage,
    notes: vendor.notes,
    vendorBotLink,
    vendor_bot_link: vendorBotLink,
    playerCount: vendor.player_count || 0,
    player_count: vendor.player_count || 0,
    activePlayersToday: financialAvailable ? (vendor.active_players_today ?? 0) : null,
    active_players_today: financialAvailable ? (vendor.active_players_today ?? 0) : null,
    hasSettlements: settlementAvailability.settlementAvailable ? vendor.has_settlements === true : null,
    has_settlements: settlementAvailability.settlementAvailable ? vendor.has_settlements === true : null,
    latestSettlementAmount: vendor.latest_settlement_amount ?? null,
    latest_settlement_amount: vendor.latest_settlement_amount ?? null,
    latestSettlementAmountCents: vendor.latest_settlement_amount_cents ?? null,
    latest_settlement_amount_cents: vendor.latest_settlement_amount_cents ?? null,
    latestSettlementDate: vendor.latest_settlement_date ?? null,
    latest_settlement_date: vendor.latest_settlement_date ?? null,
    ...settlementAvailability,
    ...financial,
    created_at: vendor.created_at,
    updated_at: vendor.updated_at
  };
}

function vendorPlayerPayload(player) {
  const financial = publicFinancial(player.financial || player);
  return {
    id: player.id,
    vendorId: player.vendor_id,
    vendor_id: player.vendor_id,
    telegramContactId: player.telegram_contact_id,
    telegram_contact_id: player.telegram_contact_id,
    telegramName: player.telegram_name,
    telegram_name: player.telegram_name,
    telegramUsername: player.telegram_username,
    telegram_username: player.telegram_username,
    appbegUsername: player.appbeg_username,
    appbeg_username: player.appbeg_username,
    appbegPlayerUid: player.appbeg_player_uid,
    appbeg_player_uid: player.appbeg_player_uid,
    ...financial,
    linked_at: player.linked_at,
    created_at: player.created_at,
    updated_at: player.updated_at
  };
}

function vendorSettlementPayload(settlement) {
  return {
    id: settlement.id,
    vendorId: settlement.vendor_id,
    vendor_id: settlement.vendor_id,
    settlementAmountCents: settlement.settlement_amount_cents,
    settlement_amount_cents: settlement.settlement_amount_cents,
    amount: settlement.settlement_amount,
    settlementAmount: settlement.settlement_amount,
    settlement_amount: settlement.settlement_amount,
    settlementDate: settlement.settlement_date,
    settlement_date: settlement.settlement_date,
    notes: settlement.notes,
    createdBy: settlement.created_by,
    created_by: settlement.created_by,
    created_at: settlement.created_at,
    updated_at: settlement.updated_at
  };
}

function handleVendorError(res, error) {
  if (error?.code === 'VALIDATION_ERROR') {
    return res.status(400).json({ error: error.message || 'Vendor request failed.' });
  }
  if (error?.code === 'VENDOR_HAS_PLAYERS') {
    return res.status(409).json({ error: error.message || 'This Vendor still owns players.' });
  }
  console.error('[vendors] request failed');
  return res.status(500).json({ error: 'Vendor request failed.' });
}

async function loadFinancialByUid(appbegStore, players) {
  const uids = [...new Set(players
    .map((player) => String(player.appbeg_player_uid || '').trim())
    .filter(Boolean))];
  if (!uids.length || typeof appbegStore?.getFinancialReportForPlayerUids !== 'function') {
    return {
      configured: !uids.length,
      players: new Map(),
      source: null,
      reason: !uids.length ? null : 'AppBeg financial reporting is not available.'
    };
  }
  try {
    const report = await appbegStore.getFinancialReportForPlayerUids(uids);
    return {
      configured: report.configured !== false,
      source: report.source || null,
      reason: report.reason || null,
      activeDay: report.activeDay || null,
      players: new Map((report.players || []).map((row) => [String(row.uid), normalizeFinancial(row)]))
    };
  } catch (error) {
    console.error('[vendors] financial reporting query failed');
    return {
      configured: false,
      source: null,
      reason: 'Financial reporting is temporarily unavailable.',
      players: new Map()
    };
  }
}

function financialForPlayer(player, financialByUid) {
  const uid = String(player.appbeg_player_uid || '').trim();
  if (financialByUid.configured === false) {
    return {
      ...zeroFinancial(),
      financial_available: false,
      financial_unavailable_reason: financialByUid.reason || 'Financial reporting is unavailable.'
    };
  }
  return uid && financialByUid.players.has(uid) ? financialByUid.players.get(uid) : zeroFinancial();
}

function summarizePlayersFinancial(players, financialByUid) {
  return players.reduce((summary, player) => {
    if (summary.financial_available === false) return summary;
    const financial = financialForPlayer(player, financialByUid);
    if (financial.financial_available === false) {
      summary.financial_available = false;
      summary.financial_unavailable_reason = financial.financial_unavailable_reason;
      summary.total_in = null;
      summary.total_out = null;
      summary.net = null;
      summary.last_activity = null;
      return summary;
    }
    summary.total_in += financial.total_in;
    summary.total_out += financial.total_out;
    if (financial.last_activity && (!summary.last_activity || new Date(financial.last_activity) > new Date(summary.last_activity))) {
      summary.last_activity = financial.last_activity;
    }
    if (financial.active_today) {
      summary.active_today = true;
    }
    return summary;
  }, zeroFinancial());
}

function summarizeSettlements(settlements = []) {
  return settlements.reduce((summary, settlement) => {
    const cents = Number(settlement.settlement_amount_cents || 0);
    if (Number.isSafeInteger(cents)) {
      summary.settlement_total_cents += cents;
      summary.settlement_total = summary.settlement_total_cents / 100;
    }
    if (!summary.last_settlement) {
      summary.last_settlement = settlement.settlement_date || null;
    }
    return summary;
  }, { settlement_total_cents: 0, settlement_total: 0, last_settlement: null });
}

function latestSettlement(settlements = []) {
  return settlements[0] || null;
}

function applyVendorSettlementSummary(vendor, settlements = []) {
  const summary = summarizeSettlements(settlements);
  const latest = latestSettlement(settlements);
  return {
    ...vendor,
    has_settlements: settlements.length > 0,
    latest_settlement_amount: latest?.settlement_amount ?? null,
    latest_settlement_amount_cents: latest?.settlement_amount_cents ?? null,
    latest_settlement_date: latest?.settlement_date ?? null,
    financial: {
      ...(vendor.financial || {}),
      commission_percentage: vendor.commission_percentage,
      settlement_total: summary.settlement_total,
      settlement_total_cents: summary.settlement_total_cents,
      last_settlement: summary.last_settlement
    }
  };
}

function applyVendorSettlementUnavailable(vendor, reason = 'Settlement reporting is unavailable.') {
  return {
    ...vendor,
    settlement_available: false,
    settlement_unavailable_reason: reason,
    has_settlements: null,
    latest_settlement_amount: null,
    latest_settlement_amount_cents: null,
    latest_settlement_date: null,
    financial: {
      ...(vendor.financial || {}),
      commission_percentage: vendor.commission_percentage,
      settlement_available: false,
      settlement_total: null,
      settlement_total_cents: null,
      last_settlement: null
    }
  };
}

function activePlayersToday(players = [], financialByUid) {
  if (financialByUid.configured === false) return null;
  return players.reduce((count, player) => (
    financialForPlayer(player, financialByUid).active_today ? count + 1 : count
  ), 0);
}

function playerGroups(players = []) {
  const byVendor = new Map();
  for (const player of players) {
    const vendorId = Number(player.vendor_id);
    if (!byVendor.has(vendorId)) byVendor.set(vendorId, []);
    byVendor.get(vendorId).push(player);
  }
  return byVendor;
}

function applyVendorSettlementSummaries(vendors = [], settlements = []) {
  const settlementsByVendor = new Map();
  for (const settlement of settlements) {
    const vendorId = Number(settlement.vendor_id);
    if (!settlementsByVendor.has(vendorId)) settlementsByVendor.set(vendorId, []);
    settlementsByVendor.get(vendorId).push(settlement);
  }
  return vendors.map((vendor) => applyVendorSettlementSummary(vendor, settlementsByVendor.get(Number(vendor.id)) || []));
}

export function buildVendorFinancialPayload({ vendors = [], players = [], financialByUid = { players: new Map() } } = {}) {
  const playersByVendor = playerGroups(players);

  return vendors.map((vendor) => {
    const vendorPlayers = playersByVendor.get(Number(vendor.id)) || [];
    const financial = summarizePlayersFinancial(vendorPlayers, financialByUid);
    if (financial.financial_available !== false) {
      financial.net = financial.total_in - financial.total_out;
    }
    return {
      ...vendor,
      player_count: vendorPlayers.length,
      active_players_today: financial.financial_available === false ? null : activePlayersToday(vendorPlayers, financialByUid),
      financial
    };
  });
}

const VENDOR_SORTS = new Set(['name', 'total_in', 'net', 'outstanding', 'player_count', 'latest_settlement_date']);

function filterVendors(vendors, { query = '', status = 'all' } = {}) {
  const term = String(query || '').trim().toLowerCase();
  const wantedStatus = String(status || 'all').toLowerCase();
  return vendors.filter((vendor) => {
    if ((wantedStatus === 'active' || wantedStatus === 'suspended') && String(vendor.status || '').toLowerCase() !== wantedStatus) {
      return false;
    }
    if (!term) return true;
    return String(vendor.name || '').toLowerCase().includes(term)
      || String(vendor.vendor_code || '').toLowerCase().includes(term);
  });
}

function sortValue(vendor, sort) {
  const financial = publicFinancial(vendor.financial || vendor);
  switch (sort) {
    case 'name':
      return String(vendor.name || '').toLowerCase();
    case 'total_in':
      return financial.total_in;
    case 'outstanding':
      return financial.outstanding;
    case 'player_count':
      return Number(vendor.player_count || 0);
    case 'latest_settlement_date':
      return vendor.latest_settlement_date || null;
    case 'net':
    default:
      return financial.net;
  }
}

function compareNullable(a, b, dir) {
  const aMissing = a == null || a === '' || Number.isNaN(a);
  const bMissing = b == null || b === '' || Number.isNaN(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a).localeCompare(String(b)) * dir;
  }
  return (Number(a) - Number(b)) * dir;
}

function sortVendors(vendors, { sort = 'net', dir = 'desc' } = {}) {
  const sortBy = VENDOR_SORTS.has(sort) ? sort : 'net';
  const sortDir = String(dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  return [...vendors].sort((left, right) => {
    const primary = compareNullable(sortValue(left, sortBy), sortValue(right, sortBy), sortDir);
    if (primary !== 0) return primary;
    return String(left.vendor_code || '').localeCompare(String(right.vendor_code || ''));
  });
}

export function registerVendorRoutes(app, { store, requireAdmin, appbegStore = null }) {
  const adminOnly = requireAdmin || ((_req, _res, next) => next());

  app.get('/api/vendors', adminOnly, async (req, res) => {
    const vendors = await store.listVendors();
    const players = typeof store.listAllVendorPlayers === 'function'
      ? await store.listAllVendorPlayers()
      : [];
    const financialByUid = await loadFinancialByUid(appbegStore, players);
    let settlements = [];
    let settlementsAvailable = true;
    if (typeof store.listAllVendorSettlements === 'function') {
      try {
        settlements = await store.listAllVendorSettlements();
      } catch (error) {
        settlementsAvailable = false;
        console.error('[vendors] settlement reporting query failed');
      }
    }
    const vendorsWithFinancial = buildVendorFinancialPayload({ vendors, players, financialByUid });
    const withSettlements = settlementsAvailable
      ? applyVendorSettlementSummaries(vendorsWithFinancial, settlements)
      : vendorsWithFinancial.map((vendor) => applyVendorSettlementUnavailable(vendor));
    const filtered = filterVendors(withSettlements, {
      query: req.query?.query ?? req.query?.q,
      status: req.query?.status
    });
    const sorted = sortVendors(filtered, {
      sort: req.query?.sort,
      dir: req.query?.dir
    });
    res.json({
      vendors: sorted.map(vendorPayload),
      financial: {
        configured: financialByUid.configured,
        source: financialByUid.source,
        reason: financialByUid.reason,
        activeDay: financialByUid.activeDay || null
      },
      settlementReporting: {
        configured: settlementsAvailable,
        reason: settlementsAvailable ? null : 'Settlement reporting is temporarily unavailable.'
      },
      filters: {
        query: String(req.query?.query ?? req.query?.q ?? ''),
        status: String(req.query?.status || 'all'),
        sort: VENDOR_SORTS.has(req.query?.sort) ? req.query.sort : 'net',
        dir: String(req.query?.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
      }
    });
  });

  app.get('/api/vendors/:id', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id.' });
    }
    const vendor = await store.getVendor(id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    const players = await store.listVendorPlayers(id);
    const financialByUid = await loadFinancialByUid(appbegStore, players);
    const financial = summarizePlayersFinancial(players, financialByUid);
    if (financial.financial_available !== false) {
      financial.net = financial.total_in - financial.total_out;
    }
    let settlements = [];
    let settlementsAvailable = true;
    if (typeof store.listVendorSettlements === 'function') {
      try {
        settlements = await store.listVendorSettlements(id);
      } catch (error) {
        settlementsAvailable = false;
        console.error('[vendors] settlement reporting query failed');
      }
    }
    const withDashboardSummary = {
      ...vendor,
      player_count: players.length,
      active_players_today: financial.financial_available === false ? null : activePlayersToday(players, financialByUid),
      financial
    };
    const vendorWithSettlementSummary = settlementsAvailable
      ? applyVendorSettlementSummary(withDashboardSummary, settlements)
      : applyVendorSettlementUnavailable(withDashboardSummary);
    res.json({
      vendor: vendorPayload(vendorWithSettlementSummary),
      players: players.map((player) => vendorPlayerPayload({
        ...player,
        financial: financialForPlayer(player, financialByUid)
      })),
      settlements: settlements.map(vendorSettlementPayload),
      financial: {
        configured: financialByUid.configured,
        source: financialByUid.source,
        reason: financialByUid.reason,
        activeDay: financialByUid.activeDay || null
      },
      settlementReporting: {
        configured: settlementsAvailable,
        reason: settlementsAvailable ? null : 'Settlement reporting is temporarily unavailable.'
      }
    });
  });

  app.get('/api/vendors/:id/settlements', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id.' });
    }
    const vendor = await store.getVendor(id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    const settlements = await store.listVendorSettlements(id);
    res.json({ settlements: settlements.map(vendorSettlementPayload) });
  });

  app.patch('/api/vendors/:id/commission', adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid vendor id.' });
      }
      const vendor = await store.updateVendorCommissionPercentage(id, req.body?.commissionPercentage);
      if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
      res.json({ vendor: vendorPayload(vendor) });
    } catch (error) {
      handleVendorError(res, error);
    }
  });

  app.post('/api/vendors/:id/settlements', adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid vendor id.' });
      }
      const actor = req.ledgerUser?.display_name || req.ledgerUser?.username || req.ledgerUser?.id || 'Admin';
      const settlement = await store.createVendorSettlement(id, {
        amount: req.body?.amount ?? req.body?.settlementAmount,
        settlementDate: req.body?.settlementDate,
        notes: req.body?.notes,
        createdBy: actor
      });
      if (!settlement) return res.status(404).json({ error: 'Vendor not found.' });
      res.status(201).json({ settlement: vendorSettlementPayload(settlement) });
    } catch (error) {
      handleVendorError(res, error);
    }
  });

  app.delete('/api/vendors/:id', adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid vendor id.' });
      }
      const result = await store.deleteVendor(id);
      if (!result?.deleted) return res.status(404).json({ error: 'Vendor not found.' });
      res.json({ deleted: true, vendorId: id });
    } catch (error) {
      handleVendorError(res, error);
    }
  });

  app.post('/api/vendors', adminOnly, async (req, res) => {
    try {
      const vendor = await store.createVendor({
        name: req.body?.name,
        commissionPercentage: req.body?.commissionPercentage,
        notes: req.body?.notes
      });
      res.status(201).json({ vendor: vendorPayload(vendor) });
    } catch (error) {
      handleVendorError(res, error);
    }
  });
}
