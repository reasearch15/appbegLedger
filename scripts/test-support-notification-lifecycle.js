import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  buildSupportRequestMessage,
  buildSupportRequestReplyMarkup,
  sendSupportBotNotification
} from '../src/telegram/supportNotificationBot.js';
import { handleSupportCallback } from '../src/telegram/supportNotificationListener.js';

function fetchOk(calls) {
  return async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 1000 + calls.length } };
      }
    };
  };
}

function fakeBot(edits) {
  return {
    telegram: {
      async editMessageText(chatId, messageId, _inlineId, text, options = {}) {
        edits.push({ chatId: String(chatId), messageId, text, options });
        return true;
      }
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

async function createRequest(store, kind, overrides = {}) {
  return await store.createSupportRequest({
    kind,
    username: 'Amyfi02',
    topic: kind === 'support' || kind === 'faq' ? 'Cashout Help' : null,
    question: kind === 'inquiry' ? 'Hello this is a test.' : null,
    fingerprint: `${kind}:${Math.random()}`,
    ...overrides
  });
}

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'support-lifecycle-'));
  const dbPath = path.join(tmp, 'test.sqlite');
  let store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });

  await store.upsertSupportNotificationSubscriber({ telegramChatId: '1001', telegramUserId: 501 });
  await store.upsertSupportNotificationSubscriber({ telegramChatId: '1002', telegramUserId: 502 });

  const calls = [];
  const request = await createRequest(store, 'freeplay');
  const pendingText = buildSupportRequestMessage(request);
  assert.match(pendingText, /Status: 🟡 PENDING/);
  assert.doesNotMatch(pendingText, /AppBeg Username:/);

  const pendingMarkup = buildSupportRequestReplyMarkup(request);
  assert.deepEqual(
    pendingMarkup.inline_keyboard[0].map((button) => button.text),
    ['🔵 Claim', '🟢 Done']
  );
  assert.deepEqual(
    pendingMarkup.inline_keyboard[0].map((button) => button.callback_data),
    [`support:claim:${request.id}`, `support:done:${request.id}`]
  );

  await sendSupportBotNotification({
    store,
    kind: 'freeplay',
    request,
    env: { SUPPORT_NOTIFICATION_BOT_TOKEN: 'token' },
    fetchImpl: fetchOk(calls)
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /Status: 🟡 PENDING/);
  assert.equal(calls[0].reply_markup.inline_keyboard[0][0].callback_data, `support:claim:${request.id}`);

  const edits = [];
  const bot = fakeBot(edits);
  const doneBeforeClaim = callbackCtx({ userId: 501, firstName: 'Staff01', data: `support:done:${request.id}` });
  await handleSupportCallback(doneBeforeClaim, store, bot);
  assert.deepEqual(doneBeforeClaim.answers, ['Claim this job first.']);
  assert.equal((await store.getSupportRequest(request.id)).status, 'pending');

  const claim = callbackCtx({ userId: 501, firstName: 'Staff01', data: `support:claim:${request.id}` });
  await handleSupportCallback(claim, store, bot);
  assert.deepEqual(claim.answers, ['Claimed.']);
  let claimed = await store.getSupportRequest(request.id);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimed_by_telegram_user_id, '501');
  assert.equal(claimed.claimed_by_name, 'Staff01');
  assert.equal(edits.length, 2);
  assert.match(edits.at(-1).text, /Status: 🔵 CLAIMED/);
  assert.match(edits.at(-1).text, /Claimed by: Staff01/);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard.length, 1);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data, `support:done:${request.id}`);

  const secondClaim = callbackCtx({ userId: 502, firstName: 'Staff02', data: `support:claim:${request.id}` });
  await handleSupportCallback(secondClaim, store, bot);
  assert.deepEqual(secondClaim.answers, ['Already claimed by Staff01.']);
  claimed = await store.getSupportRequest(request.id);
  assert.equal(claimed.claimed_by_telegram_user_id, '501');

  const wrongDone = callbackCtx({ userId: 502, firstName: 'Staff02', data: `support:done:${request.id}` });
  await handleSupportCallback(wrongDone, store, bot);
  assert.deepEqual(wrongDone.answers, ['Only Staff01 can complete this job.']);
  assert.equal((await store.getSupportRequest(request.id)).status, 'claimed');

  const done = callbackCtx({ userId: 501, firstName: 'Staff01', data: `support:done:${request.id}` });
  await handleSupportCallback(done, store, bot);
  assert.deepEqual(done.answers, ['Completed.']);
  const completed = await store.getSupportRequest(request.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed_by_telegram_user_id, '501');
  assert.match(buildSupportRequestMessage(completed), /Status: 🟢 COMPLETED/);
  assert.equal(buildSupportRequestReplyMarkup(completed), undefined);
  assert.match(edits.at(-1).text, /✅ Job completed/);
  assert.equal(edits.at(-1).options.reply_markup, undefined);

  const staleDone = callbackCtx({ userId: 501, firstName: 'Staff01', data: `support:done:${request.id}` });
  await handleSupportCallback(staleDone, store, bot);
  assert.deepEqual(staleDone.answers, ['This job is already completed.']);

  const rapidClaimRequest = await createRequest(store, 'support');
  const rapidClaims = await Promise.all([
    store.claimSupportRequest(rapidClaimRequest.id, { telegramUserId: 501, displayName: 'Staff01' }),
    store.claimSupportRequest(rapidClaimRequest.id, { telegramUserId: 502, displayName: 'Staff02' })
  ]);
  assert.equal(rapidClaims.filter((item) => item.ok).length, 1);

  const rapidDoneRequest = rapidClaims.find((item) => item.ok).request;
  const rapidDones = await Promise.all([
    store.completeSupportRequest(rapidDoneRequest.id, {
      telegramUserId: rapidDoneRequest.claimed_by_telegram_user_id,
      displayName: rapidDoneRequest.claimed_by_name
    }),
    store.completeSupportRequest(rapidDoneRequest.id, {
      telegramUserId: rapidDoneRequest.claimed_by_telegram_user_id,
      displayName: rapidDoneRequest.claimed_by_name
    })
  ]);
  assert.equal(rapidDones.filter((item) => item.ok).length, 1);

  for (const kind of ['freeplay', 'inquiry', 'faq', 'support']) {
    const item = await createRequest(store, kind);
    const text = buildSupportRequestMessage(item);
    assert.match(text, /RoyalVIP Username: Amyfi02/);
    assert.doesNotMatch(text, /AppBeg Username:/);
    assert.match(text, /Status: 🟡 PENDING/);
  }

  await store.db.close();
  store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  assert.equal((await store.getSupportRequest(request.id)).status, 'completed');
  assert.equal((await store.listSupportRequestDeliveries(request.id)).length, 2);
  await store.db.close();
  await fs.rm(tmp, { recursive: true, force: true });

  console.log('All support notification lifecycle checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
