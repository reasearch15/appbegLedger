import { claimCashoutTaskViaTelegram } from '../appbeg/cashoutClaimClient.js';
import { fetchCashoutTaskForNotification } from '../appbeg/cashoutOutboxClient.js';
import {
  CASHOUT_CLAIM_PREFIX,
  isCashoutTelegramClaimEnabled,
  parseCashoutClaimCallback
} from './cashoutNotificationCards.js';
import { consumeCashoutTelegramCallbackRateLimit } from './cashoutTelegramCallbackRateLimit.js';
import { refreshCashoutTelegramCardsForTask } from './cashoutTelegramNotificationWorker.js';

export const CASHOUT_CLAIM_SUCCESS_TEXT = 'Cash-out claimed.';
export const CASHOUT_CLAIM_CONFLICT_TEXT = 'Already claimed.';
export const CASHOUT_CLAIM_UNAVAILABLE_TEXT = 'This cash-out is no longer available.';
export const CASHOUT_CLAIM_DISABLED_TEXT = 'Your Telegram staff access is disabled.';
export const CASHOUT_CLAIM_TEMP_FAIL_TEXT = 'Unable to claim right now. Try again.';
export const CASHOUT_CLAIM_UNAUTHORIZED_TEXT = 'Not authorized.';
export const CASHOUT_CLAIM_RATE_LIMIT_TEXT = 'Too many attempts. Try again shortly.';

function safeTelegramDisplayName(from = {}) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    || (from.username ? `@${from.username}` : '')
    || (from.id == null ? '' : `Staff ${from.id}`);
  return String(name).replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 80) || 'Staff';
}

/**
 * Handle cashout:claim:<taskId> callback.
 * AppBeg is concurrency authority; Ledger only authorizes subscriber + forwards claim.
 */
export async function handleCashoutClaimCallback(ctx, store, {
  env = process.env,
  claimTask = claimCashoutTaskViaTelegram,
  fetchTask = fetchCashoutTaskForNotification,
  refreshCards = refreshCashoutTelegramCardsForTask,
  answerCallback = defaultAnswerCallback
} = {}) {
  const action = String(ctx.callbackQuery?.data || '').trim();
  const taskId = parseCashoutClaimCallback(action);
  const fromId = ctx.from?.id == null ? null : String(ctx.from.id);

  if (!taskId || !fromId) {
    await answerCallback(ctx, 'Unknown action.');
    return { ok: false, reason: 'invalid_callback' };
  }

  if (!isCashoutTelegramClaimEnabled(env)) {
    await answerCallback(ctx, CASHOUT_CLAIM_UNAVAILABLE_TEXT);
    return { ok: false, reason: 'claim_disabled' };
  }

  const rate = consumeCashoutTelegramCallbackRateLimit({
    key: `claim:${fromId}`
  });
  if (!rate.allowed) {
    console.warn('[cashout-telegram] claim_rate_limited', { telegram_user_id: fromId });
    await answerCallback(ctx, CASHOUT_CLAIM_RATE_LIMIT_TEXT);
    return { ok: false, reason: 'rate_limited' };
  }

  const subscriber = typeof store.getSupportNotificationSubscriberByTelegramUserId === 'function'
    ? await store.getSupportNotificationSubscriberByTelegramUserId(fromId)
    : null;

  if (!subscriber) {
    await answerCallback(ctx, CASHOUT_CLAIM_UNAUTHORIZED_TEXT);
    return { ok: false, reason: 'unlinked' };
  }

  if (subscriber.disabled_by_coadmin) {
    await answerCallback(ctx, CASHOUT_CLAIM_DISABLED_TEXT);
    return { ok: false, reason: 'disabled_by_coadmin' };
  }

  if (!subscriber.is_active) {
    await answerCallback(ctx, CASHOUT_CLAIM_DISABLED_TEXT);
    return { ok: false, reason: 'inactive' };
  }

  const coadminUid = String(subscriber.coadmin_uid || '').trim();
  if (!coadminUid) {
    await answerCallback(ctx, CASHOUT_CLAIM_UNAUTHORIZED_TEXT);
    return { ok: false, reason: 'null_coadmin' };
  }

  console.log('[cashout-telegram] claim_callback', {
    task_id: taskId,
    telegram_user_id: fromId,
    coadmin_uid: coadminUid
  });

  const result = await claimTask({
    taskId,
    telegramUserId: fromId,
    telegramUsername: ctx.from?.username || null,
    telegramDisplayName: safeTelegramDisplayName(ctx.from),
    expectedCoadminUid: coadminUid,
    env
  });

  if (result.ok) {
    await answerCallback(ctx, CASHOUT_CLAIM_SUCCESS_TEXT);
    const task = result.task || (await fetchTask(taskId, { env })).task || null;
    if (task && store) {
      await refreshCards({ store, task, env }).catch((error) => {
        console.warn('[cashout-telegram] claim_refresh_failed', {
          task_id: taskId,
          error: error?.message || String(error)
        });
      });
    }
    return { ok: true, duplicate: Boolean(result.duplicate), task };
  }

  if (result.reason === 'conflict') {
    console.warn('[cashout-telegram] claim_conflict', {
      task_id: taskId,
      telegram_user_id: fromId
    });
    await answerCallback(ctx, CASHOUT_CLAIM_CONFLICT_TEXT);
    const taskResult = await fetchTask(taskId, { env });
    if (taskResult.ok && taskResult.task && store) {
      await refreshCards({ store, task: taskResult.task, env }).catch(() => null);
    }
    return { ok: false, reason: 'conflict' };
  }

  if (result.reason === 'forbidden' || result.reason === 'not_found') {
    await answerCallback(ctx, CASHOUT_CLAIM_UNAUTHORIZED_TEXT);
    return { ok: false, reason: result.reason };
  }

  if (result.reason === 'not_claimable') {
    await answerCallback(ctx, CASHOUT_CLAIM_UNAVAILABLE_TEXT);
    const taskResult = await fetchTask(taskId, { env });
    if (taskResult.ok && taskResult.task && store) {
      await refreshCards({ store, task: taskResult.task, env }).catch(() => null);
    }
    return { ok: false, reason: 'not_claimable' };
  }

  await answerCallback(ctx, CASHOUT_CLAIM_TEMP_FAIL_TEXT);
  return { ok: false, reason: result.reason || 'unavailable' };
}

export function isCashoutClaimCallback(action) {
  return String(action || '').startsWith(CASHOUT_CLAIM_PREFIX);
}

async function defaultAnswerCallback(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.error('[support-notification-bot] cashout_callback_answer_failed', {
      error_code: error?.code || error?.message || 'answer_failed'
    });
  }
}
