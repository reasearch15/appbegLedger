import { completeCashoutTaskViaTelegram } from '../appbeg/cashoutCompleteClient.js';
import { fetchCashoutTaskForNotification } from '../appbeg/cashoutOutboxClient.js';
import {
  CASHOUT_DONE_PREFIX,
  isCashoutTelegramDoneEnabled,
  parseCashoutDoneCallback
} from './cashoutNotificationCards.js';
import { consumeCashoutTelegramCallbackRateLimit } from './cashoutTelegramCallbackRateLimit.js';
import { refreshCashoutTelegramCardsForTask } from './cashoutTelegramNotificationWorker.js';

export const CASHOUT_DONE_SUCCESS_TEXT = '✅ Cash-out completed.';
export const CASHOUT_DONE_NOT_CLAIMANT_TEXT =
  'Only the staff member who claimed this cash-out can complete it.';
export const CASHOUT_DONE_CLAIM_INACTIVE_TEXT = 'This claim is no longer active.';
export const CASHOUT_DONE_ALREADY_COMPLETED_TEXT = 'This cash-out is already completed.';
export const CASHOUT_DONE_DISABLED_TEXT = 'Your Telegram staff access is disabled.';
export const CASHOUT_DONE_TEMP_FAIL_TEXT = 'Unable to complete right now. Try again.';
export const CASHOUT_DONE_UNAUTHORIZED_TEXT = 'Not authorized.';
export const CASHOUT_DONE_FEATURE_OFF_TEXT = 'This cash-out is no longer available.';
export const CASHOUT_DONE_RATE_LIMIT_TEXT = 'Too many attempts. Try again shortly.';

function safeTelegramDisplayName(from = {}) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    || (from.username ? `@${from.username}` : '')
    || (from.id == null ? '' : `Staff ${from.id}`);
  return String(name).replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 80) || 'Staff';
}

async function refreshAuthoritativeCards({
  store,
  taskId,
  task = null,
  fetchTask,
  refreshCards,
  env
}) {
  const resolved = task || (await fetchTask(taskId, { env })).task || null;
  if (resolved && store) {
    await refreshCards({ store, task: resolved, env }).catch((error) => {
      console.warn('[cashout-telegram] done_refresh_failed', {
        task_id: taskId,
        error: error?.message || String(error)
      });
    });
  }
  return resolved;
}

/**
 * Handle cashout:done:<taskId> callback.
 * AppBeg is concurrency + financial authority; Ledger only authorizes subscriber + forwards.
 */
export async function handleCashoutDoneCallback(ctx, store, {
  env = process.env,
  completeTask = completeCashoutTaskViaTelegram,
  fetchTask = fetchCashoutTaskForNotification,
  refreshCards = refreshCashoutTelegramCardsForTask,
  answerCallback = defaultAnswerCallback
} = {}) {
  const action = String(ctx.callbackQuery?.data || '').trim();
  const taskId = parseCashoutDoneCallback(action);
  const fromId = ctx.from?.id == null ? null : String(ctx.from.id);

  if (!taskId || !fromId) {
    await answerCallback(ctx, 'Unknown action.');
    return { ok: false, reason: 'invalid_callback' };
  }

  if (!isCashoutTelegramDoneEnabled(env)) {
    await answerCallback(ctx, CASHOUT_DONE_FEATURE_OFF_TEXT);
    return { ok: false, reason: 'done_disabled' };
  }

  const rate = consumeCashoutTelegramCallbackRateLimit({
    key: `done:${fromId}`
  });
  if (!rate.allowed) {
    console.warn('[cashout-telegram] done_rate_limited', { telegram_user_id: fromId });
    await answerCallback(ctx, CASHOUT_DONE_RATE_LIMIT_TEXT);
    return { ok: false, reason: 'rate_limited' };
  }

  const subscriber = typeof store.getSupportNotificationSubscriberByTelegramUserId === 'function'
    ? await store.getSupportNotificationSubscriberByTelegramUserId(fromId)
    : null;

  if (!subscriber) {
    await answerCallback(ctx, CASHOUT_DONE_UNAUTHORIZED_TEXT);
    return { ok: false, reason: 'unlinked' };
  }

  if (subscriber.disabled_by_coadmin) {
    await answerCallback(ctx, CASHOUT_DONE_DISABLED_TEXT);
    return { ok: false, reason: 'disabled_by_coadmin' };
  }

  if (!subscriber.is_active) {
    await answerCallback(ctx, CASHOUT_DONE_DISABLED_TEXT);
    return { ok: false, reason: 'inactive' };
  }

  const coadminUid = String(subscriber.coadmin_uid || '').trim();
  if (!coadminUid) {
    await answerCallback(ctx, CASHOUT_DONE_UNAUTHORIZED_TEXT);
    return { ok: false, reason: 'null_coadmin' };
  }

  console.log('[cashout-telegram] done_callback', {
    task_id: taskId,
    telegram_user_id: fromId,
    coadmin_uid: coadminUid
  });

  const result = await completeTask({
    taskId,
    telegramUserId: fromId,
    telegramUsername: ctx.from?.username || null,
    telegramDisplayName: safeTelegramDisplayName(ctx.from),
    expectedCoadminUid: coadminUid,
    env
  });

  if (result.ok) {
    if (result.alreadyCompleted || result.duplicate) {
      console.log('[cashout-telegram] complete_replay', {
        task_id: taskId,
        telegram_user_id: fromId,
        already_completed: Boolean(result.alreadyCompleted),
        duplicate: Boolean(result.duplicate)
      });
      await answerCallback(ctx, CASHOUT_DONE_ALREADY_COMPLETED_TEXT);
    } else {
      console.log('[cashout-telegram] complete_success', {
        task_id: taskId,
        telegram_user_id: fromId
      });
      await answerCallback(ctx, CASHOUT_DONE_SUCCESS_TEXT);
    }
    const task = await refreshAuthoritativeCards({
      store,
      taskId,
      task: result.task,
      fetchTask,
      refreshCards,
      env
    });
    return {
      ok: true,
      duplicate: Boolean(result.duplicate),
      alreadyCompleted: Boolean(result.alreadyCompleted),
      task
    };
  }

  if (result.reason === 'not_claimant') {
    await answerCallback(ctx, CASHOUT_DONE_NOT_CLAIMANT_TEXT);
    await refreshAuthoritativeCards({
      store,
      taskId,
      task: result.task,
      fetchTask,
      refreshCards,
      env
    });
    return { ok: false, reason: 'not_claimant' };
  }

  if (result.reason === 'forbidden' || result.reason === 'not_found') {
    await answerCallback(ctx, CASHOUT_DONE_UNAUTHORIZED_TEXT);
    return { ok: false, reason: result.reason };
  }

  if (result.reason === 'not_completable') {
    const status = String(result.task?.status || '').toLowerCase();
    if (status === 'completed') {
      await answerCallback(ctx, CASHOUT_DONE_ALREADY_COMPLETED_TEXT);
    } else if (status === 'pending' || status === 'declined') {
      await answerCallback(ctx, CASHOUT_DONE_CLAIM_INACTIVE_TEXT);
    } else {
      await answerCallback(ctx, CASHOUT_DONE_CLAIM_INACTIVE_TEXT);
    }
    await refreshAuthoritativeCards({
      store,
      taskId,
      task: result.task,
      fetchTask,
      refreshCards,
      env
    });
    return { ok: false, reason: 'not_completable' };
  }

  await answerCallback(ctx, CASHOUT_DONE_TEMP_FAIL_TEXT);
  return { ok: false, reason: result.reason || 'unavailable' };
}

export function isCashoutDoneCallback(action) {
  return String(action || '').startsWith(CASHOUT_DONE_PREFIX);
}

async function defaultAnswerCallback(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.error('[support-notification-bot] cashout_done_callback_answer_failed', {
      error_code: error?.code || error?.message || 'answer_failed'
    });
  }
}
