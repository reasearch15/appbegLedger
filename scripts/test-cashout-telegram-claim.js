import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup,
  CASHOUT_CLAIM_PREFIX,
  parseCashoutClaimCallback
} from '../src/telegram/cashoutNotificationCards.js';
import {
  CASHOUT_CLAIM_CONFLICT_TEXT,
  CASHOUT_CLAIM_DISABLED_TEXT,
  CASHOUT_CLAIM_SUCCESS_TEXT,
  CASHOUT_CLAIM_UNAUTHORIZED_TEXT,
  handleCashoutClaimCallback
} from '../src/telegram/cashoutClaimCallback.js';

function makeTask(overrides = {}) {
  return {
    taskId: 'task-claim01',
    coadminUid: 'coadmin-a',
    playerUsername: 'player_one',
    amountNpr: 1200,
    payoutMethod: 'qr',
    paymentAppName: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    status: 'pending',
    expiresAt: null,
    assignedHandlerUsername: null,
    startedAt: null,
    completedAt: null,
    operationalAttribution: null,
    ...overrides
  };
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
}

async function seedDelivery(store, { taskId, coadminUid, chatId, messageId }) {
  const ensured = await store.ensureCashoutNotificationDelivery({
    appbegCashoutTaskId: taskId,
    coadminUid,
    telegramChatId: String(chatId),
    outboxId: 1,
    eventType: 'cashout_task_created'
  });
  await store.markCashoutNotificationDeliverySent({
    deliveryId: ensured.delivery.id,
    telegramMessageId: messageId
  });
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cashout-claim-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  const env = {
    CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
    CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'test-token',
    SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-token'
  };

  // --- CARD / BUTTON RULES ---
  const pendingMarkup = buildCashoutNotificationReplyMarkup(
    makeTask({ status: 'pending' }),
    { claimEnabled: true }
  );
  assert.equal(pendingMarkup.inline_keyboard.length, 1);
  assert.equal(pendingMarkup.inline_keyboard[0][0].text, 'CLAIM');
  assert.equal(
    pendingMarkup.inline_keyboard[0][0].callback_data,
    `${CASHOUT_CLAIM_PREFIX}task-claim01`
  );
  assert.ok(!JSON.stringify(pendingMarkup).includes('DONE'));
  assert.equal(parseCashoutClaimCallback(`${CASHOUT_CLAIM_PREFIX}task-claim01`), 'task-claim01');

  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(makeTask({ status: 'in_progress' }), { claimEnabled: true }),
    { inline_keyboard: [] }
  );
  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(makeTask({ status: 'pending' }), { claimEnabled: false }),
    { inline_keyboard: [] }
  );

  const telegramClaimCard = buildCashoutNotificationCard(makeTask({
    status: 'in_progress',
    assignedHandlerUsername: 'CoadminA',
    expiresAt: '2099-01-01T13:42:00.000Z',
    operationalAttribution: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramUsername: 'picasso',
      telegramDisplayName: 'Picasso',
      telegramClaimedAt: '2026-08-08T12:01:00.000Z'
    }
  }));
  assert.match(telegramClaimCard, /Claimed via Telegram by: Picasso/);
  assert.match(telegramClaimCard, /@picasso/);
  assert.doesNotMatch(telegramClaimCard, /Handler: CoadminA/);
  assert.doesNotMatch(telegramClaimCard, /DONE/i);

  // --- AUTH SETUP ---
  await enroll(store, { userId: 11, chatId: 111, coadminUid: 'coadmin-a' }); // Picasso
  await enroll(store, { userId: 12, chatId: 112, coadminUid: 'coadmin-a' }); // Bella
  await enroll(store, { userId: 21, chatId: 221, coadminUid: 'coadmin-b' }); // other tenant
  await store.db.prepare(`
    INSERT INTO support_notification_subscribers (
      telegram_chat_id, telegram_user_id, is_active, coadmin_uid, subscribed_at, created_at, updated_at
    ) VALUES ('999', '999', 1, NULL, ?, ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  await seedDelivery(store, { taskId: 'task-claim01', coadminUid: 'coadmin-a', chatId: 111, messageId: 501 });
  await seedDelivery(store, { taskId: 'task-claim01', coadminUid: 'coadmin-a', chatId: 112, messageId: 502 });

  // 1. Unlinked user
  {
    const ctx = makeCtx({ userId: 404, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({ ok: true }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'unlinked');
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_UNAUTHORIZED_TEXT);
  }

  // 2. NULL-coadmin legacy
  {
    const ctx = makeCtx({ userId: 999, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({ ok: true }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'null_coadmin');
  }

  // 3–4. inactive / disabled
  await store.deactivateSupportNotificationSubscriber('111', { reason: 'stopped' });
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({ ok: true }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'inactive');
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_DISABLED_TEXT);
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
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    let called = false;
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => {
        called = true;
        return { ok: true };
      },
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'disabled_by_coadmin');
    assert.equal(called, false);
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_DISABLED_TEXT);
  }
  await store.enableSupportNotificationSubscriber({
    coadminUid: 'coadmin-a',
    telegramUserId: '11'
  });

  // 5. Cross-tenant: Coadmin B subscriber claiming A task — AppBeg returns forbidden
  {
    const ctx = makeCtx({ userId: 21, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async ({ expectedCoadminUid }) => {
        assert.equal(expectedCoadminUid, 'coadmin-b');
        return { ok: false, reason: 'forbidden' };
      },
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.reason, 'forbidden');
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_UNAUTHORIZED_TEXT);
  }

  // 6–14 SUCCESS path
  const claimCalls = [];
  const refreshCalls = [];
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const claimedTask = makeTask({
      status: 'in_progress',
      assignedHandlerUsername: 'CoadminA',
      expiresAt: '2099-01-01T13:42:00.000Z',
      operationalAttribution: {
        actionSource: 'telegram',
        telegramUserId: '11',
        telegramUsername: 'picasso',
        telegramDisplayName: 'Picasso',
        telegramClaimedAt: '2026-08-08T12:01:00.000Z'
      }
    });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async (input) => {
        claimCalls.push(input);
        assert.equal(input.taskId, 'task-claim01');
        assert.equal(input.telegramUserId, '11');
        assert.equal(input.expectedCoadminUid, 'coadmin-a');
        assert.equal(input.telegramDisplayName, 'Picasso');
        return {
          ok: true,
          duplicate: false,
          taskId: 'task-claim01',
          expiresAtMs: Date.parse(claimedTask.expiresAt),
          task: claimedTask
        };
      },
      refreshCards: async ({ task }) => {
        refreshCalls.push(task);
        assert.equal(task.status, 'in_progress');
        assert.equal(task.operationalAttribution.telegramDisplayName, 'Picasso');
        const markup = buildCashoutNotificationReplyMarkup(task, { claimEnabled: true });
        assert.deepEqual(markup, { inline_keyboard: [] });
        return { ok: true, edited: 2, failed: 0 };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_SUCCESS_TEXT);
    assert.equal(claimCalls.length, 1);
    assert.equal(refreshCalls.length, 1);
  }

  // 15–19 Picasso vs Bella race — Bella conflict
  {
    const ctx = makeCtx({
      userId: 12,
      username: 'bella',
      firstName: 'Bella',
      data: `${CASHOUT_CLAIM_PREFIX}task-claim01`
    });
    let refreshed = false;
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({ ok: false, reason: 'conflict' }),
      fetchTask: async () => ({
        ok: true,
        task: makeTask({
          status: 'in_progress',
          operationalAttribution: {
            actionSource: 'telegram',
            telegramUserId: '11',
            telegramDisplayName: 'Picasso',
            telegramUsername: 'picasso',
            telegramClaimedAt: '2026-08-08T12:01:00.000Z'
          }
        })
      }),
      refreshCards: async () => {
        refreshed = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'conflict');
    assert.equal(ctx.answers.at(-1), CASHOUT_CLAIM_CONFLICT_TEXT);
    assert.equal(refreshed, true);
  }

  // 24–26 Replay: same Picasso claim returns ok duplicate, no second ops assumed at API
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({
        ok: true,
        duplicate: true,
        task: makeTask({
          status: 'in_progress',
          operationalAttribution: {
            actionSource: 'telegram',
            telegramUserId: '11',
            telegramDisplayName: 'Picasso',
            telegramUsername: 'picasso',
            telegramClaimedAt: '2026-08-08T12:01:00.000Z'
          }
        })
      }),
      refreshCards: async () => ({ ok: true })
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
  }

  // 27–30 Stale CLAIM on completed
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    let refreshed = false;
    const result = await handleCashoutClaimCallback(ctx, store, {
      env,
      claimTask: async () => ({ ok: false, reason: 'not_claimable' }),
      fetchTask: async () => ({
        ok: true,
        task: makeTask({ status: 'completed', completedAt: '2026-08-08T12:10:00.000Z' })
      }),
      refreshCards: async ({ task }) => {
        refreshed = true;
        assert.equal(task.status, 'completed');
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'not_claimable');
    assert.equal(refreshed, true);
  }

  // Claim flag off
  {
    const ctx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-claim01` });
    let called = false;
    const result = await handleCashoutClaimCallback(ctx, store, {
      env: { ...env, CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false' },
      claimTask: async () => {
        called = true;
        return { ok: true };
      }
    });
    assert.equal(result.reason, 'claim_disabled');
    assert.equal(called, false);
  }

  // Phase boundary: DONE is independent — pending still has CLAIM only when DONE flag off
  assert.equal(CASHOUT_CLAIM_PREFIX.includes('done'), false);
  assert.doesNotMatch(
    JSON.stringify(buildCashoutNotificationReplyMarkup(makeTask({ status: 'pending' }), {
      claimEnabled: true,
      doneEnabled: false
    })),
    /done/i
  );

  console.log('PASS: Phase 5 cash-out Telegram CLAIM tests');
  await store.db.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
