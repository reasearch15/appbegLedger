import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createDataStore } from '../src/db/index.js';
import { registerInternalSupportNotificationSubscriberRoutes } from '../src/routes/internalSupportNotificationSubscribers.js';
import {
  handleStart,
  handleSupportCallback,
  __resetStaffTelegramEnrollmentStateForTests
} from '../src/telegram/supportNotificationListener.js';
import { sendSupportBotNotification } from '../src/telegram/supportNotificationBot.js';

function makeCtx({ userId, chatId, firstName = 'Picasso', username = 'picasso' }) {
  const replies = [];
  return {
    chat: { id: chatId ?? userId, type: 'private' },
    from: { id: userId, first_name: firstName, username },
    replies,
    async reply(message) {
      replies.push(message);
      return true;
    }
  };
}

function callbackCtx({ userId, firstName, data }) {
  const answers = [];
  return {
    from: { id: userId, first_name: firstName },
    callbackQuery: { data },
    answers,
    async answerCbQuery(text) {
      answers.push(text);
      return true;
    }
  };
}

async function withAuthServer(store, apiKey, run) {
  const app = express();
  app.use(express.json());
  registerInternalSupportNotificationSubscriberRoutes(app, { store });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const previous = process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = apiKey;
  try {
    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      async fetchJson(pathname, { method = 'GET', body = null, token = apiKey } = {}) {
        const response = await fetch(`${`http://127.0.0.1:${port}`}${pathname}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: body ? JSON.stringify(body) : undefined
        });
        const payload = await response.json().catch(() => ({}));
        return { response, payload };
      }
    });
  } finally {
    if (previous == null) delete process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY;
    else process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY = previous;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  __resetStaffTelegramEnrollmentStateForTests();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'staff-telegram-mgmt-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  await store.enrollSupportNotificationSubscriber({
    telegramChatId: '1001',
    telegramUserId: '1001',
    coadminUid: 'coadmin-A',
    telegramUsername: 'picasso',
    telegramDisplayName: 'Picasso'
  });
  await store.enrollSupportNotificationSubscriber({
    telegramChatId: '1002',
    telegramUserId: '1002',
    coadminUid: 'coadmin-A',
    telegramUsername: 'bella',
    telegramDisplayName: 'Bella'
  });
  await store.enrollSupportNotificationSubscriber({
    telegramChatId: '2001',
    telegramUserId: '2001',
    coadminUid: 'coadmin-B',
    telegramUsername: 'other',
    telegramDisplayName: 'Other'
  });
  await store.upsertSupportNotificationSubscriber({
    telegramChatId: '3001',
    telegramUserId: '3001'
  });

  // LIST helpers
  const listA = await store.listSupportNotificationSubscribersByCoadmin('coadmin-A');
  assert.equal(listA.length, 2);
  assert.deepEqual(listA.map((row) => row.telegram_user_id).sort(), ['1001', '1002']);
  const listB = await store.listSupportNotificationSubscribersByCoadmin('coadmin-B');
  assert.equal(listB.length, 1);
  assert.equal(listB[0].telegram_user_id, '2001');
  assert.equal(
    listA.some((row) => row.telegram_user_id === '3001'),
    false
  );

  // DISABLE ownership
  const denyDisable = await store.disableSupportNotificationSubscriber({
    coadminUid: 'coadmin-A',
    telegramUserId: '2001'
  });
  assert.equal(denyDisable.ok, false);
  assert.equal(denyDisable.reason, 'not_found');

  const disabled = await store.disableSupportNotificationSubscriber({
    coadminUid: 'coadmin-A',
    telegramUserId: '1001'
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.subscriber.disabled_by_coadmin, true);
  assert.equal(disabled.subscriber.is_active, false);
  assert.equal(disabled.subscriber.coadmin_uid, 'coadmin-A');
  assert.equal(disabled.subscriber.telegram_username, 'picasso');

  // Disabled still appears in management list
  const listAfterDisable = await store.listSupportNotificationSubscribersByCoadmin('coadmin-A');
  assert.equal(listAfterDisable.some((row) => row.telegram_user_id === '1001' && row.disabled_by_coadmin), true);

  // Delivery excludes disabled
  assert.equal(
    (await store.listActiveSupportNotificationSubscribers()).some((row) => row.telegram_user_id === '1001'),
    false
  );
  assert.equal(await store.getActiveSupportNotificationSubscriberByTelegramUserId('1001'), null);

  // /start cannot reactivate disabled
  const disabledStart = makeCtx({ userId: 1001, firstName: 'Picasso', username: 'picasso' });
  await handleStart(disabledStart, store, {});
  assert.match(disabledStart.replies.at(-1), /disabled by your Coadmin/i);
  assert.equal((await store.getSupportNotificationSubscriberByTelegramUserId('1001')).is_active, false);

  // Claim/Done rejected for disabled
  const request = await store.createSupportRequest({
    kind: 'inquiry',
    username: 'PlayerOne',
    question: 'Hi',
    fingerprint: `inquiry:${Date.now()}`
  });
  const claim = callbackCtx({ userId: 1001, firstName: 'Picasso', data: `support:claim:${request.id}` });
  await handleSupportCallback(claim, store, {
    telegram: { async editMessageText() { return true; } }
  });
  assert.deepEqual(claim.answers, ['Subscribe with /start first.']);

  // ENABLE Option A
  const denyEnable = await store.enableSupportNotificationSubscriber({
    coadminUid: 'coadmin-B',
    telegramUserId: '1001'
  });
  assert.equal(denyEnable.ok, false);

  const enabled = await store.enableSupportNotificationSubscriber({
    coadminUid: 'coadmin-A',
    telegramUserId: '1001'
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.subscriber.disabled_by_coadmin, false);
  assert.equal(enabled.subscriber.is_active, true);
  assert.equal(enabled.subscriber.coadmin_uid, 'coadmin-A');
  assert.ok(await store.getActiveSupportNotificationSubscriberByTelegramUserId('1001'));

  // Delivery works again for enabled subscriber only among A/B actives
  const calls = [];
  await sendSupportBotNotification({
    store,
    kind: 'inquiry',
    request,
    env: { SUPPORT_NOTIFICATION_BOT_TOKEN: 'token' },
    fetchImpl: async (_url, options = {}) => {
      calls.push(JSON.parse(options.body || '{}'));
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 11 } };
        }
      };
    }
  });
  assert.ok(calls.length >= 1);

  // Internal API auth + tenant checks
  await withAuthServer(store, 'test-internal-key', async ({ fetchJson }) => {
    const unauthorized = await fetchJson('/api/internal/support-notification/subscribers?coadminUid=coadmin-A', {
      token: 'wrong'
    });
    assert.equal(unauthorized.response.status, 401);

    const listed = await fetchJson('/api/internal/support-notification/subscribers?coadminUid=coadmin-A');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.ok, true);
    assert.equal(listed.payload.subscribers.length, 2);
    assert.ok(listed.payload.subscribers.every((row) => row.telegramUserId !== '2001'));
    assert.ok(listed.payload.subscribers.every((row) => row.telegramUserId !== '3001'));

    const crossDisable = await fetchJson('/api/internal/support-notification/subscribers/2001/disable', {
      method: 'POST',
      body: { coadminUid: 'coadmin-A' }
    });
    assert.equal(crossDisable.response.status, 404);

    const okDisable = await fetchJson('/api/internal/support-notification/subscribers/1002/disable', {
      method: 'POST',
      body: { coadminUid: 'coadmin-A' }
    });
    assert.equal(okDisable.response.status, 200);
    assert.equal(okDisable.payload.subscriber.disabledByCoadmin, true);
    assert.equal(okDisable.payload.subscriber.isActive, false);

    const okEnable = await fetchJson('/api/internal/support-notification/subscribers/1002/enable', {
      method: 'POST',
      body: { coadminUid: 'coadmin-A' }
    });
    assert.equal(okEnable.response.status, 200);
    assert.equal(okEnable.payload.subscriber.disabledByCoadmin, false);
    assert.equal(okEnable.payload.subscriber.isActive, true);
  });

  // Legacy remains enrollable later
  const legacyStart = makeCtx({ userId: 3001, chatId: 3001, firstName: 'Legacy' });
  await handleStart(legacyStart, store, {});
  assert.match(legacyStart.replies.at(-1), /Staff Telegram Integration Code/);
  const enrolledLegacy = await store.enrollSupportNotificationSubscriber({
    telegramChatId: '3001',
    telegramUserId: '3001',
    coadminUid: 'coadmin-A',
    telegramDisplayName: 'Legacy'
  });
  assert.equal(enrolledLegacy.ok, true);
  assert.equal(
    (await store.listSupportNotificationSubscribersByCoadmin('coadmin-A')).some(
      (row) => row.telegram_user_id === '3001'
    ),
    true
  );

  await store.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('All staff Telegram management Phase 2 checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
