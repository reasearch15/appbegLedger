import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { createReplySender } from '../src/telegram/messageDelivery.js';

async function createTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-ledger-test-'));
  const databasePath = path.join(dir, 'test.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath });
  return { store, dir };
}

async function testBotContactUpsertSource() {
  const { store } = await createTempStore();
  const user = await store.upsertTelegramUser({
    id: 12345,
    username: 'first_name',
    first_name: 'First',
    last_name: 'User',
    is_bot: false
  });
  assert.equal(user.telegram_id, 12345);
  assert.equal(user.telegram_sync_source, 'bot_api');
  assert.equal(user.active_messaging_source, 'bot_api');

  const updated = await store.upsertTelegramUser({
    id: 12345,
    username: 'changed_name',
    first_name: 'Changed',
    last_name: 'User',
    is_bot: false
  });
  assert.equal(updated.id, user.id);
  assert.equal(updated.username, 'changed_name');
  assert.equal((await store.listUsers()).length, 1);
  await store.close?.();
}

async function testCallbackJobDedupe() {
  const { store } = await createTempStore();
  const user = await store.upsertTelegramUser({ id: 99, first_name: 'Callback', is_bot: false });
  const first = await store.createBotJob({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    incomingTelegramMessageId: 777,
    jobType: 'callback_action',
    action: 'bot:register'
  });
  const second = await store.createBotJob({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    incomingTelegramMessageId: 777,
    jobType: 'callback_action',
    action: 'bot:register'
  });
  assert.equal(second.id, first.id);
  assert.equal(second.duplicate, true);
  await store.close?.();
}

async function testBotOnlyDelivery() {
  const { store } = await createTempStore();
  const user = await store.upsertTelegramUser({ id: 555, first_name: 'Delivery', is_bot: false });
  const senderWithoutBot = await createReplySender({ store, user, bot: null });
  await assert.rejects(
    () => senderWithoutBot({ user, text: 'hello' }),
    /TELEGRAM_BOT_TOKEN bot is required/
  );

  await store.db.prepare("UPDATE telegram_users SET active_messaging_source = 'none' WHERE id = ?").run(user.id);
  const blockedUser = await store.getUserProfile(user.id);
  const fakeBot = { telegram: { sendMessage: async () => ({ message_id: 1 }) } };
  const blockedSender = await createReplySender({ store, user: blockedUser, bot: fakeBot });
  await assert.rejects(
    () => blockedSender({ user: blockedUser, text: 'hello' }),
    /not available through the official Bot API/
  );
  await store.close?.();
}

async function testPersonalSyncFailClosedSource() {
  const source = await fs.readFile('scripts/telegram_account_sync.py', 'utf8');
  assert.match(source, /def is_personal_private_sync_enabled\(\):/);
  assert.match(source, /return False/);
  assert.doesNotMatch(source, /or os\.getenv\("PAYMENT_TELEGRAM_API_ID"\)/);
  assert.doesNotMatch(source, /or os\.getenv\("PAYMENT_TELEGRAM_API_HASH"\)/);
}

await testBotContactUpsertSource();
await testCallbackJobDedupe();
await testBotOnlyDelivery();
await testPersonalSyncFailClosedSource();

console.log('ok telegram cleanup architecture');
