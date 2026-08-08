const DEFAULT_TIMEOUT_MS = 10000;

function appBegBase(env = process.env) {
  return String(env.APPBEG_API_URL || '').replace(/\/$/, '');
}

function appBegToken(env = process.env) {
  return String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
}

async function readJsonResponse(response) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    return null;
  }
}

/**
 * Claim an AppBeg cash-out as the owning Coadmin, with Telegram operational attribution.
 */
export async function claimCashoutTaskViaTelegram({
  taskId,
  telegramUserId,
  telegramUsername = null,
  telegramDisplayName = null,
  expectedCoadminUid,
  idempotencyKey = null,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const baseUrl = appBegBase(env);
  const token = appBegToken(env);
  const id = String(taskId ?? '').trim();
  const tgUserId = String(telegramUserId ?? '').trim();
  const coadminUid = String(expectedCoadminUid ?? '').trim();

  if (!baseUrl || !token) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!id || !tgUserId || !coadminUid) {
    return { ok: false, reason: 'invalid_input' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/api/internal/ledger/cashout-tasks/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-appbeg-ledger-token': token
      },
      body: JSON.stringify({
        taskId: id,
        telegramUserId: tgUserId,
        telegramUsername,
        telegramDisplayName,
        expectedCoadminUid: coadminUid,
        idempotencyKey:
          idempotencyKey || `cashout_claim:${id}:telegram:${tgUserId}`
      }),
      signal: controller.signal
    });

    const payload = await readJsonResponse(response);

    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (response.status === 403) {
      return { ok: false, reason: 'forbidden' };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found' };
    }
    if (response.status === 409 || payload?.conflict) {
      const errorCode = String(payload?.error || '').trim();
      if (errorCode === 'NOT_CLAIMABLE') {
        return {
          ok: false,
          reason: 'not_claimable',
          task: payload?.task || null,
          error: errorCode
        };
      }
      return {
        ok: false,
        reason: 'conflict',
        task: payload?.task || null,
        error: errorCode || 'ALREADY_CLAIMED'
      };
    }
    if (response.status === 503) {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.ok && payload?.ok === true) {
      return {
        ok: true,
        duplicate: Boolean(payload.duplicate),
        taskId: payload.taskId || id,
        expiresAtMs: payload.expiresAtMs ?? null,
        task: payload.task || null
      };
    }
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.warn('[cashout-claim-client] claim_failed', {
      aborted,
      error: aborted ? 'timeout' : 'network_error'
    });
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
