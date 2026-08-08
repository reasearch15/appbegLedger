import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { validateStaffTelegramIntegrationCode } from '../src/appbeg/staffTelegramClient.js';
import {
  handleStart,
  handleTextEnrollment,
  __resetStaffTelegramEnrollmentStateForTests
} from '../src/telegram/supportNotificationListener.js';
import { sendSupportBotNotification } from '../src/telegram/supportNotificationBot.js';

function makeCtx({ userId, chatId, firstName = 'Picasso', username = 'picasso', text = null }) {
  const replies = [];
  return {
    chat: { id: chatId ?? userId, type: 'private' },
    from: { id: userId, first_name: firstName, username },
    message: text == null ? undefined : { text },
    replies,
    async reply(message) {
      replies.push(message);
      return true;
    }
  };
}

function mockValidateFetch(handler) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    assert.match(String(url), /\/api\/internal\/ledger\/staff-telegram\/validate-code$/);
    assert.equal(options.headers['x-appbeg-ledger-token'], 'test-token');
    return handler(body, options);
  };
}

async function run() {
  __resetStaffTelegramEnrollmentStateForTests();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'staff-telegram-enroll-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  const env = {
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'test-token'
  };

  // Unknown /start does not activate; prompts for code.
  const startCtx = makeCtx({ userId: 9001, firstName: 'NewUser', username: 'newuser' });
  await handleStart(startCtx, store, env);
  assert.match(startCtx.replies.at(-1), /Staff Telegram Integration Code/);
  assert.equal(await store.getSupportNotificationSubscriberByTelegramUserId('9001'), null);
  assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 0);

  // Invalid code does not activate.
  const invalidCtx = makeCtx({
    userId: 9001,
    text: 'STG-BADCODE12345',
    firstName: 'NewUser',
    username: 'newuser'
  });
  await handleTextEnrollment(invalidCtx, store, env, {
    validateCode: async () => ({ ok: false, reason: 'invalid' })
  });
  assert.match(invalidCtx.replies.at(-1), /Invalid Staff Telegram Integration Code/);
  assert.equal(await store.getSupportNotificationSubscriberByTelegramUserId('9001'), null);

  // AppBeg outage does not activate.
  const outageCtx = makeCtx({
    userId: 9001,
    text: 'STG-OUTAGECODE01',
    firstName: 'NewUser',
    username: 'newuser'
  });
  await handleTextEnrollment(outageCtx, store, env, {
    validateCode: async () => ({ ok: false, reason: 'unavailable' })
  });
  assert.match(outageCtx.replies.at(-1), /Unable to verify the code right now/);
  assert.equal(await store.getSupportNotificationSubscriberByTelegramUserId('9001'), null);

  // Valid enroll through bot path.
  const validCtx = makeCtx({
    userId: 9001,
    text: '  stg-abcd1234efgh  ',
    firstName: 'Picasso',
    username: 'picasso'
  });
  await handleTextEnrollment(validCtx, store, env, {
    validateCode: async (code) => {
      assert.equal(String(code).trim().toUpperCase().replace(/\s+/g, ''), 'STG-ABCD1234EFGH');
      return { ok: true, coadminUid: 'coadmin-A' };
    }
  });
  assert.match(validCtx.replies.at(-1), /Connected successfully/);
  const linked = await store.getSupportNotificationSubscriberByTelegramUserId('9001');
  assert.equal(linked.coadmin_uid, 'coadmin-A');
  assert.equal(linked.telegram_user_id, '9001');
  assert.equal(linked.telegram_username, 'picasso');
  assert.equal(linked.telegram_display_name, 'Picasso');
  assert.equal(linked.is_active, true);
  assert.equal(linked.disabled_by_coadmin, false);
  assert.ok(linked.linked_at);

  // Linked /start does not need code again.
  __resetStaffTelegramEnrollmentStateForTests();
  const welcomeCtx = makeCtx({ userId: 9001, firstName: 'Picasso', username: 'picasso' });
  await handleStart(welcomeCtx, store, env);
  assert.match(welcomeCtx.replies.at(-1), /subscribed/i);

  // /stop preserves link.
  await store.deactivateSupportNotificationSubscriber('9001', { reason: 'user_stop' });
  const stopped = await store.getSupportNotificationSubscriberByTelegramUserId('9001');
  assert.equal(stopped.is_active, false);
  assert.equal(stopped.coadmin_uid, 'coadmin-A');
  assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 0);

  // /start after /stop reactivates.
  const reactivateCtx = makeCtx({ userId: 9001, firstName: 'Picasso', username: 'picasso' });
  await handleStart(reactivateCtx, store, env);
  assert.match(reactivateCtx.replies.at(-1), /subscribed/i);
  assert.equal((await store.getSupportNotificationSubscriberByTelegramUserId('9001')).is_active, true);

  // Legacy NULL coadmin_uid must re-enroll.
  await store.upsertSupportNotificationSubscriber({ telegramChatId: '8001', telegramUserId: '8001' });
  const legacy = await store.getSupportNotificationSubscriberByTelegramUserId('8001');
  assert.equal(legacy.coadmin_uid, null);
  assert.equal(legacy.is_active, true);
  assert.equal(
    (await store.listActiveSupportNotificationSubscribers()).some((row) => row.telegram_user_id === '8001'),
    false
  );
  const legacyStart = makeCtx({ userId: 8001, chatId: 8001, firstName: 'Legacy' });
  await handleStart(legacyStart, store, env);
  assert.match(legacyStart.replies.at(-1), /Staff Telegram Integration Code/);

  // Disabled cannot reactivate.
  await store.db.prepare(`
    UPDATE support_notification_subscribers
    SET disabled_by_coadmin = 1, is_active = 0
    WHERE telegram_user_id = '9001'
  `).run();
  const disabledStart = makeCtx({ userId: 9001, firstName: 'Picasso', username: 'picasso' });
  await handleStart(disabledStart, store, env);
  assert.match(disabledStart.replies.at(-1), /disabled by your Coadmin/i);
  assert.equal((await store.getSupportNotificationSubscriberByTelegramUserId('9001')).is_active, false);

  // One telegram user cannot link to another Coadmin silently.
  await store.db.prepare(`
    UPDATE support_notification_subscribers
    SET disabled_by_coadmin = 0, is_active = 1, coadmin_uid = 'coadmin-A'
    WHERE telegram_user_id = '9001'
  `).run();
  const other = await store.enrollSupportNotificationSubscriber({
    telegramChatId: '9001',
    telegramUserId: '9001',
    coadminUid: 'coadmin-B',
    telegramDisplayName: 'Picasso'
  });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'already_linked_other_coadmin');
  assert.equal((await store.getSupportNotificationSubscriberByTelegramUserId('9001')).coadmin_uid, 'coadmin-A');

  // Delivery eligibility.
  await store.db.prepare(`
    UPDATE support_notification_subscribers
    SET is_active = 1, disabled_by_coadmin = 0
    WHERE telegram_user_id = '9001'
  `).run();
  const active = await store.listActiveSupportNotificationSubscribers();
  assert.equal(active.length, 1);
  assert.equal(active[0].telegram_user_id, '9001');
  assert.equal(active[0].coadmin_uid, 'coadmin-A');

  const calls = [];
  const request = await store.createSupportRequest({
    kind: 'inquiry',
    username: 'PlayerOne',
    question: 'Hello?',
    fingerprint: `inquiry:${Date.now()}`
  });
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
          return { ok: true, result: { message_id: 42 } };
        }
      };
    }
  });
  assert.equal(calls.length, 1);

  // Client normalize / auth / unavailable.
  const valid = await validateStaffTelegramIntegrationCode('  stg-abcd1234efgh  ', {
    env,
    fetchImpl: mockValidateFetch(async (body) => {
      assert.equal(body.code, 'STG-ABCD1234EFGH');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, coadminUid: 'coadmin-A' });
        }
      };
    })
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.coadminUid, 'coadmin-A');

  const unauthorized = await validateStaffTelegramIntegrationCode('STG-ABCD1234EFGH', {
    env,
    fetchImpl: mockValidateFetch(async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ ok: false, error: 'Unauthorized.' });
      }
    }))
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, 'unavailable');

  const unavailable = await validateStaffTelegramIntegrationCode('STG-ABCD1234EFGH', {
    env,
    fetchImpl: mockValidateFetch(async () => {
      throw new Error('network down');
    })
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'unavailable');

  await store.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
  console.log('All staff Telegram enrollment Phase 1 checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
