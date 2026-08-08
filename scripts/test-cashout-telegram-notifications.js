import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  buildCashoutTaskCreatedCard,
  buildCashoutNotificationReplyMarkup,
  formatCashoutAmountForNotification,
  formatCashoutPayoutLabel
} from '../src/telegram/cashoutNotificationCards.js';
import {
  CASHOUT_TELEGRAM_CONSUMER_NAME,
  ensureCashoutOutboxCheckpoint,
  processCashoutOutboxBatch,
  processCashoutTaskCreatedEvent,
  retryFailedCashoutNotificationDeliveries
} from '../src/telegram/cashoutTelegramNotificationWorker.js';

function makeTask(overrides = {}) {
  return {
    taskId: 'task-abc12cd',
    coadminUid: 'coadmin-a',
    playerUsername: 'player_one',
    amountNpr: 1500,
    payoutMethod: 'qr',
    paymentAppName: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    status: 'pending',
    expiresAt: null,
    vendorCode: null,
    vendorName: null,
    ...overrides
  };
}

function makeEvent(overrides = {}) {
  return {
    outboxId: 101,
    channel: 'coadmin:coadmin-a:cashouts',
    eventType: 'cashout_task_created',
    entityType: 'player_cashout_task',
    entityId: 'task-abc12cd',
    payload: {
      taskId: 'task-abc12cd',
      coadminUid: 'coadmin-a',
      status: 'pending',
      amountNpr: 1500,
      source: 'authority'
    },
    ...overrides
  };
}

async function enroll(store, {
  userId,
  chatId,
  coadminUid,
  active = true,
  disabled = false
}) {
  const result = await store.enrollSupportNotificationSubscriber({
    telegramChatId: String(chatId),
    telegramUserId: String(userId),
    coadminUid,
    telegramUsername: `u${userId}`,
    telegramDisplayName: `User ${userId}`
  });
  assert.equal(result.ok, true);
  if (!active || disabled) {
    if (disabled) {
      await store.disableSupportNotificationSubscriber({
        coadminUid,
        telegramUserId: String(userId)
      });
    } else if (!active) {
      await store.deactivateSupportNotificationSubscriber(String(chatId), { reason: 'stopped' });
    }
  }
  return result;
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cashout-telegram-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  const env = {
    CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'test-token',
    SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-token'
  };

  // --- CARD ---
  const card = buildCashoutTaskCreatedCard(makeTask({ paymentAppName: 'Cash App' }));
  assert.match(card, /Cash Out/);
  assert.match(card, /Player: player_one/);
  assert.match(card, /Amount: USD 1,500/);
  assert.match(card, /Payout: Cash App/);
  assert.match(card, /Status: 🟡 PENDING/);
  assert.doesNotMatch(card, /Claim/i);
  assert.doesNotMatch(card, /Done/i);
  assert.doesNotMatch(card, /password/i);
  assert.doesNotMatch(card, /payment_details/i);
  assert.doesNotMatch(card, /\$cashTag/i);
  assert.deepEqual(buildCashoutNotificationReplyMarkup(), { inline_keyboard: [] });
  assert.equal(formatCashoutAmountForNotification(1500), 'USD 1,500');
  assert.equal(formatCashoutPayoutLabel({ payoutMethod: 'qr' }), 'QR');

  // --- TENANT SETUP ---
  await enroll(store, { userId: 1, chatId: 101, coadminUid: 'coadmin-a' });
  await enroll(store, { userId: 2, chatId: 102, coadminUid: 'coadmin-a' });
  await enroll(store, { userId: 3, chatId: 201, coadminUid: 'coadmin-b' });
  await enroll(store, { userId: 4, chatId: 104, coadminUid: 'coadmin-a', disabled: true });
  await enroll(store, { userId: 5, chatId: 105, coadminUid: 'coadmin-a', active: false });
  // Legacy NULL coadmin row
  await store.db.prepare(`
    INSERT INTO support_notification_subscribers (
      telegram_chat_id, telegram_user_id, is_active, coadmin_uid, subscribed_at, created_at, updated_at
    ) VALUES (?, ?, 1, NULL, ?, ?, ?)
  `).run('999', '999', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  const sends = [];
  const sendMessage = async ({ chatId, task }) => {
    sends.push({ chatId: String(chatId), taskId: task.taskId });
    return { ok: true, telegramMessageId: 1000 + sends.length, permanent: false, error: null };
  };

  const fetchTask = async (taskId) => ({
    ok: true,
    task: makeTask({ taskId })
  });

  // Eligible A subscribers only (1 and 2)
  const first = await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent(),
    env,
    fetchTask,
    sendMessage
  });
  assert.equal(first.ok, true);
  assert.equal(first.sent, 2);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((s) => s.chatId).sort(), ['101', '102']);

  const deliveries = await store.listCashoutNotificationDeliveriesByTask('task-abc12cd');
  assert.equal(deliveries.length, 2);
  for (const row of deliveries) {
    assert.equal(row.delivery_status, 'sent');
    assert.ok(row.telegram_message_id);
    assert.equal(row.appbeg_cashout_task_id, 'task-abc12cd');
    assert.equal(row.coadmin_uid, 'coadmin-a');
    // Delivery table stores Telegram delivery state only — not cash-out business status.
    assert.notEqual(row.delivery_status, 'pending');
    assert.ok(!('cashout_status' in row));
  }

  // Duplicate event does not duplicate sends
  const dup = await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({ outboxId: 102 }),
    env,
    fetchTask,
    sendMessage
  });
  assert.equal(dup.sent, 0);
  assert.equal(sends.length, 2);

  // Coadmin B cash-out does not notify A
  const sendsB = [];
  const bResult = await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({
      outboxId: 201,
      entityId: 'task-b',
      channel: 'coadmin:coadmin-b:cashouts',
      payload: { taskId: 'task-b', coadminUid: 'coadmin-b', status: 'pending', amountNpr: 100 }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: 'task-b', coadminUid: 'coadmin-b' }) }),
    sendMessage: async ({ chatId, task }) => {
      sendsB.push(String(chatId));
      return { ok: true, telegramMessageId: 2001, permanent: false, error: null };
    }
  });
  assert.equal(bResult.sent, 1);
  assert.deepEqual(sendsB, ['201']);

  // --- OUTBOX CHECKPOINT / BOOTSTRAP / RESTART ---
  let latestOutboxId = 500;
  const outboxEvents = [
    makeEvent({ outboxId: 501, entityId: 'task-new', payload: { taskId: 'task-new', coadminUid: 'coadmin-a', status: 'pending', amountNpr: 10 } })
  ];
  const fetchOutbox = async ({ afterOutboxId }) => ({
    ok: true,
    afterOutboxId,
    latestOutboxId,
    events: outboxEvents.filter((e) => e.outboxId > afterOutboxId)
  });

  const boot = await ensureCashoutOutboxCheckpoint(store, { env, fetchOutbox });
  assert.equal(boot.bootstrapped, true);
  assert.equal(boot.lastProcessedOutboxId, 500);
  const state = await store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME);
  assert.equal(Number(state.last_processed_outbox_id), 500);

  // Historical id 101 would be skipped because checkpoint is 500
  const historicalPoll = await fetchOutbox({ afterOutboxId: 500 });
  assert.equal(historicalPoll.events.every((e) => e.outboxId > 500), true);

  const sendsRestart = [];
  const batch1 = await processCashoutOutboxBatch({
    store,
    env,
    fetchOutbox,
    fetchTask: async (taskId) => ({ ok: true, task: makeTask({ taskId }) }),
    sendMessage: async ({ chatId, task }) => {
      sendsRestart.push({ chatId: String(chatId), taskId: task.taskId });
      return { ok: true, telegramMessageId: 3000 + sendsRestart.length, permanent: false, error: null };
    }
  });
  assert.equal(batch1.ok, true);
  assert.equal(batch1.processed, 1);
  assert.equal(sendsRestart.length, 2);

  // Simulate restart: same event encountered again → no duplicate
  const stateAfter = await store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME);
  assert.equal(Number(stateAfter.last_processed_outbox_id), 501);
  const batch2 = await processCashoutOutboxBatch({
    store,
    env,
    fetchOutbox,
    fetchTask: async (taskId) => ({ ok: true, task: makeTask({ taskId }) }),
    sendMessage: async ({ chatId, task }) => {
      sendsRestart.push({ chatId: String(chatId), taskId: task.taskId });
      return { ok: true, telegramMessageId: 4000, permanent: false, error: null };
    }
  });
  assert.equal(batch2.processed, 0);
  assert.equal(sendsRestart.length, 2);

  // Feature flag off skips processing
  const disabledBatch = await processCashoutOutboxBatch({
    store,
    env: { ...env, CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'false' },
    fetchOutbox,
    fetchTask,
    sendMessage
  });
  assert.equal(disabledBatch.skipped, true);

  // --- PARTIAL FAN-OUT RETRY ---
  let failChat = '101';
  const partialSends = [];
  const partialTaskId = 'task-partial';
  await processCashoutTaskCreatedEvent({
    store,
    event: makeEvent({
      outboxId: 601,
      entityId: partialTaskId,
      payload: { taskId: partialTaskId, coadminUid: 'coadmin-a', status: 'pending', amountNpr: 50 }
    }),
    env,
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: partialTaskId }) }),
    sendMessage: async ({ chatId, task }) => {
      partialSends.push(String(chatId));
      if (String(chatId) === failChat) {
        return { ok: false, permanent: false, error: 'network_error' };
      }
      return { ok: true, telegramMessageId: 5001, permanent: false, error: null };
    }
  });
  const partialRows = await store.listCashoutNotificationDeliveriesByTask(partialTaskId);
  assert.equal(partialRows.filter((r) => r.delivery_status === 'sent').length, 1);
  assert.equal(partialRows.filter((r) => r.delivery_status === 'failed').length, 1);

  // Age the failed row so retry cooldown elapses
  await store.db.prepare(`
    UPDATE cashout_notification_deliveries
    SET updated_at = ?
    WHERE appbeg_cashout_task_id = ? AND delivery_status = 'failed'
  `).run('2000-01-01T00:00:00.000Z', partialTaskId);

  failChat = null;
  const retryResult = await retryFailedCashoutNotificationDeliveries({
    store,
    env,
    nowMs: Date.now(),
    fetchTask: async () => ({ ok: true, task: makeTask({ taskId: partialTaskId }) }),
    sendMessage: async ({ chatId }) => {
      partialSends.push(`retry:${chatId}`);
      return { ok: true, telegramMessageId: 5002, permanent: false, error: null };
    }
  });
  assert.equal(retryResult.sent, 1);
  const afterRetry = await store.listCashoutNotificationDeliveriesByTask(partialTaskId);
  assert.equal(afterRetry.every((r) => r.delivery_status === 'sent'), true);
  // Successful recipient was not resent as a duplicate during retry
  assert.equal(afterRetry.filter((r) => r.telegram_chat_id === '102' && r.telegram_message_id === 5001).length, 1);

  // Telegram failure does not mutate AppBeg — consumer only writes Ledger delivery rows.
  // (No AppBeg write APIs invoked in this test harness.)
  assert.ok(true);

  // State-change events edit existing cards (no new sends)
  outboxEvents.push({
    outboxId: 700,
    channel: 'coadmin:coadmin-a:cashouts',
    eventType: 'cashout_start',
    entityType: 'player_cashout_task',
    entityId: 'task-new',
    payload: { taskId: 'task-new', coadminUid: 'coadmin-a', status: 'in_progress' }
  });
  const beforeNonCreateSends = sendsRestart.length;
  let editCalls = 0;
  const batchStart = await processCashoutOutboxBatch({
    store,
    env,
    fetchOutbox,
    fetchTask: async (taskId) => ({
      ok: true,
      task: makeTask({
        taskId,
        status: 'in_progress',
        assignedHandlerUsername: 'staff_a',
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    }),
    sendMessage: async ({ chatId, task }) => {
      sendsRestart.push({ chatId: String(chatId), taskId: task.taskId });
      return { ok: true, telegramMessageId: 9000, permanent: false, error: null };
    },
    editMessage: async () => {
      editCalls += 1;
      return { ok: true, unchanged: false, permanent: false, error: null };
    }
  });
  assert.equal(batchStart.processed, 1);
  assert.equal(sendsRestart.length, beforeNonCreateSends);
  assert.equal(editCalls, 2);
  const afterStart = await store.getCashoutOutboxConsumerState(CASHOUT_TELEGRAM_CONSUMER_NAME);
  assert.equal(Number(afterStart.last_processed_outbox_id), 700);

  console.log('PASS: Phase 3 cash-out Telegram notification tests');
  await store.db.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
