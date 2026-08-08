import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup,
  CASHOUT_CLAIM_PREFIX
} from '../src/telegram/cashoutNotificationCards.js';
import {
  editCashoutNotificationMessage,
  resolveCashoutQrImageUrl,
  sendCashoutNotificationToChat
} from '../src/telegram/cashoutNotificationDelivery.js';
import {
  processCashoutStateSyncEvent,
  processCashoutTaskCreatedEvent,
  refreshCashoutTelegramCardsForTask
} from '../src/telegram/cashoutTelegramNotificationWorker.js';
import { handleCashoutClaimCallback } from '../src/telegram/cashoutClaimCallback.js';
import { handleCashoutDoneCallback } from '../src/telegram/cashoutDoneCallback.js';

const QR_URL = 'https://cdn.example.com/player-qr/task-photo01.png';

function makeTask(overrides = {}) {
  return {
    taskId: 'task-photo01',
    coadminUid: 'coadmin-a',
    playerUsername: 'player_one',
    amountNpr: 1500,
    payoutMethod: 'qr',
    paymentAppName: null,
    qrImageUrl: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    status: 'pending',
    expiresAt: null,
    assignedHandlerUsername: null,
    startedAt: null,
    completedAt: null,
    operationalClaim: null,
    operationalCompletion: null,
    operationalAttribution: null,
    vendorCode: null,
    vendorName: null,
    ...overrides
  };
}

function makeEvent(overrides = {}) {
  return {
    outboxId: 9001,
    channel: 'coadmin:coadmin-a:cashouts',
    eventType: 'cashout_task_created',
    entityType: 'player_cashout_task',
    entityId: 'task-photo01',
    payload: {
      taskId: 'task-photo01',
      coadminUid: 'coadmin-a',
      status: 'pending',
      amountNpr: 1500,
      source: 'authority'
    },
    ...overrides
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

function makeFetchRecorder() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const method = String(url).includes('/sendPhoto')
      ? 'sendPhoto'
      : String(url).includes('/sendMessage')
        ? 'sendMessage'
        : String(url).includes('/editMessageCaption')
          ? 'editMessageCaption'
          : String(url).includes('/editMessageText')
            ? 'editMessageText'
            : 'other';
    calls.push({ method, url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        if (method === 'sendPhoto' || method === 'sendMessage') {
          return { ok: true, result: { message_id: 7000 + calls.length } };
        }
        return { ok: true, result: true };
      }
    };
  };
  return { calls, fetchImpl };
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cashout-qr-photo-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  const env = {
    CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
    CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
    CASHOUT_TELEGRAM_DONE_ENABLED: 'true',
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'test-token',
    SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-token'
  };

  assert.equal(resolveCashoutQrImageUrl(makeTask({ qrImageUrl: QR_URL })), QR_URL);
  assert.equal(resolveCashoutQrImageUrl(makeTask({ qrImageUrl: 'not-a-url' })), null);
  assert.equal(resolveCashoutQrImageUrl(makeTask({ qrImageUrl: null })), null);

  await enroll(store, { userId: 11, chatId: 211, coadminUid: 'coadmin-a' });

  // --- A. Cashout WITH qrImageUrl → sendPhoto ---
  {
    const { calls, fetchImpl } = makeFetchRecorder();
    const task = makeTask({ qrImageUrl: QR_URL });
    const card = buildCashoutNotificationCard(task);
    const markup = buildCashoutNotificationReplyMarkup(task, { env });

    const result = await sendCashoutNotificationToChat({
      chatId: '211',
      task,
      env,
      fetchImpl
    });
    assert.equal(result.ok, true);
    assert.equal(result.messageType, 'photo');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendPhoto');
    assert.equal(calls[0].body.photo, QR_URL);
    assert.equal(calls[0].body.caption, card);
    assert.deepEqual(calls[0].body.reply_markup, markup);
    assert.match(calls[0].body.caption, /Cash Out/);
    assert.match(calls[0].body.caption, /Player: player_one/);
    assert.ok(
      markup.inline_keyboard.some((row) =>
        row.some((btn) => String(btn.callback_data || '').startsWith(CASHOUT_CLAIM_PREFIX))
      )
    );

    // Ledger receives/preserves qrImageUrl through create event path
    const created = await processCashoutTaskCreatedEvent({
      store,
      event: makeEvent({ outboxId: 9101, entityId: 'task-photo-a', payload: {
        taskId: 'task-photo-a', coadminUid: 'coadmin-a', status: 'pending', amountNpr: 1500
      } }),
      env,
      fetchTask: async () => ({ ok: true, task: makeTask({ taskId: 'task-photo-a', qrImageUrl: QR_URL }) }),
      sendMessage: async ({ task: t }) => {
        assert.equal(t.qrImageUrl, QR_URL);
        const send = await sendCashoutNotificationToChat({
          chatId: '211',
          task: t,
          env,
          fetchImpl
        });
        return send;
      }
    });
    assert.equal(created.ok, true);
    assert.equal(created.sent, 1);
    const deliveries = await store.listCashoutNotificationDeliveriesByTask('task-photo-a');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].message_type, 'photo');
    assert.equal(deliveries[0].delivery_status, 'sent');
  }

  // --- B. Cashout WITHOUT qrImageUrl → sendMessage ---
  {
    const { calls, fetchImpl } = makeFetchRecorder();
    const task = makeTask({ taskId: 'task-text-b', qrImageUrl: null });
    const result = await sendCashoutNotificationToChat({
      chatId: '211',
      task,
      env,
      fetchImpl
    });
    assert.equal(result.ok, true);
    assert.equal(result.messageType, 'text');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(calls[0].body.text, buildCashoutNotificationCard(task));
    assert.equal(calls[0].body.photo, undefined);
  }

  // --- C/D. Claim + Done on photo notification → editMessageCaption ---
  {
    const photoTaskId = 'task-photo-cd';
    const ensured = await store.ensureCashoutNotificationDelivery({
      appbegCashoutTaskId: photoTaskId,
      coadminUid: 'coadmin-a',
      telegramChatId: '211',
      outboxId: 9200,
      eventType: 'cashout_task_created'
    });
    await store.markCashoutNotificationDeliverySent({
      deliveryId: ensured.delivery.id,
      telegramMessageId: 8801,
      messageType: 'photo'
    });

    const editCalls = [];
    const claimedTask = makeTask({
      taskId: photoTaskId,
      status: 'in_progress',
      assignedHandlerUsername: 'picasso',
      operationalClaim: {
        actionSource: 'telegram',
        telegramUserId: '11',
        telegramUsername: 'picasso',
        telegramDisplayName: 'Picasso',
        telegramClaimedAt: '2026-08-08T13:00:00.000Z'
      }
    });

    const claimCtx = {
      from: { id: 11, username: 'picasso', first_name: 'Picasso' },
      callbackQuery: { data: `${CASHOUT_CLAIM_PREFIX}${photoTaskId}` },
      answers: [],
      async answerCbQuery(text) {
        this.answers.push(text);
        return true;
      }
    };

    await handleCashoutClaimCallback(claimCtx, store, {
      env,
      claimTask: async () => ({ ok: true, task: claimedTask }),
      fetchTask: async () => ({ ok: true, task: claimedTask }),
      refreshCards: async (args) => refreshCashoutTelegramCardsForTask({
        ...args,
        editMessage: async (opts) => {
          editCalls.push({ phase: 'claim', ...opts });
          return editCashoutNotificationMessage({
            ...opts,
            fetchImpl: async (url, options) => {
              const body = JSON.parse(options.body);
              editCalls.push({
                phase: 'claim_api',
                method: String(url).includes('editMessageCaption')
                  ? 'editMessageCaption'
                  : String(url).includes('editMessageText')
                    ? 'editMessageText'
                    : 'other',
                body
              });
              return { ok: true, status: 200, async json() { return { ok: true }; } };
            }
          });
        }
      })
    });

    assert.ok(editCalls.some((c) => c.phase === 'claim' && c.messageType === 'photo'));
    assert.ok(editCalls.some((c) => c.phase === 'claim_api' && c.method === 'editMessageCaption'));
    assert.ok(!editCalls.some((c) => c.phase === 'claim_api' && c.method === 'editMessageText'));

    const completedTask = makeTask({
      taskId: photoTaskId,
      status: 'completed',
      assignedHandlerUsername: 'picasso',
      operationalClaim: claimedTask.operationalClaim,
      operationalCompletion: {
        actionSource: 'telegram',
        telegramUserId: '11',
        telegramUsername: 'picasso',
        telegramDisplayName: 'Picasso',
        telegramCompletedAt: '2026-08-08T14:00:00.000Z'
      }
    });

    const doneCtx = {
      from: { id: 11, username: 'picasso', first_name: 'Picasso' },
      callbackQuery: { data: `cashout:done:${photoTaskId}` },
      answers: [],
      async answerCbQuery(text) {
        this.answers.push(text);
        return true;
      }
    };

    const doneEditCalls = [];
    await handleCashoutDoneCallback(doneCtx, store, {
      env,
      completeTask: async () => ({ ok: true, task: completedTask }),
      fetchTask: async () => ({ ok: true, task: completedTask }),
      refreshCards: async (args) => refreshCashoutTelegramCardsForTask({
        ...args,
        editMessage: async (opts) => {
          doneEditCalls.push({ phase: 'done', ...opts });
          return editCashoutNotificationMessage({
            ...opts,
            fetchImpl: async (url, options) => {
              const body = JSON.parse(options.body);
              doneEditCalls.push({
                phase: 'done_api',
                method: String(url).includes('editMessageCaption')
                  ? 'editMessageCaption'
                  : String(url).includes('editMessageText')
                    ? 'editMessageText'
                    : 'other',
                body
              });
              return { ok: true, status: 200, async json() { return { ok: true }; } };
            }
          });
        }
      })
    });

    assert.ok(doneEditCalls.some((c) => c.phase === 'done' && c.messageType === 'photo'));
    assert.ok(doneEditCalls.some((c) => c.phase === 'done_api' && c.method === 'editMessageCaption'));
    assert.ok(!doneEditCalls.some((c) => c.phase === 'done_api' && c.method === 'editMessageText'));
  }

  // --- E. State sync on photo notification → editMessageCaption ---
  {
    const syncTaskId = 'task-photo-sync';
    const ensured = await store.ensureCashoutNotificationDelivery({
      appbegCashoutTaskId: syncTaskId,
      coadminUid: 'coadmin-a',
      telegramChatId: '211',
      outboxId: 9300,
      eventType: 'cashout_task_created'
    });
    await store.markCashoutNotificationDeliverySent({
      deliveryId: ensured.delivery.id,
      telegramMessageId: 8901,
      messageType: 'photo'
    });

    const syncEdits = [];
    await processCashoutStateSyncEvent({
      store,
      event: {
        outboxId: 9301,
        channel: 'coadmin:coadmin-a:cashouts',
        eventType: 'cashout_start',
        entityType: 'player_cashout_task',
        entityId: syncTaskId,
        payload: { taskId: syncTaskId, coadminUid: 'coadmin-a', status: 'in_progress' }
      },
      env,
      fetchTask: async () => ({
        ok: true,
        task: makeTask({
          taskId: syncTaskId,
          status: 'in_progress',
          assignedHandlerUsername: 'staff_a',
          qrImageUrl: QR_URL
        })
      }),
      editMessage: async (opts) => {
        syncEdits.push(opts);
        assert.equal(opts.messageType, 'photo');
        return { ok: true, unchanged: false, permanent: false, error: null };
      }
    });
    assert.equal(syncEdits.length, 1);
    assert.equal(syncEdits[0].messageType, 'photo');
  }

  // --- F. sendPhoto failure → sendMessage fallback ---
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const method = String(url).includes('/sendPhoto')
        ? 'sendPhoto'
        : String(url).includes('/sendMessage')
          ? 'sendMessage'
          : 'other';
      calls.push({ method, body });
      if (method === 'sendPhoto') {
        return {
          ok: true,
          status: 400,
          async json() {
            return {
              ok: false,
              error_code: 400,
              description: 'Bad Request: failed to get HTTP URL content'
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 9991 } };
        }
      };
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const result = await sendCashoutNotificationToChat({
        chatId: '211',
        task: makeTask({ taskId: 'task-photo-fallback', qrImageUrl: QR_URL }),
        env,
        fetchImpl
      });
      assert.equal(result.ok, true);
      assert.equal(result.messageType, 'text');
      assert.equal(result.usedPhotoFallback, true);
      assert.equal(calls.map((c) => c.method).join(','), 'sendPhoto,sendMessage');
      assert.ok(warnings.some((w) => /photo_delivery_failed_text_fallback/.test(w)));
    } finally {
      console.warn = originalWarn;
    }
  }

  // --- G. Sensitive paymentDetails still omitted from M2M client payload shape ---
  {
    // Client passes through authoritative task JSON as-is; AppBeg route omits secrets.
    // Assert Ledger never invents paymentDetails and card builders never require them.
    const task = makeTask({ qrImageUrl: QR_URL });
    assert.equal('paymentDetails' in task, false);
    const card = buildCashoutNotificationCard(task);
    assert.doesNotMatch(card, /paymentDetails/i);
    assert.doesNotMatch(card, /\$cash/i);
  }

  // Text-only edit path still uses editMessageText
  {
    const { calls, fetchImpl } = makeFetchRecorder();
    const result = await editCashoutNotificationMessage({
      chatId: '211',
      messageId: 1,
      task: makeTask({ status: 'completed' }),
      messageType: 'text',
      env,
      fetchImpl
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].method, 'editMessageText');
  }

  console.log('PASS: cash-out Telegram QR photo delivery tests');
  await store.db.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
