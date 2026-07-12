/**
 * Freeze overdue searching/unrouted payments and emit live updates.
 * Runs immediately on start, then every pollMs (default 5s).
 */
export async function processPaymentFreezeTick({ store, io = null, now = new Date() } = {}) {
  console.log('[payment-freeze] payment_freeze_scan_started');
  try {
    const result = typeof store.freezeOverdueSearchingPayments === 'function'
      ? await store.freezeOverdueSearchingPayments({ now })
      : { frozen: [], count: 0, backfilled: 0 };

    for (const payment of result.frozen || []) {
      console.log(
        `[payment-freeze] payment_frozen payment=${payment.id} freeze_at=${payment.freeze_at} ` +
        `frozen_at=${payment.frozen_at || now.toISOString()}`
      );
      if (io) {
        io.emit('payment:frozen', { paymentId: payment.id, payment });
      }
    }

    if ((result.count || 0) > 0 && io) {
      io.emit('payments:changed');
      io.emit('manual-review:changed');
    }

    console.log(
      `[payment-freeze] payment_freeze_scan_finished frozen=${result.count || 0} ` +
      `backfilled=${result.backfilled || 0}`
    );
    return result;
  } catch (error) {
    console.error('[payment-freeze] payment_freeze_worker_error', error);
    throw error;
  }
}

export function startPaymentFreezeWorker({
  store,
  io = null,
  pollMs = Number(process.env.PAYMENT_FREEZE_POLL_MS || 5000)
} = {}) {
  const enabled = process.env.PAYMENT_FREEZE_WORKER_ENABLED !== 'false';
  if (!enabled) {
    console.log('[payment-freeze] payment freeze worker disabled (PAYMENT_FREEZE_WORKER_ENABLED=false)');
    return { stop: async () => {} };
  }

  let stopped = false;
  let tickPromise = null;
  const interval = Math.max(Number(pollMs) || 5000, 1000);

  console.log(`[payment-freeze] payment_freeze_worker_started poll_ms=${interval}`);

  async function tick() {
    if (stopped) return;
    try {
      await processPaymentFreezeTick({ store, io });
    } catch (error) {
      console.error('[payment-freeze] payment_freeze_worker_error', error);
    }
  }

  const timer = setInterval(() => {
    if (tickPromise) return;
    tickPromise = tick().finally(() => {
      tickPromise = null;
    });
  }, interval);

  tickPromise = tick().finally(() => {
    tickPromise = null;
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (tickPromise) await tickPromise;
      console.log('[payment-freeze] payment freeze worker stopped');
    }
  };
}
