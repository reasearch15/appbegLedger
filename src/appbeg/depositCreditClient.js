const DEFAULT_TIMEOUT_MS = 30000;

export function buildPaymentEventIdempotencyKey(paymentEventId) {
  const id = Number(paymentEventId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid paymentEventId is required for AppBeg credit idempotency.');
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
  actorName
}) {
  const baseUrl = String(process.env.APPBEG_API_URL || '').replace(/\/$/, '');
  const token = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();

  if (!baseUrl || !token) {
    throw new Error('AppBeg deposit credit is not configured (APPBEG_API_URL / APPBEG_LEDGER_INTERNAL_TOKEN).');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/internal/ledger/credit-deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-ledger-token': token
      },
      body: JSON.stringify({
        playerUid,
        amount,
        externalReference,
        sourceFlow,
        ledgerContactId,
        paymentEventId,
        windowId,
        actorName
      }),
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
      const message = payload?.error || payload?.message || rawText || `AppBeg deposit credit failed (${response.status})`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      throw error;
    }

    const status = payload?.status;
    if (status !== 'credited' && status !== 'already_credited') {
      throw new Error(payload?.error || 'AppBeg deposit credit returned an unexpected response.');
    }

    return {
      status,
      credited: status === 'credited',
      alreadyCredited: status === 'already_credited',
      amount: Number(payload.amount ?? amount),
      externalReference: payload.externalReference || externalReference,
      playerUid: payload.playerUid || playerUid,
      financialEventId: payload.financialEventId || null
    };
  } finally {
    clearTimeout(timeout);
  }
}
