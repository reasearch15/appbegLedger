/**
 * Pure vendor cashout accounting helpers.
 * Vendor Total Out / Net / receivable are derived from AppBeg financial events
 * (authoritative) plus commission%; Ledger does not maintain a competing aggregate.
 *
 * Total Out = sum of unique completed `cashout` financial events (deduped by cashout task id).
 * Game `redeem` events are NOT Total Out (they credit player cash from a game).
 * Declined/cancelled cashouts never write type=cashout; request debits/refunds are excluded.
 * Net = Total In − Total Out
 */

export function roundCurrency(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

export function normalizeVendorCashoutAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return roundCurrency(amount);
}

/**
 * Net = Total In − Total Out
 * Receivable = Net × (commissionPercentage / 100)
 */
export function computeVendorAccountingFromTotals({
  totalIn = 0,
  totalOut = 0,
  commissionPercentage = 0,
  settlementTotal = 0
} = {}) {
  const safeIn = Number.isFinite(Number(totalIn)) ? Number(totalIn) : 0;
  const safeOut = Number.isFinite(Number(totalOut)) ? Number(totalOut) : 0;
  const net = roundCurrency(safeIn - safeOut);
  const commission = Number.isFinite(Number(commissionPercentage)) ? Number(commissionPercentage) : 0;
  const receivable = roundCurrency(net * (commission / 100));
  const outstanding = roundCurrency(receivable - (Number.isFinite(Number(settlementTotal)) ? Number(settlementTotal) : 0));
  return {
    totalIn: roundCurrency(safeIn),
    totalOut: roundCurrency(safeOut),
    net,
    receivable,
    outstanding,
    commissionPercentage: commission
  };
}

/**
 * Simulate applying one completed cashout onto prior totals (for tests / response math
 * when AppBeg financial reporting is mocked). Authoritative production path reads
 * AppBeg financial_events_cache instead of mutating stored vendor aggregates.
 */
export function applyCashoutToVendorTotals(prior, amountNpr, commissionPercentage) {
  const amount = normalizeVendorCashoutAmount(amountNpr);
  if (amount == null) {
    throw new Error('amountNpr must be greater than 0.');
  }
  return computeVendorAccountingFromTotals({
    totalIn: prior?.totalIn ?? prior?.total_in ?? 0,
    totalOut: (prior?.totalOut ?? prior?.total_out ?? 0) + amount,
    commissionPercentage: commissionPercentage ?? prior?.commissionPercentage ?? 0,
    settlementTotal: prior?.settlementTotal ?? prior?.settlement_total ?? 0
  });
}

export function validateVendorCashoutCompletedBody(body = {}) {
  const eventId = String(body.eventId || '').trim();
  const taskId = String(body.taskId || body.cashoutTaskId || '').trim();
  const playerUid = String(body.playerUid || '').trim();
  const vendorIdRaw = body.vendorId;
  const vendorId = Number(vendorIdRaw);
  const amountNpr = normalizeVendorCashoutAmount(body.amountNpr ?? body.amount);

  if (!eventId) {
    return { ok: false, status: 400, error: 'eventId is required.' };
  }
  if (!taskId) {
    return { ok: false, status: 400, error: 'taskId is required.' };
  }
  if (!playerUid) {
    return { ok: false, status: 400, error: 'playerUid is required.' };
  }
  if (!Number.isInteger(vendorId) || vendorId <= 0) {
    return { ok: false, status: 400, error: 'vendorId is required and must be a positive integer.' };
  }
  if (amountNpr == null) {
    return { ok: false, status: 400, error: 'amountNpr must be greater than 0.' };
  }

  return {
    ok: true,
    value: {
      eventId,
      taskId,
      playerUid,
      vendorId,
      amountNpr,
      vendorCode: String(body.vendorCode || '').trim() || null,
      vendorName: String(body.vendorName || '').trim() || null,
      coadminUid: String(body.coadminUid || '').trim() || null,
      occurredAt: String(body.occurredAt || '').trim() || null,
      reason: String(body.reason || '').trim() || 'cashout_completed',
      metadata: {
        vendorCode: String(body.vendorCode || '').trim() || null,
        vendorName: String(body.vendorName || '').trim() || null,
        coadminUid: String(body.coadminUid || '').trim() || null,
        reason: String(body.reason || '').trim() || 'cashout_completed',
        source: 'appbeg_cashout'
      }
    }
  };
}
