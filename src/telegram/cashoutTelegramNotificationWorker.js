import {
  isCashoutTelegramNotificationsEnabled,
  resolveCashoutTelegramFeatureGates
} from './cashoutTelegramFeatureFlags.js';
import {
  fetchCashoutOutboxEvents,
  fetchCashoutTaskForNotification,
  isCashoutOutboxClientConfigured
} from '../appbeg/cashoutOutboxClient.js';
import {
  editCashoutNotificationMessage,
  sendCashoutNotificationToChat
} from './cashoutNotificationDelivery.js';

export { isCashoutTelegramNotificationsEnabled } from './cashoutTelegramFeatureFlags.js';

export const CASHOUT_TELEGRAM_CONSUMER_NAME = 'cashout_telegram_notifications';
export const CASHOUT_TELEGRAM_MAX_ATTEMPTS = 5;
export const CASHOUT_TELEGRAM_RETRY_COOLDOWN_MS = 30_000;

/** Verified AppBeg live_outbox event_type values for cash-out cards. */
export const CASHOUT_TELEGRAM_CREATE_EVENT = 'cashout_task_created';
export const CASHOUT_TELEGRAM_STATE_EVENTS = new Set([
  'cashout_start',
  'cashout_complete',
  'cashout_decline',
  'cashout_release',
  'cashout_timeout_release'
]);

function payloadTaskId(event) {
  const fromPayload = String(event?.payload?.taskId || event?.payload?.entityId || '').trim();
  if (fromPayload) return fromPayload;
  return String(event?.entityId || '').trim();
}

function payloadCoadminUid(event) {
  return String(event?.payload?.coadminUid || '').trim();
}

function isTransientTaskFetchFailure(reason) {
  const text = String(reason || '');
  if (!text.startsWith('task_')) return false;
  return text !== 'task_not_found' && text !== 'task_missing_task_id';
}

/**
 * Ensure durable checkpoint exists. First activation bootstraps to latest
 * outbox id so historical cashout events are NOT notified/edited.
 */
export async function ensureCashoutOutboxCheckpoint(store, {
  env = process.env,
  fetchImpl = fetch,
  fetchOutbox = fetchCashoutOutboxEvents
} = {}) {
  const existing = await store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME);
  if (existing) {
    return {
      bootstrapped: false,
      lastProcessedOutboxId: Number(existing.last_processed_outbox_id || 0)
    };
  }

  const poll = await fetchOutbox({
    afterOutboxId: Number.MAX_SAFE_INTEGER,
    limit: 1,
    env,
    fetchImpl
  });
  let latest = 0;
  if (poll.ok) {
    latest = Number(poll.latestOutboxId || 0);
  } else {
    const probe = await fetchOutbox({ afterOutboxId: 0, limit: 1, env, fetchImpl });
    if (!probe.ok) {
      throw new Error(`cashout_outbox_bootstrap_unavailable:${probe.reason || 'unknown'}`);
    }
    latest = Number(probe.latestOutboxId || 0);
  }

  await store.upsertCashoutOutboxConsumerState({
    consumerName: CASHOUT_TELEGRAM_CONSUMER_NAME,
    lastProcessedOutboxId: latest
  });

  console.log('[cashout-telegram] checkpoint_bootstrapped', {
    consumer: CASHOUT_TELEGRAM_CONSUMER_NAME,
    last_processed_outbox_id: latest
  });

  return { bootstrapped: true, lastProcessedOutboxId: latest };
}

async function deliverToSubscriber({
  store,
  task,
  subscriber,
  outboxId,
  eventType,
  env,
  fetchImpl,
  sendMessage = sendCashoutNotificationToChat
}) {
  const chatId = String(subscriber.telegram_chat_id || '').trim();
  if (!chatId) return { skipped: true, reason: 'missing_chat_id' };

  const ensured = await store.ensureCashoutNotificationDelivery({
    appbegCashoutTaskId: task.taskId,
    coadminUid: task.coadminUid,
    subscriberId: subscriber.id,
    telegramChatId: chatId,
    outboxId,
    eventType
  });

  const row = ensured.delivery;
  if (!row) return { skipped: true, reason: 'ensure_failed' };

  if (row.delivery_status === 'sent' && row.telegram_message_id != null) {
    console.log('[cashout-telegram] duplicate_delivery_skipped', {
      task_id: task.taskId,
      telegram_chat_id: chatId,
      delivery_id: row.id
    });
    return { skipped: true, reason: 'already_sent' };
  }

  if (row.delivery_status === 'failed' && row.attempt_count >= CASHOUT_TELEGRAM_MAX_ATTEMPTS) {
    return { skipped: true, reason: 'max_attempts' };
  }

  console.log('[cashout-telegram] send_attempt', {
    task_id: task.taskId,
    telegram_chat_id: chatId,
    attempt: Number(row.attempt_count || 0) + 1
  });

  const result = await sendMessage({
    chatId,
    task,
    env,
    fetchImpl,
    viewerTelegramUserId: subscriber.telegram_user_id || null
  });

  if (result.ok) {
    await store.markCashoutNotificationDeliverySent({
      deliveryId: row.id,
      telegramMessageId: result.telegramMessageId,
      outboxId
    });
    console.log('[cashout-telegram] send_success', {
      task_id: task.taskId,
      telegram_chat_id: chatId,
      telegram_message_id: result.telegramMessageId
    });
    return { sent: true };
  }

  await store.markCashoutNotificationDeliveryFailed({
    deliveryId: row.id,
    error: result.error,
    permanent: Boolean(result.permanent),
    maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS
  });

  if (result.permanent && typeof store.markSupportNotificationDelivery === 'function') {
    await store.markSupportNotificationDelivery(chatId, {
      status: 'failed',
      error: result.error,
      deactivate: true
    }).catch(() => null);
  }

  console.warn('[cashout-telegram] send_failure', {
    task_id: task.taskId,
    telegram_chat_id: chatId,
    permanent: Boolean(result.permanent),
    error: result.error
  });

  return { failed: true, permanent: Boolean(result.permanent) };
}

async function editOneDelivery({
  store,
  task,
  delivery,
  outboxId = null,
  env,
  fetchImpl,
  editMessage = editCashoutNotificationMessage
}) {
  const chatId = String(delivery.telegram_chat_id || '').trim();
  const messageId = Number(delivery.telegram_message_id);

  console.log('[cashout-telegram] edit_attempt', {
    task_id: task.taskId,
    delivery_id: delivery.id,
    telegram_chat_id: chatId,
    telegram_message_id: messageId,
    authoritative_status: task.status || null
  });

  const result = await editMessage({
    chatId,
    messageId,
    task,
    env,
    fetchImpl,
    viewerTelegramUserId: delivery.telegram_user_id || null
  });

  if (result.ok) {
    await store.markCashoutNotificationDeliveryEdited({
      deliveryId: delivery.id,
      outboxId
    });
    if (result.unchanged) {
      console.log('[cashout-telegram] edit_skipped_identical', {
        task_id: task.taskId,
        delivery_id: delivery.id,
        telegram_chat_id: chatId
      });
    } else {
      console.log('[cashout-telegram] edit_success', {
        task_id: task.taskId,
        delivery_id: delivery.id,
        telegram_chat_id: chatId,
        authoritative_status: task.status || null
      });
    }
    return { edited: true, unchanged: Boolean(result.unchanged) };
  }

  await store.markCashoutNotificationDeliveryEditFailed({
    deliveryId: delivery.id,
    error: result.error,
    permanent: Boolean(result.permanent),
    maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS
  });

  const attempts = Number(delivery.attempt_count || 0) + 1;
  if (result.permanent || attempts >= CASHOUT_TELEGRAM_MAX_ATTEMPTS) {
    console.warn('[cashout-telegram] edit_retry_exhausted', {
      task_id: task.taskId,
      delivery_id: delivery.id,
      telegram_chat_id: chatId,
      attempt_count: attempts,
      permanent: Boolean(result.permanent)
    });
  }

  if (result.messageMissing) {
    console.warn('[cashout-telegram] edit_message_missing', {
      task_id: task.taskId,
      delivery_id: delivery.id,
      telegram_chat_id: chatId
    });
  } else {
    console.warn('[cashout-telegram] edit_failed', {
      task_id: task.taskId,
      delivery_id: delivery.id,
      telegram_chat_id: chatId,
      permanent: Boolean(result.permanent),
      error: result.error
    });
  }

  return { failed: true, permanent: Boolean(result.permanent) };
}

/**
 * Immediately re-edit all existing delivery copies from CURRENT AppBeg task.
 * Used after Telegram CLAIM success; Phase 4 outbox remains durable fallback.
 */
export async function refreshCashoutTelegramCardsForTask({
  store,
  task,
  env = process.env,
  fetchImpl = fetch,
  editMessage = editCashoutNotificationMessage,
  outboxId = null
} = {}) {
  if (!task?.taskId) {
    return { ok: false, edited: 0, failed: 0 };
  }
  const deliveries = await store.listEditableCashoutNotificationDeliveriesByTask(task.taskId);
  console.log('[cashout-telegram] immediate_refresh', {
    task_id: task.taskId,
    status: task.status || null,
    count: deliveries.length
  });

  let edited = 0;
  let failed = 0;
  for (const delivery of deliveries) {
    const outcome = await editOneDelivery({
      store,
      task,
      delivery,
      outboxId,
      env,
      fetchImpl,
      editMessage
    });
    if (outcome.edited) edited += 1;
    else if (outcome.failed) failed += 1;
  }
  return { ok: true, edited, failed };
}

export async function processCashoutTaskCreatedEvent({
  store,
  event,
  env = process.env,
  fetchImpl = fetch,
  fetchTask = fetchCashoutTaskForNotification,
  sendMessage = sendCashoutNotificationToChat,
  listSubscribers = null
} = {}) {
  const taskId = payloadTaskId(event);
  const eventCoadminUid = payloadCoadminUid(event);
  const outboxId = Number(event?.outboxId || 0);

  console.log('[cashout-telegram] outbox_event_received', {
    outbox_id: outboxId,
    event_type: event?.eventType || null,
    task_id: taskId || null,
    coadmin_uid: eventCoadminUid || null
  });

  if (!taskId) {
    console.warn('[cashout-telegram] missing_task_id', { outbox_id: outboxId });
    return { ok: false, reason: 'missing_task_id' };
  }

  const taskResult = await fetchTask(taskId, { env, fetchImpl });
  if (!taskResult.ok) {
    console.warn('[cashout-telegram] task_fetch_failed', {
      task_id: taskId,
      reason: taskResult.reason
    });
    return { ok: false, reason: `task_${taskResult.reason}` };
  }

  const task = taskResult.task;
  console.log('[cashout-telegram] task_fetched', {
    task_id: task.taskId,
    coadmin_uid: task.coadminUid || null,
    status: task.status || null
  });

  if (!task.coadminUid) {
    console.warn('[cashout-telegram] cross_tenant_protection', {
      task_id: task.taskId,
      reason: 'task_missing_coadmin_uid'
    });
    return { ok: true, reason: 'no_coadmin', sent: 0 };
  }

  if (eventCoadminUid && eventCoadminUid !== task.coadminUid) {
    console.warn('[cashout-telegram] cross_tenant_protection', {
      task_id: task.taskId,
      event_coadmin_uid: eventCoadminUid,
      task_coadmin_uid: task.coadminUid
    });
    return { ok: true, reason: 'tenant_mismatch', sent: 0 };
  }

  const listFn = listSubscribers
    || ((uid) => store.listActiveSupportNotificationSubscribersByCoadmin(uid));
  const subscribers = await listFn(task.coadminUid);
  const eligible = (subscribers || []).filter((sub) => {
    const chatId = String(sub.telegram_chat_id || '').trim();
    const owner = String(sub.coadmin_uid || '').trim();
    return Boolean(
      chatId
      && owner
      && owner === task.coadminUid
      && sub.is_active
      && !sub.disabled_by_coadmin
    );
  });

  console.log('[cashout-telegram] eligible_subscribers', {
    task_id: task.taskId,
    coadmin_uid: task.coadminUid,
    count: eligible.length
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const subscriber of eligible) {
    const outcome = await deliverToSubscriber({
      store,
      task,
      subscriber,
      outboxId,
      eventType: event.eventType || CASHOUT_TELEGRAM_CREATE_EVENT,
      env,
      fetchImpl,
      sendMessage
    });
    if (outcome.sent) sent += 1;
    else if (outcome.failed) failed += 1;
    else skipped += 1;
  }

  return { ok: true, sent, failed, skipped, eligible: eligible.length, task };
}

/**
 * Phase 4: sync already-delivered Telegram cards to CURRENT AppBeg task state.
 * Never creates new notifications for late enrollees.
 * Edit failures do not block outbox checkpoint advancement.
 */
export async function processCashoutStateSyncEvent({
  store,
  event,
  env = process.env,
  fetchImpl = fetch,
  fetchTask = fetchCashoutTaskForNotification,
  editMessage = editCashoutNotificationMessage
} = {}) {
  const taskId = payloadTaskId(event);
  const eventCoadminUid = payloadCoadminUid(event);
  const outboxId = Number(event?.outboxId || 0);
  const eventType = String(event?.eventType || '').trim();

  console.log('[cashout-telegram] outbox_state_event_received', {
    outbox_id: outboxId,
    event_type: eventType || null,
    task_id: taskId || null,
    coadmin_uid: eventCoadminUid || null
  });

  if (!taskId) {
    console.warn('[cashout-telegram] missing_task_id', { outbox_id: outboxId });
    return { ok: false, reason: 'missing_task_id' };
  }

  const taskResult = await fetchTask(taskId, { env, fetchImpl });
  if (!taskResult.ok) {
    console.warn('[cashout-telegram] task_fetch_failed', {
      task_id: taskId,
      reason: taskResult.reason
    });
    return { ok: false, reason: `task_${taskResult.reason}` };
  }

  const task = taskResult.task;
  console.log('[cashout-telegram] authoritative_task_status', {
    task_id: task.taskId,
    status: task.status || null,
    event_type: eventType || null
  });

  if (eventCoadminUid && task.coadminUid && eventCoadminUid !== task.coadminUid) {
    console.warn('[cashout-telegram] cross_tenant_protection', {
      task_id: task.taskId,
      event_coadmin_uid: eventCoadminUid,
      task_coadmin_uid: task.coadminUid
    });
    return { ok: true, reason: 'tenant_mismatch', edited: 0 };
  }

  const deliveries = await store.listEditableCashoutNotificationDeliveriesByTask(task.taskId);
  console.log('[cashout-telegram] delivery_copies_found', {
    task_id: task.taskId,
    count: deliveries.length
  });

  if (!deliveries.length) {
    console.log('[cashout-telegram] zero_deliveries_for_task', {
      task_id: task.taskId,
      event_type: eventType || null
    });
    return { ok: true, edited: 0, failed: 0, skipped: 0, task };
  }

  let edited = 0;
  let failed = 0;
  for (const delivery of deliveries) {
    const outcome = await editOneDelivery({
      store,
      task,
      delivery,
      outboxId,
      env,
      fetchImpl,
      editMessage
    });
    if (outcome.edited) edited += 1;
    else if (outcome.failed) failed += 1;
  }

  return { ok: true, edited, failed, task };
}

export async function processCashoutOutboxBatch({
  store,
  env = process.env,
  fetchImpl = fetch,
  fetchOutbox = fetchCashoutOutboxEvents,
  fetchTask = fetchCashoutTaskForNotification,
  sendMessage = sendCashoutNotificationToChat,
  editMessage = editCashoutNotificationMessage,
  limit = 50
} = {}) {
  if (!isCashoutTelegramNotificationsEnabled(env)) {
    return { ok: true, skipped: true, reason: 'feature_disabled' };
  }
  if (!isCashoutOutboxClientConfigured(env)) {
    return { ok: false, reason: 'not_configured' };
  }

  const checkpoint = await ensureCashoutOutboxCheckpoint(store, { env, fetchImpl, fetchOutbox });
  const after = Number(checkpoint.lastProcessedOutboxId || 0);

  const poll = await fetchOutbox({ afterOutboxId: after, limit, env, fetchImpl });
  if (!poll.ok) {
    return { ok: false, reason: poll.reason || 'poll_failed' };
  }

  const events = poll.events || [];
  let processed = 0;
  let lastId = after;

  for (const event of events) {
    const outboxId = Number(event.outboxId || 0);
    if (!outboxId || outboxId <= lastId) continue;

    const eventType = String(event.eventType || '').trim();
    let result = { ok: true };

    if (eventType === CASHOUT_TELEGRAM_CREATE_EVENT) {
      result = await processCashoutTaskCreatedEvent({
        store,
        event,
        env,
        fetchImpl,
        fetchTask,
        sendMessage
      });
    } else if (CASHOUT_TELEGRAM_STATE_EVENTS.has(eventType)) {
      result = await processCashoutStateSyncEvent({
        store,
        event,
        env,
        fetchImpl,
        fetchTask,
        editMessage
      });
    }

    // Transient AppBeg task fetch failures: hold checkpoint.
    // Telegram edit/send failures: advance (durable retry separately).
    if (!result.ok && isTransientTaskFetchFailure(result.reason)) {
      console.warn('[cashout-telegram] checkpoint_held', {
        outbox_id: outboxId,
        reason: result.reason
      });
      break;
    }

    await store.upsertCashoutOutboxConsumerState({
      consumerName: CASHOUT_TELEGRAM_CONSUMER_NAME,
      lastProcessedOutboxId: outboxId
    });
    lastId = outboxId;
    processed += 1;
  }

  return {
    ok: true,
    processed,
    lastProcessedOutboxId: lastId,
    polled: events.length
  };
}

export async function retryFailedCashoutNotificationDeliveries({
  store,
  env = process.env,
  fetchImpl = fetch,
  fetchTask = fetchCashoutTaskForNotification,
  sendMessage = sendCashoutNotificationToChat,
  editMessage = editCashoutNotificationMessage,
  limit = 25,
  nowMs = Date.now()
} = {}) {
  if (!isCashoutTelegramNotificationsEnabled(env)) {
    return { ok: true, skipped: true, reason: 'feature_disabled' };
  }

  const rows = await store.listRetryableCashoutNotificationDeliveries({
    maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS,
    olderThanIso: new Date(nowMs - CASHOUT_TELEGRAM_RETRY_COOLDOWN_MS).toISOString(),
    limit
  });

  let retried = 0;
  let sent = 0;
  let edited = 0;
  let failed = 0;

  for (const row of rows) {
    retried += 1;
    const isEditRetry = row.delivery_status === 'edit_failed' && row.telegram_message_id != null;
    console.log('[cashout-telegram] retry', {
      delivery_id: row.id,
      task_id: row.appbeg_cashout_task_id,
      kind: isEditRetry ? 'edit' : 'send',
      attempt: Number(row.attempt_count || 0) + 1
    });

    const taskResult = await fetchTask(row.appbeg_cashout_task_id, { env, fetchImpl });
    if (!taskResult.ok) {
      const marker = isEditRetry
        ? store.markCashoutNotificationDeliveryEditFailed
        : store.markCashoutNotificationDeliveryFailed;
      await marker.call(store, {
        deliveryId: row.id,
        error: `task_${taskResult.reason}`,
        permanent: taskResult.reason === 'not_found',
        maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS
      });
      failed += 1;
      continue;
    }

    const task = taskResult.task;
    if (task.coadminUid && row.coadmin_uid && task.coadminUid !== row.coadmin_uid) {
      console.warn('[cashout-telegram] cross_tenant_protection', {
        delivery_id: row.id,
        task_id: task.taskId
      });
      const marker = isEditRetry
        ? store.markCashoutNotificationDeliveryEditFailed
        : store.markCashoutNotificationDeliveryFailed;
      await marker.call(store, {
        deliveryId: row.id,
        error: 'tenant_mismatch',
        permanent: true,
        maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS
      });
      failed += 1;
      continue;
    }

    if (isEditRetry) {
      const outcome = await editOneDelivery({
        store,
        task,
        delivery: row,
        outboxId: null,
        env,
        fetchImpl,
        editMessage
      });
      if (outcome.edited) edited += 1;
      else failed += 1;
      continue;
    }

    const result = await sendMessage({
      chatId: row.telegram_chat_id,
      task,
      env,
      fetchImpl
    });

    if (result.ok) {
      await store.markCashoutNotificationDeliverySent({
        deliveryId: row.id,
        telegramMessageId: result.telegramMessageId
      });
      sent += 1;
      continue;
    }

    await store.markCashoutNotificationDeliveryFailed({
      deliveryId: row.id,
      error: result.error,
      permanent: Boolean(result.permanent),
      maxAttempts: CASHOUT_TELEGRAM_MAX_ATTEMPTS
    });
    if (result.permanent && typeof store.markSupportNotificationDelivery === 'function') {
      await store.markSupportNotificationDelivery(row.telegram_chat_id, {
        status: 'failed',
        error: result.error,
        deactivate: true
      }).catch(() => null);
    }
    failed += 1;
  }

  return { ok: true, retried, sent, edited, failed };
}

export async function processCashoutTelegramNotificationTick({
  store,
  env = process.env,
  fetchImpl = fetch,
  fetchOutbox = fetchCashoutOutboxEvents,
  fetchTask = fetchCashoutTaskForNotification,
  sendMessage = sendCashoutNotificationToChat,
  editMessage = editCashoutNotificationMessage
} = {}) {
  const batch = await processCashoutOutboxBatch({
    store,
    env,
    fetchImpl,
    fetchOutbox,
    fetchTask,
    sendMessage,
    editMessage
  });
  const retries = await retryFailedCashoutNotificationDeliveries({
    store,
    env,
    fetchImpl,
    fetchTask,
    sendMessage,
    editMessage
  });
  return { batch, retries };
}

export function startCashoutTelegramNotificationWorker({
  store,
  env = process.env,
  pollMs = null,
  fetchImpl = fetch
} = {}) {
  try {
    const gates = resolveCashoutTelegramFeatureGates(env);
    if (!gates.notificationsEnabled) {
      console.log('[cashout-telegram] worker disabled (notifications effective=false)');
      return { stop: async () => {} };
    }

    const configuredPoll = pollMs == null
      ? Number(env.CASHOUT_TELEGRAM_NOTIFICATION_POLL_MS || 5000)
      : Number(pollMs);
    const safePollMs = Number.isFinite(configuredPoll) && configuredPoll >= 1000
      ? configuredPoll
      : 5000;

    let stopped = false;
    let tickPromise = null;

    console.log(`[cashout-telegram] worker_started poll_ms=${safePollMs}`);

    if (store && typeof store.getCashoutOutboxConsumerState === 'function') {
      void store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME)
        .then((state) => {
          console.log('[cashout-telegram] consumer checkpoint =', Number(state?.last_processed_outbox_id || 0));
        })
        .catch(() => {
          console.log('[cashout-telegram] consumer checkpoint = unknown');
        });
    }

    async function tick() {
      if (stopped) return;
      try {
        // Re-check gates each tick so misconfiguration never keeps polling AppBeg loudly.
        const live = resolveCashoutTelegramFeatureGates(env);
        if (!live.notificationsEnabled) {
          return;
        }
        await processCashoutTelegramNotificationTick({ store, env, fetchImpl });
      } catch (error) {
        console.error('[cashout-telegram] worker_tick_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const timer = setInterval(() => {
      if (tickPromise) return;
      tickPromise = tick().finally(() => {
        tickPromise = null;
      });
    }, safePollMs);

    tickPromise = tick().finally(() => {
      tickPromise = null;
    });

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        if (tickPromise) await tickPromise;
        console.log('[cashout-telegram] worker_stopped');
      }
    };
  } catch (error) {
    console.warn('[cashout-telegram] worker_start_failed_optional', {
      error: error instanceof Error ? error.message : String(error)
    });
    return { stop: async () => {} };
  }
}
