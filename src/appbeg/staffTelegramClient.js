const DEFAULT_TIMEOUT_MS = 10000;

export function isStaffTelegramValidationConfigured(env = process.env) {
  const baseUrl = String(env.APPBEG_API_URL || '').trim();
  const token = String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  return Boolean(baseUrl && token);
}

/**
 * Validate a Staff Telegram Integration Code against AppBeg.
 * Does not log tokens or full codes.
 *
 * @returns {{ ok: true, coadminUid: string }
 *   | { ok: false, reason: 'invalid' | 'rate_limited' | 'unavailable' | 'not_configured', error?: string }}
 */
export async function validateStaffTelegramIntegrationCode(code, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const baseUrl = String(env.APPBEG_API_URL || '').replace(/\/$/, '');
  const token = String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  const normalized = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

  if (!baseUrl || !token) {
    return { ok: false, reason: 'not_configured', error: 'AppBeg staff Telegram validation is not configured.' };
  }
  if (!normalized) {
    return { ok: false, reason: 'invalid' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/api/internal/ledger/staff-telegram/validate-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-ledger-token': token
      },
      body: JSON.stringify({ code: normalized }),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (response.status === 401) {
      return { ok: false, reason: 'unavailable', error: 'Unauthorized to validate Staff Telegram Integration Code.' };
    }
    if (response.status === 429) {
      return { ok: false, reason: 'rate_limited' };
    }
    if (response.status === 503) {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.ok && payload?.ok === true && payload.coadminUid) {
      return { ok: true, coadminUid: String(payload.coadminUid).trim() };
    }
    if (response.status === 400 || payload?.error === 'INVALID_CODE') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.warn('[staff-telegram-client] validate_failed', {
      aborted,
      error: aborted ? 'timeout' : 'network_error'
    });
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
