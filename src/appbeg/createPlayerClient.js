const DEFAULT_TIMEOUT_MS = 30000;

export function isAppBegCreatePlayerConfigured() {
  const baseUrl = String(process.env.APPBEG_API_URL || '').trim();
  const token = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  return Boolean(baseUrl && token);
}

export async function createAppBegPlayerViaApi({
  username,
  password,
  referralCode,
  coadminUid,
  ledgerContactId,
  telegramUserId
}) {
  const baseUrl = String(process.env.APPBEG_API_URL || '').replace(/\/$/, '');
  const token = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();

  if (!baseUrl || !token) {
    throw new Error('AppBeg player creation is not configured (APPBEG_API_URL / APPBEG_LEDGER_INTERNAL_TOKEN).');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/internal/ledger/create-player`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-ledger-token': token
      },
      body: JSON.stringify({
        username,
        password,
        referralCode: referralCode || undefined,
        coadminUid,
        ledgerContactId,
        telegramUserId: telegramUserId != null ? String(telegramUserId) : undefined
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
      const message = payload?.error || payload?.message || rawText || `AppBeg create-player failed (${response.status})`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      throw error;
    }

    if (!payload?.ok) {
      throw new Error(payload?.error || 'AppBeg create-player returned an unsuccessful response.');
    }

    return {
      ok: true,
      playerUid: payload.playerUid || payload.player_uid || null,
      username: payload.username || username
    };
  } finally {
    clearTimeout(timeout);
  }
}
