import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { completeCashoutTaskViaTelegram } from '../src/appbeg/cashoutCompleteClient.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup,
  CASHOUT_CLAIM_PREFIX,
  CASHOUT_DONE_PREFIX,
  isCashoutTelegramDoneEnabled,
  parseCashoutDoneCallback
} from '../src/telegram/cashoutNotificationCards.js';
import {
  CASHOUT_DONE_ALREADY_COMPLETED_TEXT,
  CASHOUT_DONE_CLAIM_INACTIVE_TEXT,
  CASHOUT_DONE_DISABLED_TEXT,
  CASHOUT_DONE_NOT_CLAIMANT_TEXT,
  CASHOUT_DONE_SUCCESS_TEXT,
  CASHOUT_DONE_UNAUTHORIZED_TEXT,
  handleCashoutDoneCallback,
  isCashoutDoneCallback
} from '../src/telegram/cashoutDoneCallback.js';
import { editCashoutNotificationMessage } from '../src/telegram/cashoutNotificationDelivery.js';

function makeTask(overrides = {}) {
  return {
    taskId: 'task-done01',
    coadminUid: 'coadmin-a',
    playerUsername: 'player_one',
    amountNpr: 1000,
    payoutMethod: 'qr',
    paymentAppName: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    status: 'pending',
    expiresAt: null,
    assignedHandlerUsername: null,
    assignedHandlerUid: null,
    startedAt: null,
    completedAt: null,
    operationalClaim: null,
    operationalCompletion: null,
    operationalAttribution: null,
    ...overrides
  };
}

function telegramClaimed(overrides = {}) {
  return makeTask({
    status: 'in_progress',
    assignedHandlerUid: 'coadmin-a',
    assignedHandlerUsername: 'CoadminA',
    expiresAt: '2099-01-01T13:42:00.000Z',
    operationalClaim: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      telegramClaimedAt: '2026-08-08T12:01:00.000Z'
    },
    operationalAttribution: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      telegramClaimedAt: '2026-08-08T12:01:00.000Z'
    },
    ...overrides
  });
}

function telegramCompleted(overrides = {}) {
  return telegramClaimed({
    status: 'completed',
    expiresAt: null,
    completedAt: '2026-08-08T12:05:00.000Z',
    operationalCompletion: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      telegramCompletedAt: '2026-08-08T12:05:00.000Z'
    },
    operationalAttribution: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      telegramClaimedAt: '2026-08-08T12:01:00.000Z',
      telegramCompletedAt: '2026-08-08T12:05:00.000Z',
      completionSource: 'telegram'
    },
    ...overrides
  });
}

function makeCtx({ userId, username = 'picasso', firstName = 'Picasso', data }) {
  const answers = [];
  return {
    answers,
    from: { id: userId, username, first_name: firstName },
    callbackQuery: { data },
    async answerCbQuery(text) {
      answers.push(text);
      return true;
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
  return result.subscriber;
}

async function seedDelivery(store, { taskId, coadminUid, chatId, messageId, subscriberId = null }) {
  const ensured = await store.ensureCashoutNotificationDelivery({
    appbegCashoutTaskId: taskId,
    coadminUid,
    subscriberId,
    telegramChatId: String(chatId),
    outboxId: 1,
    eventType: 'cashout_task_created'
  });
  await store.markCashoutNotificationDeliverySent({
    deliveryId: ensured.delivery.id,
    telegramMessageId: messageId
  });
  return ensured.delivery;
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cashout-done-'));
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

  // --- FLAGS ---
  assert.equal(isCashoutTelegramDoneEnabled({
    ...env,
    CASHOUT_TELEGRAM_DONE_ENABLED: 'false'
  }), false);
  assert.equal(isCashoutTelegramDoneEnabled({
    ...env,
    CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
  }), true);
  // Fail-safe: DONE without CLAIM
  assert.equal(isCashoutTelegramDoneEnabled({
    ...env,
    CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
    CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
  }), false);
  assert.equal(isCashoutTelegramDoneEnabled({}), false);
  assert.ok(isCashoutDoneCallback(`${CASHOUT_DONE_PREFIX}task-done01`));
  assert.equal(parseCashoutDoneCallback(`${CASHOUT_DONE_PREFIX}task-done01`), 'task-done01');
  assert.ok(!isCashoutDoneCallback(`${CASHOUT_CLAIM_PREFIX}task-done01`));

  // --- BUTTON ELIGIBILITY (viewer-specific) ---
  const claimed = telegramClaimed();
  const picassoDone = buildCashoutNotificationReplyMarkup(claimed, {
    claimEnabled: true,
    doneEnabled: true,
    viewerTelegramUserId: '11'
  });
  assert.equal(picassoDone.inline_keyboard.length, 1);
  assert.equal(picassoDone.inline_keyboard[0][0].text, 'DONE');
  assert.equal(picassoDone.inline_keyboard[0][0].callback_data, `${CASHOUT_DONE_PREFIX}task-done01`);

  const bellaNoDone = buildCashoutNotificationReplyMarkup(claimed, {
    claimEnabled: true,
    doneEnabled: true,
    viewerTelegramUserId: '12'
  });
  assert.deepEqual(bellaNoDone, { inline_keyboard: [] });

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(claimed, {
      claimEnabled: true,
      doneEnabled: false,
      viewerTelegramUserId: '11'
    }),
    { inline_keyboard: [] }
  );

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(
      makeTask({
        status: 'in_progress',
        assignedHandlerUsername: 'CoadminA',
        operationalClaim: null
      }),
      { doneEnabled: true, viewerTelegramUserId: '11' }
    ),
    { inline_keyboard: [] }
  );

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(makeTask({ status: 'pending' }), {
      claimEnabled: true,
      doneEnabled: true,
      viewerTelegramUserId: '11'
    }).inline_keyboard[0][0].text,
    'CLAIM'
  );

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(telegramCompleted(), {
      doneEnabled: true,
      viewerTelegramUserId: '11'
    }),
    { inline_keyboard: [] }
  );

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(makeTask({ status: 'declined' }), {
      doneEnabled: true,
      viewerTelegramUserId: '11'
    }),
    { inline_keyboard: [] }
  );

  // --- CARD ATTRIBUTION ---
  const inProgressCard = buildCashoutNotificationCard(claimed);
  assert.match(inProgressCard, /Claimed via Telegram by: Picasso/);
  assert.doesNotMatch(inProgressCard, /Handler: CoadminA/);
  assert.doesNotMatch(inProgressCard, /Completed via Telegram/);

  const tgCompleteCard = buildCashoutNotificationCard(telegramCompleted());
  assert.match(tgCompleteCard, /Status: 🟢 COMPLETED/);
  assert.match(tgCompleteCard, /Completed via Telegram by: Picasso/);
  assert.doesNotMatch(tgCompleteCard, /Handler: CoadminA/);

  const humanAfterTelegramClaim = buildCashoutNotificationCard(telegramClaimed({
    status: 'completed',
    completedAt: '2026-08-08T12:06:00.000Z',
    assignedHandlerUsername: 'CoadminA',
    operationalCompletion: null,
    operationalAttribution: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramDisplayName: 'Picasso',
      telegramUsername: 'picasso',
      telegramClaimedAt: '2026-08-08T12:01:00.000Z'
    }
  }));
  assert.match(humanAfterTelegramClaim, /Handler: CoadminA/);
  assert.doesNotMatch(humanAfterTelegramClaim, /Completed via Telegram/);

  // --- AUTH SETUP ---
  const picasso = await enroll(store, { userId: 11, chatId: 111, coadminUid: 'coadmin-a' });
  const bella = await enroll(store, { userId: 12, chatId: 112, coadminUid: 'coadmin-a' });
  await enroll(store, { userId: 21, chatId: 221, coadminUid: 'coadmin-b' });
  await store.db.prepare(`
    INSERT INTO support_notification_subscribers (
      telegram_chat_id, telegram_user_id, is_active, coadmin_uid, subscribed_at, created_at, updated_at
    ) VALUES ('999', '999', 1, NULL, ?, ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  await seedDelivery(store, {
    taskId: 'task-done01',
    coadminUid: 'coadmin-a',
    chatId: 111,
    messageId: 601,
    subscriberId: picasso.id
  });
  await seedDelivery(store, {
    taskId: 'task-done01',
    coadminUid: 'coadmin-a',
    chatId: 112,
    messageId: 602,
    subscriberId: bella.id
  });

  const editable = await store.listEditableCashoutNotificationDeliveriesByTask('task-done01');
  assert.equal(editable.length, 2);
  assert.equal(String(editable.find((d) => d.telegram_chat_id === '111').telegram_user_id), '11');
  assert.equal(String(editable.find((d) => d.telegram_chat_id === '112').telegram_user_id), '12');

  // Delivery edit markup is viewer-specific
  {
    const bodies = [];
    await editCashoutNotificationMessage({
      chatId: '111',
      messageId: 601,
      task: claimed,
      env,
      viewerTelegramUserId: '11',
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return {
          ok: true,
          async json() {
            return { ok: true };
          }
        };
      }
    });
    assert.equal(bodies[0].reply_markup.inline_keyboard[0][0].text, 'DONE');

    await editCashoutNotificationMessage({
      chatId: '112',
      messageId: 602,
      task: claimed,
      env,
      viewerTelegramUserId: '12',
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return {
          ok: true,
          async json() {
            return { ok: true };
          }
        };
      }
    });
    assert.deepEqual(bodies[1].reply_markup, { inline_keyboard: [] });
  }

  // 1. Unlinked
  {
    const ctx = makeCtx({ userId: 404, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({ ok: true }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'unlinked');
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_UNAUTHORIZED_TEXT);
  }

  // 2. NULL coadmin
  {
    const ctx = makeCtx({ userId: 999, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'null_coadmin');
  }

  // 3–4 inactive / disabled — reject before AppBeg
  await store.deactivateSupportNotificationSubscriber('111', { reason: 'stopped' });
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    let called = false;
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => {
        called = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'inactive');
    assert.equal(called, false);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_DISABLED_TEXT);
  }
  await store.enableSupportNotificationSubscriber({
    coadminUid: 'coadmin-a',
    telegramUserId: '11'
  });
  await store.disableSupportNotificationSubscriber({
    coadminUid: 'coadmin-a',
    telegramUserId: '11'
  });
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    let called = false;
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => {
        called = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'disabled_by_coadmin');
    assert.equal(called, false);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_DISABLED_TEXT);
  }
  await store.enableSupportNotificationSubscriber({
    coadminUid: 'coadmin-a',
    telegramUserId: '11'
  });

  // 5. Cross-tenant
  {
    const ctx = makeCtx({ userId: 21, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async ({ expectedCoadminUid }) => {
        assert.equal(expectedCoadminUid, 'coadmin-b');
        return { ok: false, reason: 'forbidden' };
      }
    });
    assert.equal(result.reason, 'forbidden');
  }

  // 6. Bella cannot DONE Picasso claim
  {
    const ctx = makeCtx({
      userId: 12,
      username: 'bella',
      firstName: 'Bella',
      data: `${CASHOUT_DONE_PREFIX}task-done01`
    });
    let refreshed = false;
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async ({ telegramUserId }) => {
        assert.equal(telegramUserId, '12');
        return { ok: false, reason: 'not_claimant', task: claimed };
      },
      refreshCards: async () => {
        refreshed = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'not_claimant');
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_NOT_CLAIMANT_TEXT);
    assert.equal(refreshed, true);
  }

  // 7. pending cannot DONE
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({
        ok: false,
        reason: 'not_completable',
        task: makeTask({ status: 'pending' })
      }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'not_completable');
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_CLAIM_INACTIVE_TEXT);
  }

  // 8–12 released / declined / not completable
  for (const status of ['pending', 'declined']) {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({
        ok: false,
        reason: 'not_completable',
        task: makeTask({ status })
      }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'not_completable');
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_CLAIM_INACTIVE_TEXT);
  }

  // 13 Soft reconcile already completed
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({
        ok: true,
        duplicate: true,
        alreadyCompleted: true,
        task: telegramCompleted()
      }),
      refreshCards: async ({ task }) => {
        assert.equal(task.status, 'completed');
        assert.equal(task.operationalCompletion.telegramDisplayName, 'Picasso');
        return { ok: true };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_ALREADY_COMPLETED_TEXT);
  }

  // 14–20 SUCCESS — Picasso DONE
  const completeCalls = [];
  const refreshCalls = [];
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const completed = telegramCompleted();
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async (input) => {
        completeCalls.push(input);
        assert.equal(input.taskId, 'task-done01');
        assert.equal(input.telegramUserId, '11');
        assert.equal(input.expectedCoadminUid, 'coadmin-a');
        assert.equal(input.telegramDisplayName, 'Picasso');
        // Ledger must never invent telegram:* as financial actor — only forward Telegram ops identity.
        assert.ok(!String(input.expectedCoadminUid).startsWith('telegram:'));
        return {
          ok: true,
          duplicate: false,
          alreadyCompleted: false,
          task: completed
        };
      },
      refreshCards: async ({ task }) => {
        refreshCalls.push(task);
        assert.equal(task.status, 'completed');
        assert.equal(task.assignedHandlerUsername, 'CoadminA');
        assert.equal(task.operationalCompletion.telegramDisplayName, 'Picasso');
        const markup = buildCashoutNotificationReplyMarkup(task, {
          doneEnabled: true,
          viewerTelegramUserId: '11'
        });
        assert.deepEqual(markup, { inline_keyboard: [] });
        return { ok: true, edited: 2, failed: 0 };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_SUCCESS_TEXT);
    assert.equal(completeCalls.length, 1);
    assert.equal(refreshCalls.length, 1);
  }

  // 29–35 Replay same Picasso DONE
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({
        ok: true,
        duplicate: true,
        alreadyCompleted: true,
        task: telegramCompleted()
      }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_ALREADY_COMPLETED_TEXT);
  }

  // 42 Bella after Picasso completed — soft reconcile, no mutation assumed at API
  {
    const ctx = makeCtx({
      userId: 12,
      username: 'bella',
      firstName: 'Bella',
      data: `${CASHOUT_DONE_PREFIX}task-done01`
    });
    const result = await handleCashoutDoneCallback(ctx, store, {
      env,
      completeTask: async () => ({
        ok: true,
        duplicate: true,
        alreadyCompleted: true,
        task: telegramCompleted()
      }),
      refreshCards: async ({ task }) => {
        assert.equal(task.operationalCompletion.telegramUserId, '11');
        return { ok: true };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(ctx.answers.at(-1), CASHOUT_DONE_ALREADY_COMPLETED_TEXT);
  }

  // 50 Feature flag off
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-done01` });
    let called = false;
    const result = await handleCashoutDoneCallback(ctx, store, {
      env: { ...env, CASHOUT_TELEGRAM_DONE_ENABLED: 'false' },
      completeTask: async () => {
        called = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'done_disabled');
    assert.equal(called, false);
  }

  // CLAIM remains independent when DONE off
  assert.equal(
    buildCashoutNotificationReplyMarkup(makeTask({ status: 'pending' }), {
      claimEnabled: true,
      doneEnabled: false
    }).inline_keyboard[0][0].text,
    'CLAIM'
  );

  // --- CLIENT: M2M complete payload + no Ledger money mutation surface ---
  {
    let captured = null;
    const clientResult = await completeCashoutTaskViaTelegram({
      taskId: 'task-done01',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      expectedCoadminUid: 'coadmin-a',
      env,
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              duplicate: false,
              alreadyCompleted: false,
              taskId: 'task-done01',
              task: telegramCompleted()
            });
          }
        };
      }
    });
    assert.equal(clientResult.ok, true);
    assert.match(captured.url, /\/api\/internal\/ledger\/cashout-tasks\/complete$/);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.taskId, 'task-done01');
    assert.equal(body.telegramUserId, '11');
    assert.equal(body.expectedCoadminUid, 'coadmin-a');
    assert.equal(body.idempotencyKey, 'cashout_complete:task-done01:telegram:11');
    assert.equal(captured.options.headers['x-appbeg-ledger-token'], 'test-token');
    // Phase boundary: client never posts cashBox / financial_events / reward mutations.
    assert.equal(body.cashBoxNpr, undefined);
    assert.equal(body.rewardNpr, undefined);
    assert.equal(body.amountNpr, undefined);
    assert.equal(body.actorUid, undefined);
  }

  // Finance assertions are owned by AppBeg completePlayerCashoutTaskInSql — Ledger must not write money.
  assert.equal(typeof store.updateCashBoxNpr, 'undefined');
  assert.equal(typeof store.writeFinancialEventsCache, 'undefined');
  assert.equal(typeof store.completePlayerCashoutTaskInSql, 'undefined');

  // Completed edit clears buttons for all viewers
  {
    const bodies = [];
    for (const viewer of ['11', '12']) {
      await editCashoutNotificationMessage({
        chatId: viewer === '11' ? '111' : '112',
        messageId: viewer === '11' ? 601 : 602,
        task: telegramCompleted(),
        env,
        viewerTelegramUserId: viewer,
        fetchImpl: async (_url, options) => {
          bodies.push(JSON.parse(options.body));
          return {
            ok: true,
            async json() {
              return { ok: true };
            }
          };
        }
      });
    }
    assert.deepEqual(bodies[0].reply_markup, { inline_keyboard: [] });
    assert.deepEqual(bodies[1].reply_markup, { inline_keyboard: [] });
    assert.match(bodies[0].text, /Completed via Telegram by: Picasso/);
  }

  console.log('PASS: Phase 6 cash-out Telegram DONE tests');
  await store.db.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
