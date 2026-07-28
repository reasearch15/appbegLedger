import {
  requireVendorInternalAuth
} from '../middleware/vendorInternalAuth.js';
import {
  applyCashoutToVendorTotals,
  computeVendorAccountingFromTotals,
  validateVendorCashoutCompletedBody
} from '../vendors/vendorCashoutAccounting.js';

function safeLogContext(input = {}) {
  return {
    eventId: input.eventId || null,
    taskId: input.taskId || null,
    playerUid: input.playerUid || null,
    vendorId: input.vendorId || null
  };
}

async function loadVendorAccountingSnapshot({
  store,
  appbegStore,
  vendor,
  playerUid,
  amountNpr
}) {
  const commissionPercentage = Number(vendor.commission_percentage ?? vendor.commissionPercentage ?? 0);
  const settlements = typeof store.listVendorSettlements === 'function'
    ? await store.listVendorSettlements(vendor.id)
    : [];
  const settlementTotal = (settlements || []).reduce((sum, row) => {
    const cents = Number(row.settlement_amount_cents || 0);
    return sum + (Number.isSafeInteger(cents) ? cents / 100 : 0);
  }, 0);

  let totalIn = 0;
  let totalOut = 0;
  let financialSource = 'formula_only';

  if (appbegStore && typeof appbegStore.getFinancialReportForPlayerUids === 'function') {
    try {
      const players = typeof store.listVendorPlayers === 'function'
        ? await store.listVendorPlayers(vendor.id)
        : [];
      const uids = [...new Set(
        (players || [])
          .map((row) => String(row.appbeg_player_uid || row.appbegPlayerUid || '').trim())
          .filter(Boolean)
          .concat(String(playerUid || '').trim() ? [String(playerUid).trim()] : [])
      )];
      if (uids.length) {
        const report = await appbegStore.getFinancialReportForPlayerUids(uids);
        if (report?.configured !== false) {
          financialSource = report.source || 'appbeg_financial_events_cache';
          for (const row of report.players || []) {
            totalIn += Number(row.total_in ?? row.totalIn ?? 0) || 0;
            totalOut += Number(row.total_out ?? row.totalOut ?? 0) || 0;
          }
        }
      }
    } catch (error) {
      console.warn('[internal-vendor-cashout] financial report unavailable', {
        vendorId: vendor.id,
        error: error instanceof Error ? error.message : String(error)
      });
      financialSource = 'formula_fallback';
      // Fall back to applying this cashout onto zero prior totals for response math only.
      return {
        ...applyCashoutToVendorTotals({ totalIn: 0, totalOut: 0, settlementTotal }, amountNpr, commissionPercentage),
        financialSource
      };
    }
  } else {
    return {
      ...applyCashoutToVendorTotals({ totalIn: 0, totalOut: 0, settlementTotal }, amountNpr, commissionPercentage),
      financialSource
    };
  }

  return {
    ...computeVendorAccountingFromTotals({
      totalIn,
      totalOut,
      commissionPercentage,
      settlementTotal
    }),
    financialSource
  };
}

export function registerInternalVendorCashoutRoutes(app, { store, appbegStore = null, io = null }) {
  async function handleVendorCashoutCompleted(req, res) {
    const validation = validateVendorCashoutCompletedBody(req.body || {});
    if (!validation.ok) {
      console.warn('[internal-vendor-cashout] validation_failed', {
        error: validation.error
      });
      return res.status(validation.status).json({ error: validation.error });
    }

    const payload = validation.value;
    console.info('[internal-vendor-cashout] received', safeLogContext(payload));

    try {
      const result = await store.recordVendorCashoutCompleted({
        eventId: payload.eventId,
        taskId: payload.taskId,
        playerUid: payload.playerUid,
        vendorId: payload.vendorId,
        amountNpr: payload.amountNpr,
        source: 'appbeg_cashout',
        occurredAt: payload.occurredAt,
        metadata: payload.metadata
      });

      if (result.duplicate) {
        console.info('[internal-vendor-cashout] duplicate_event', safeLogContext(payload));
        const accounting = await loadVendorAccountingSnapshot({
          store,
          appbegStore,
          vendor: result.vendor,
          playerUid: payload.playerUid,
          amountNpr: payload.amountNpr
        });
        return res.status(409).json({
          ok: true,
          duplicate: true,
          status: 'already_processed',
          eventId: payload.eventId,
          taskId: payload.taskId,
          playerUid: payload.playerUid,
          vendorId: result.vendor.id,
          vendorCode: result.vendor.vendor_code || result.vendor.vendorCode || null,
          amountNpr: payload.amountNpr,
          accounting
        });
      }

      const accounting = await loadVendorAccountingSnapshot({
        store,
        appbegStore,
        vendor: result.vendor,
        playerUid: payload.playerUid,
        amountNpr: payload.amountNpr
      });

      if (io && typeof io.emit === 'function') {
        io.emit('vendors:changed', {
          reason: 'cashout_completed',
          vendorId: result.vendor.id,
          playerUid: payload.playerUid,
          taskId: payload.taskId,
          eventId: payload.eventId
        });
      }

      console.info('[internal-vendor-cashout] recorded', {
        ...safeLogContext(payload),
        totalOut: accounting.totalOut,
        net: accounting.net,
        receivable: accounting.receivable,
        financialSource: accounting.financialSource
      });

      return res.status(200).json({
        ok: true,
        duplicate: false,
        status: 'ok',
        eventId: payload.eventId,
        taskId: payload.taskId,
        playerUid: payload.playerUid,
        vendorId: result.vendor.id,
        vendorCode: result.vendor.vendor_code || result.vendor.vendorCode || null,
        amountNpr: payload.amountNpr,
        accounting
      });
    } catch (error) {
      if (error?.code === 'VENDOR_NOT_FOUND') {
        console.warn('[internal-vendor-cashout] invalid_vendor', safeLogContext(payload));
        return res.status(404).json({ error: 'Vendor not found.' });
      }
      if (error?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: error.message || 'Invalid cashout payload.' });
      }
      console.error('[internal-vendor-cashout] failed', {
        ...safeLogContext(payload),
        error: error instanceof Error ? error.message : String(error)
      });
      return res.status(500).json({ error: 'Failed to record vendor cashout.' });
    }
  }

  // Auth uses the same Bearer key as /api/internal/vendor-ownership.
  app.post(
    '/api/internal/vendor-cashout-completed',
    requireVendorInternalAuth,
    handleVendorCashoutCompleted
  );
}
