import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup,
  normalizeCashoutTaskStatus
} from '../src/telegram/cashoutNotificationCards.js';
import {
  CASHOUT_TELEGRAM_CONSUMER_NAME,
  processCashoutOutboxBatch,
  processCashoutStateSyncEvent,
  processCashoutTaskCreatedEvent,
  retryFailedCashoutNotificationDeliveries
} from '../src/telegram/cashoutTelegramNotificationWorker.js';

function makeTask(overrides = {}) {
  return {
    taskId: 'task-sync01',
    coadminUid: 'coadmin-a',
    playerUsername: 'player_one',
    amountNpr: 2500,
    payoutMethod: 'qr',
    paymentAppName: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    status: 'pending',
    expiresAt: null,
    assignedHandlerUsername: null,
    startedAt: null,
    completedAt: null,
    vendorCode: null,
    vendorName: null,
    ...overrides
  };
}

function makeEvent(overrides = {}) {
  const taskId = overrides.entityId || overrides.payload?.taskId || 'task-sync01';
  return {
    outboxId: 1000,
    channel: 'coadmin:coadmin-a:cashouts',
    eventType: 'cashout_task_created',
    entityType: 'player_cashout_task',
    entityId: taskId,
    payload: {
      taskId,
      coadminUid: 'coadmin-a',
      status: 'pending',
      amountNpr: 2500,
      source: 'authority'
    },
    ...overrides,
    payload: {
      taskId,
      coadminUid: 'coadmin-a',
      status: 'pending',
      amountNpr: 2500,
      source: 'authority',
      ...(overrides.payload || {})
    }
  };
}

async function enroll(store, { userId, chatId, coadminUid }) {
  const result = await store.enrollSupportNotificationSubscriber({
    telegramChatId: String(chatId),
    telegramUserId: String(userId),
    coadminUid,
    telegramUsername: `u${userId}`,
    telegramDisplayName: `User ${userId}`
  });
  assert.equal(result.ok, true);
  return result;
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cashout-state-sync-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  const env = {
    CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'test-token',
    SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-token'
  };

  // --- CARD STATES ---
  assert.equal(normalizeCashoutTaskStatus('in_progress'), 'in_progress');
  assert.deepEqual(buildCashoutNotificationReplyMarkup(), { inline_keyboard: [] });

  const pendingCard = buildCashoutNotificationCard(makeTask({ status: 'pending' }));
  assert.match(pendingCard, /Status: 🟡 PENDING/);
  assert.doesNotMatch(pendingCard, /Handler:/);
  assert.doesNotMatch(pendingCard, /Claim expires/);

  const inProgressCard = buildCashoutNotificationCard(makeTask({
    status: 'in_progress',
    assignedHandlerUsername: 'staff_alice',
    expiresAt: '2099-01-01T13:42:00.000Z'
  }), { timeZone: 'UTC' });
  assert.match(inProgressCard, /Status: 🟠 IN PROGRESS/);
  assert.match(inProgressCard, /Handler: staff_alice/);
  assert.match(inProgressCard, /Claim expires:/);
  assert.doesNotMatch(inProgressCard, /Claim\b(?! expires)/);
  assert.doesNotMatch(inProgressCard, /Done/i);

  const inProgressNoHandler = buildCashoutNotificationCard(makeTask({
    status: 'in_progress',
    assignedHandlerUsername: null,
    expiresAt: '2099-01-01T13:42:00.000Z'
  }));
  assert.match(inProgressNoHandler, /Status: 🟠 IN PROGRESS/);
  assert.doesNotMatch(inProgressNoHandler, /Handler:/);

  const completedCard = buildCashoutNotificationCard(makeTask({
    status: 'completed',
    assignedHandlerUsername: 'staff_alice',
    completedAt: '2026-08-08T12:05:00.000Z'
  }));
  assert.match(completedCard, /Status: 🟢 COMPLETED/);
  assert.match(completedCard, /Handler: staff_alice/);
  assert.match(completedCard, /Completed:/);

  const declinedCard = buildCashoutNotificationCard(makeTask({ status: 'declined' }));
  assert.match(declinedCard, /Status: 🔴 DECLINED/);
  assert.doesNotMatch(declinedCard, /refund/i);

  const releasedCard = buildCashoutNotificationCard(makeTask({
    status: 'pending',
    assignedHandlerUsername: null,
    expiresAt: null
  }));
  assert.match(releasedCard, /Status: 🟡 PENDING/);
  assert.doesNotMatch(releasedCard, /Handler:/);
  assert.doesNotMatch(releasedCard, /Claim expires/);

  // --- SETUP 3 SUBSCRIBERS ---
  await enroll(store, { userId: 11, chatId: 111, coadminUid: 'coadmin-a' });
  await enroll(store, { userId: 12, chatId: 112, coadminUid: 'coadmin-a' });
  await enroll(store, { userId: 13, chatId: 113, coadminUid: 'coadmin-a' });

  const sentBodies = [];
  let taskState = makeTask({ status: 'pending' });

  await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({ outboxId: 1001 }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    sendMessage: async ({ chatId, task }) => {
      const text = buildCashoutNotificationCard(task);
      sentBodies.push({ chatId: String(chatId), text, messageId: Number(chatId) + 9000 });
      return {
        ok: true,
        telegramMessageId: Number(chatId) + 9000,
        permanent: false,
        error: null
      };
    }
  });

  let deliveries = await store.listEditableCashoutNotificationDeliveriesByTask('task-sync01');
  assert.equal(deliveries.length, 3);
  assert.ok(deliveries.every((d) => d.delivery_status === 'sent' && d.telegram_message_id));

  const edits = [];
  const editMessage = async ({ chatId, messageId, task }) => {
    const text = buildCashoutNotificationCard(task);
    edits.push({
      chatId: String(chatId),
      messageId: Number(messageId),
      text,
      status: task.status
    });
    return { ok: true, unchanged: false, permanent: false, error: null };
  };

  // 1–3: cashout_start → IN PROGRESS with handler + expires
  taskState = makeTask({
    status: 'in_progress',
    assignedHandlerUsername: 'staff_alice',
    expiresAt: '2099-01-01T13:42:00.000Z',
    startedAt: '2026-08-08T12:01:00.000Z'
  });
  const startResult = await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1002,
      eventType: 'cashout_start',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'in_progress' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage
  });
  assert.equal(startResult.edited, 3);
  assert.equal(edits.length, 3);
  assert.ok(edits.every((e) => /Status: 🟠 IN PROGRESS/.test(e.text)));
  assert.ok(edits.every((e) => /Handler: staff_alice/.test(e.text)));
  assert.ok(edits.every((e) => /Claim expires:/.test(e.text)));
  assert.deepEqual(
    edits.map((e) => e.messageId).sort(),
    [9111, 9112, 9113]
  );

  // Idempotent reprocess of start with identical content → success
  const identicalEdits = [];
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1002,
      eventType: 'cashout_start',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'in_progress' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage: async ({ chatId, messageId, task }) => {
      identicalEdits.push(String(chatId));
      return { ok: true, unchanged: true, permanent: false, error: null };
    }
  });
  assert.equal(identicalEdits.length, 3);
  assert.equal(
    (await store.listCashoutNotificationDeliveriesByTask('task-sync01')).length,
    3
  );

  // 7–8 / 21–22: release → PENDING, no handler/expiry
  taskState = makeTask({ status: 'pending', assignedHandlerUsername: null, expiresAt: null });
  edits.length = 0;
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1003,
      eventType: 'cashout_release',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'pending' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage
  });
  assert.equal(edits.length, 3);
  assert.ok(edits.every((e) => /Status: 🟡 PENDING/.test(e.text)));
  assert.ok(edits.every((e) => !/Handler:/.test(e.text)));
  assert.ok(edits.every((e) => !/Claim expires:/.test(e.text)));

  // start again then timeout release
  taskState = makeTask({
    status: 'in_progress',
    assignedHandlerUsername: 'staff_bob',
    expiresAt: '2099-01-01T14:00:00.000Z'
  });
  edits.length = 0;
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1004,
      eventType: 'cashout_start',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'in_progress' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage
  });
  taskState = makeTask({ status: 'pending' });
  edits.length = 0;
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1005,
      eventType: 'cashout_timeout_release',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'pending' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage
  });
  assert.ok(edits.every((e) => /Status: 🟡 PENDING/.test(e.text)));

  // 4–5: complete
  taskState = makeTask({
    status: 'completed',
    assignedHandlerUsername: 'staff_alice',
    completedAt: '2026-08-08T12:10:00.000Z'
  });
  edits.length = 0;
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1006,
      eventType: 'cashout_complete',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'completed' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: { ...taskState } }),
    editMessage
  });
  assert.equal(edits.length, 3);
  assert.ok(edits.every((e) => /Status: 🟢 COMPLETED/.test(e.text)));
  assert.ok(edits.every((e) => /Completed:/.test(e.text)));

  // 6: decline on a fresh task
  await enroll(store, { userId: 21, chatId: 211, coadminUid: 'coadmin-a' });
  const declineTaskId = 'task-decline';
  await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({
      outboxId: 1100,
      entityId: declineTaskId,
      payload: { taskId: declineTaskId, coadminUid: 'coadmin-a', status: 'pending' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: declineTaskId, status: 'pending' }) }),
    sendMessage: async ({ chatId }) => ({
      ok: true,
      telegramMessageId: Number(chatId) + 8000,
      permanent: false,
      error: null
    })
  });
  // Only one active eligible for new send among existing; list will include previous A subscribers too.
  // Disable extras for cleaner decline assertion on decline task deliveries only.
  const declineDeliveriesBefore = await store.listEditableCashoutNotificationDeliveriesByTask(declineTaskId);
  assert.ok(declineDeliveriesBefore.length >= 1);

  const declineEdits = [];
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1101,
      entityId: declineTaskId,
      eventType: 'cashout_decline',
      payload: { taskId: declineTaskId, coadminUid: 'coadmin-a', status: 'declined' }
    }),
    env,
    fetchTask: async () => ({
      ok: true,
      task: makeTask({ taskId: declineTaskId, status: 'declined' })
    }),
    editMessage: async ({ chatId, messageId, task }) => {
      declineEdits.push({
        chatId: String(chatId),
        messageId: Number(messageId),
        text: buildCashoutNotificationCard(task)
      });
      return { ok: true, unchanged: false, permanent: false, error: null };
    }
  });
  assert.equal(declineEdits.length, declineDeliveriesBefore.length);
  assert.ok(declineEdits.every((e) => /Status: 🔴 DECLINED/.test(e.text)));

  // 11: one edit fails; others succeed
  const partialTaskId = 'task-partial-edit';
  await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({
      outboxId: 1200,
      entityId: partialTaskId,
      payload: { taskId: partialTaskId, coadminUid: 'coadmin-a' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: partialTaskId }) }),
    sendMessage: async ({ chatId }) => ({
      ok: true,
      telegramMessageId: Number(chatId) + 7000,
      permanent: false,
      error: null
    })
  });
  const partialBefore = await store.listEditableCashoutNotificationDeliveriesByTask(partialTaskId);
  assert.ok(partialBefore.length >= 2);
  const failChat = String(partialBefore[0].telegram_chat_id);
  const partialResult = await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1201,
      entityId: partialTaskId,
      eventType: 'cashout_start',
      payload: { taskId: partialTaskId, coadminUid: 'coadmin-a', status: 'in_progress' }
    }),
    env,
    fetchTask: async () => ({
      ok: true,
      task: makeTask({
        taskId: partialTaskId,
        status: 'in_progress',
        assignedHandlerUsername: 'staff_x'
      })
    }),
    editMessage: async ({ chatId }) => {
      if (String(chatId) === failChat) {
        return { ok: false, permanent: false, error: 'network_error' };
      }
      return { ok: true, unchanged: false, permanent: false, error: null };
    }
  });
  assert.equal(partialResult.failed, 1);
  assert.equal(partialResult.edited, partialBefore.length - 1);
  const partialAfter = await store.listCashoutNotificationDeliveriesByTask(partialTaskId);
  assert.equal(partialAfter.filter((r) => r.delivery_status === 'edit_failed').length, 1);
  assert.equal(partialAfter.filter((r) => r.delivery_status === 'sent').length, partialBefore.length - 1);

  // 15–16 OUT OF ORDER: cashout_start processed after task already completed → COMPLETED
  const oooTaskId = 'task-ooo';
  await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({
      outboxId: 1300,
      entityId: oooTaskId,
      payload: { taskId: oooTaskId, coadminUid: 'coadmin-a' }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: oooTaskId }) }),
    sendMessage: async ({ chatId }) => ({
      ok: true,
      telegramMessageId: Number(chatId) + 6000,
      permanent: false,
      error: null
    })
  });
  const oooEdits = [];
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1301,
      entityId: oooTaskId,
      eventType: 'cashout_start',
      payload: { taskId: oooTaskId, coadminUid: 'coadmin-a', status: 'in_progress' }
    }),
    env,
    fetchTask: async () => ({
      ok: true,
      task: makeTask({
        taskId: oooTaskId,
        status: 'completed',
        assignedHandlerUsername: 'staff_alice',
        completedAt: '2026-08-08T12:20:00.000Z'
      })
    }),
    editMessage: async ({ chatId, messageId, task }) => {
      oooEdits.push(buildCashoutNotificationCard(task));
      return { ok: true, unchanged: false, permanent: false, error: null };
    }
  });
  assert.ok(oooEdits.length >= 1);
  assert.ok(oooEdits.every((t) => /Status: 🟢 COMPLETED/.test(t)));
  assert.ok(oooEdits.every((t) => !/IN PROGRESS/.test(t)));

  // 17–20: edit_failed retry fetches CURRENT task (completed, not stale in_progress)
  await store.db.prepare(`
    UPDATE cashout_notification_deliveries
    SET updated_at = ?
    WHERE appbeg_cashout_task_id = ? AND delivery_status = 'edit_failed'
  `).run('2000-01-01T00:00:00.000Z', partialTaskId);

  const retryTexts = [];
  const retryResult = await retryFailedCashoutNotificationDeliveries({
    store,
    env,
    nowMs: Date.now(),
    fetchTask: async () => ({
      ok: true,
      task: makeTask({
        taskId: partialTaskId,
        status: 'completed',
        assignedHandlerUsername: 'staff_x',
        completedAt: '2026-08-08T12:30:00.000Z'
      })
    }),
    editMessage: async ({ task }) => {
      retryTexts.push(buildCashoutNotificationCard(task));
      return { ok: true, unchanged: false, permanent: false, error: null };
    }
  });
  assert.equal(retryResult.edited, 1);
  assert.ok(retryTexts.every((t) => /Status: 🟢 COMPLETED/.test(t)));
  const afterRetry = await store.listCashoutNotificationDeliveriesByTask(partialTaskId);
  assert.equal(afterRetry.every((r) => r.delivery_status === 'sent'), true);

  // 23–24: only deliveries for this task edited; no cross-task
  const otherTaskRows = await store.listCashoutNotificationDeliveriesByTask('task-sync01');
  assert.ok(otherTaskRows.every((r) => r.appbeg_cashout_task_id === 'task-sync01'));

  // New subscriber after create: no backfill on state event
  await enroll(store, { userId: 99, chatId: 999, coadminUid: 'coadmin-a' });
  const beforeLate = await store.listEditableCashoutNotificationDeliveriesByTask('task-sync01');
  await processCashoutStateSyncEvent({
    store,
    event: makeEvent({
      outboxId: 1400,
      eventType: 'cashout_complete',
      payload: { taskId: 'task-sync01', coadminUid: 'coadmin-a', status: 'completed' }
    }),
    env,
    fetchTask: async () => ({
      ok: true,
      task: makeTask({
        taskId: 'task-sync01',
        status: 'completed',
        completedAt: '2026-08-08T12:40:00.000Z'
      })
    }),
    editMessage: async () => ({ ok: true, unchanged: false, permanent: false, error: null })
  });
  const afterLate = await store.listEditableCashoutNotificationDeliveriesByTask('task-sync01');
  assert.equal(afterLate.length, beforeLate.length);
  assert.equal(afterLate.some((r) => String(r.telegram_chat_id) === '999'), false);

  // Checkpoint advances despite edit failure
  await store.upsertCashoutOutboxConsumerState({
    consumerName: CASHOUT_TELEGRAM_CONSUMER_NAME,
    lastProcessedOutboxId: 2000
  });
  let latestOutboxId = 2002;
  const outboxEvents = [
    makeEvent({
      outboxId: 2001,
      entityId: 'task-cp',
      eventType: 'cashout_start',
      payload: { taskId: 'task-cp', coadminUid: 'coadmin-a', status: 'in_progress' }
    })
  ];
  // Seed one delivery for task-cp
  await store.ensureCashoutNotificationDelivery({
    appbegCashoutTaskId: 'task-cp',
    coadminUid: 'coadmin-a',
    telegramChatId: '111',
    outboxId: 1999,
    eventType: 'cashout_task_created'
  });
  const seeded = await store.getCashoutNotificationDeliveryByTaskAndChat('task-cp', '111');
  await store.markCashoutNotificationDeliverySent({
    deliveryId: seeded.id,
    telegramMessageId: 555
  });

  const batch = await processCashoutOutboxBatch({
    store,
    env,
    fetchOutbox: async ({ afterOutboxId }) => ({
      ok: true,
      afterOutboxId,
      latestOutboxId,
      events: outboxEvents.filter((e) => e.outboxId > afterOutboxId)
    }),
    fetchTask: async () => ({
      ok: true,
      task: makeTask({ taskId: 'task-cp', status: 'in_progress', assignedHandlerUsername: 'h' })
    }),
    editMessage: async () => ({ ok: false, permanent: false, error: 'network_error' })
  });
  assert.equal(batch.processed, 1);
  const cpState = await store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME);
  assert.equal(Number(cpState.last_processed_outbox_id), 2001);
  const cpDelivery = await store.getCashoutNotificationDeliveryByTaskAndChat('task-cp', '111');
  assert.equal(cpDelivery.delivery_status, 'edit_failed');

  // Authority: no cash-out business status column
  assert.ok(!('cashout_status' in (deliveries[0] || {})));
  assert.ok(['pending', 'sent', 'failed', 'edit_failed'].includes(cpDelivery.delivery_status));

  // Phase boundary: no claim/done modules introduced in Phase 4
  assert.deepEqual(buildCashoutNotificationReplyMarkup({ status: 'pending', taskId: 'x' }, { claimEnabled: false }), {
    inline_keyboard: []
  });

  console.log('PASS: Phase 4 cash-out Telegram state sync tests');
  await store.db.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
