function zeroFinancial() {
  return {
    total_in: 0,
    total_out: 0,
    net: 0,
    last_activity: null,
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
    financial_available: true,
    financial_unavailable_reason: null
  };
}

function publicFinancial(financial = {}) {
  const normalized = normalizeFinancial(financial);
  const commissionPercentage = Number(financial.commission_percentage ?? financial.commissionPercentage ?? 0);
  const settlementTotal = Number(financial.settlement_total ?? financial.settlementTotal ?? 0);
  const lastSettlement = financial.last_settlement ?? financial.lastSettlement ?? null;
  const receivable = normalized.financial_available === false || normalized.net == null
    ? null
    : roundCurrency(normalized.net * ((Number.isFinite(commissionPercentage) ? commissionPercentage : 0) / 100));
  const outstanding = receivable == null
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
    financialAvailable: normalized.financial_available,
    financial_available: normalized.financial_available,
    financialUnavailableReason: normalized.financial_unavailable_reason,
    financial_unavailable_reason: normalized.financial_unavailable_reason,
    settlementTotal,
    settlement_total: settlementTotal,
    settlementTotalCents: Number(financial.settlement_total_cents || 0),
    settlement_total_cents: Number(financial.settlement_total_cents || 0),
    lastSettlement,
    last_settlement: lastSettlement,
    receivable,
    outstanding
  };
}

function vendorPayload(vendor) {
  const financial = publicFinancial(vendor.financial || vendor);
  return {
    id: vendor.id,
    vendorCode: vendor.vendor_code,
    vendor_code: vendor.vendor_code,
    name: vendor.name,
    status: vendor.status,
    commissionPercentage: vendor.commission_percentage,
    commission_percentage: vendor.commission_percentage,
    linkedStaffUid: vendor.linked_staff_uid,
    linked_staff_uid: vendor.linked_staff_uid,
    notes: vendor.notes,
    playerCount: vendor.player_count || 0,
    player_count: vendor.player_count || 0,
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

function applyVendorSettlementSummary(vendor, settlements = []) {
  const summary = summarizeSettlements(settlements);
  return {
    ...vendor,
    financial: {
      ...(vendor.financial || {}),
      commission_percentage: vendor.commission_percentage,
      settlement_total: summary.settlement_total,
      settlement_total_cents: summary.settlement_total_cents,
      last_settlement: summary.last_settlement
    }
  };
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
  const playersByVendor = new Map();
  for (const player of players) {
    const vendorId = Number(player.vendor_id);
    if (!playersByVendor.has(vendorId)) playersByVendor.set(vendorId, []);
    playersByVendor.get(vendorId).push(player);
  }

  return vendors.map((vendor) => {
    const vendorPlayers = playersByVendor.get(Number(vendor.id)) || [];
    const financial = summarizePlayersFinancial(vendorPlayers, financialByUid);
    if (financial.financial_available !== false) {
      financial.net = financial.total_in - financial.total_out;
    }
    return {
      ...vendor,
      player_count: vendorPlayers.length,
      financial
    };
  });
}

export function registerVendorRoutes(app, { store, requireAdmin, appbegStore = null }) {
  const adminOnly = requireAdmin || ((_req, _res, next) => next());

  app.get('/api/vendors', adminOnly, async (_req, res) => {
    const vendors = await store.listVendors();
    const players = typeof store.listAllVendorPlayers === 'function'
      ? await store.listAllVendorPlayers()
      : [];
    const financialByUid = await loadFinancialByUid(appbegStore, players);
    const settlements = typeof store.listAllVendorSettlements === 'function'
      ? await store.listAllVendorSettlements()
      : [];
    const vendorsWithFinancial = buildVendorFinancialPayload({ vendors, players, financialByUid });
    res.json({
      vendors: applyVendorSettlementSummaries(vendorsWithFinancial, settlements).map(vendorPayload),
      financial: {
        configured: financialByUid.configured,
        source: financialByUid.source,
        reason: financialByUid.reason
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
    const settlements = typeof store.listVendorSettlements === 'function'
      ? await store.listVendorSettlements(id)
      : [];
    res.json({
      vendor: vendorPayload(applyVendorSettlementSummary({ ...vendor, player_count: players.length, financial }, settlements)),
      players: players.map((player) => vendorPlayerPayload({
        ...player,
        financial: financialForPlayer(player, financialByUid)
      })),
      settlements: settlements.map(vendorSettlementPayload),
      financial: {
        configured: financialByUid.configured,
        source: financialByUid.source,
        reason: financialByUid.reason
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

  app.post('/api/vendors', adminOnly, async (req, res) => {
    try {
      const vendor = await store.createVendor({
        name: req.body?.name,
        commissionPercentage: req.body?.commissionPercentage,
        linkedStaffUid: req.body?.linkedStaffUid,
        notes: req.body?.notes
      });
      res.status(201).json({ vendor: vendorPayload(vendor) });
    } catch (error) {
      handleVendorError(res, error);
    }
  });
}
