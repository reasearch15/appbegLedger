const DEFAULT_TIMEOUT_MS = 30000;

export function buildPaymentEventIdempotencyKey(paymentEventId) {
  const id = Number(paymentEventId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid paymentEventId is required for RoyalVIP credit idempotency.');
  }
  return `appbegledger-payment-event:${id}`;
}

export async function creditAppBegDepositViaApi({
  playerUid,
  amount,
  externalReference,
  sourceFlow,
  ledgerContactId,
  paymentEventId,
  windowId,
  actorName,
  paymentAmount = null,
  paymentCents = null
}) {
  const baseUrl = String(process.env.APPBEG_API_URL || '').replace(/\/$/, '');
  const token = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();

  if (!baseUrl || !token) {
    throw new Error('RoyalVIP deposit credit is not configured (APPBEG_API_URL / APPBEG_LEDGER_INTERNAL_TOKEN).');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const body = {
      playerUid,
      // Player coin credit — must remain the rounded/credited amount (e.g. 6).
      amount,
      externalReference,
      sourceFlow,
      ledgerContactId,
      paymentEventId,
      windowId,
      actorName
    };
    // Authoritative money received (e.g. 5.50). Distinct from player coin credit.
    if (paymentAmount != null && Number.isFinite(Number(paymentAmount))) {
      body.paymentAmount = Number(paymentAmount);
    }
    if (paymentCents != null && Number.isSafeInteger(Number(paymentCents))) {
      body.paymentCents = Number(paymentCents);
    }

    const response = await fetch(`${baseUrl}/api/internal/ledger/credit-deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-ledger-token': token
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = { error: rawText };
    }

    if (!response.ok) {
      const message = payload?.error || payload?.message || rawText || `RoyalVIP deposit credit failed (${response.status})`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      throw error;
    }

    const status = payload?.status;
    if (status !== 'credited' && status !== 'already_credited') {
      throw new Error(payload?.error || 'RoyalVIP deposit credit returned an unexpected response.');
    }

    return {
      status,
      credited: status === 'credited',
      alreadyCredited: status === 'already_credited',
      amount: Number(payload.amount ?? amount),
      paymentAmount: body.paymentAmount ?? null,
      paymentCents: body.paymentCents ?? null,
      externalReference: payload.externalReference || externalReference,
      playerUid: payload.playerUid || playerUid,
      financialEventId: payload.financialEventId || null
    };
  } finally {
    clearTimeout(timeout);
  }
}
