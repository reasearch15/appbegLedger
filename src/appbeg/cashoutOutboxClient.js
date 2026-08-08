const DEFAULT_TIMEOUT_MS = 10000;

export function isCashoutOutboxClientConfigured(env = process.env) {
  const baseUrl = String(env.APPBEG_API_URL || '').trim();
  const token = String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  return Boolean(baseUrl && token);
}

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
 * Poll coadmin cash-out live_outbox events after a durable checkpoint id.
 */
export async function fetchCashoutOutboxEvents({
  afterOutboxId = 0,
  limit = 50,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const baseUrl = appBegBase(env);
  const token = appBegToken(env);
  if (!baseUrl || !token) {
    return { ok: false, reason: 'not_configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const after = Math.max(0, Math.floor(Number(afterOutboxId) || 0));
  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);

  try {
    const url =
      `${baseUrl}/api/internal/ledger/cashout-outbox` +
      `?afterOutboxId=${encodeURIComponent(String(after))}` +
      `&limit=${encodeURIComponent(String(safeLimit))}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-appbeg-ledger-token': token
      },
      signal: controller.signal
    });
    const payload = await readJsonResponse(response);
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!response.ok || !payload?.ok) {
      return { ok: false, reason: 'unavailable' };
    }
    return {
      ok: true,
      afterOutboxId: Number(payload.afterOutboxId || after),
      latestOutboxId: Number(payload.latestOutboxId || 0),
      events: Array.isArray(payload.events) ? payload.events : []
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.warn('[cashout-outbox-client] poll_failed', {
      aborted,
      error: aborted ? 'timeout' : 'network_error'
    });
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Load authoritative cash-out task fields for notification rendering.
 */
export async function fetchCashoutTaskForNotification(taskId, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const baseUrl = appBegBase(env);
  const token = appBegToken(env);
  const id = String(taskId ?? '').trim();
  if (!baseUrl || !token) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!id) {
    return { ok: false, reason: 'missing_task_id' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `${baseUrl}/api/internal/ledger/cashout-tasks/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-appbeg-ledger-token': token
        },
        signal: controller.signal
      }
    );
    const payload = await readJsonResponse(response);
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found' };
    }
    if (!response.ok || !payload?.ok || !payload.task) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, task: payload.task };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.warn('[cashout-outbox-client] task_fetch_failed', {
      aborted,
      error: aborted ? 'timeout' : 'network_error'
    });
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
