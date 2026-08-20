import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import { notifyOperationalStaffPayment, notifyUnmatchedCandidates } from '../src/telegram/operationalAlerts.js';
import { routeParsedPaymentWithConfidence } from '../src/payments/confidenceRouter.js';
import {
  STAFF_CB,
  asTelegramSendExtra,
  paymentCardButtons,
  isPaymentReviewCallback
} from '../src/telegram/staffCards.js';
import {
  handleStaffCallbackQuery,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { ensureStaffControlCenter } from '../src/telegram/staffControlCenter.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-payment-cards-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const STAFF_GROUP_ID = '-1004419236086';
const HUB_CHANNEL_ID = '-1004300917295';
const ROOT_ID = '9001';
const COADMIN_ID = '8002';
const STAFF_ID = '8003';
const PLAYER_ID = '7001';
const CALLBACK_DATA_LIMIT = 64;
const PRIVATE_PAYMENT_REJECTION = 'This action is only available in the staff review group.';

function telegramError(description) {
  const error = new Error(description);
  error.description = description;
  error.response = { description };
  return error;
}

function mockTelegram({ sendBehavior = null } = {}) {
  const calls = { send: [] };
  return {
    calls,
    telegram: {
      async sendMessage(chatId, text, extra = {}) {
        calls.send.push({ chatId: String(chatId), text, extra });
        if (typeof sendBehavior === 'function') {
          const override = sendBehavior({ chatId, text, extra });
          if (override) throw override;
        }
        return { message_id: calls.send.length };
      },
      async editMessageText() {
        return true;
      },
      async pinChatMessage() {
        return true;
      }
    }
  };
}

function makeCbCtx({ fromId, data, chatId = STAFF_GROUP_ID, chatType = 'supergroup' }) {
  const replies = [];
  let answered = null;
  const numericChatId = Number(chatId);
  return {
    replies,
    get answered() { return answered; },
    chat: { id: numericChatId, type: chatType },
    from: { id: Number(fromId), first_name: 'Actor', username: `user${fromId}` },
    callbackQuery: {
      data,
      message: { message_id: 1, chat: { id: numericChatId, type: chatType } }
    },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body, extra) {
      replies.push({ body, extra });
      return { message_id: replies.length };
    }
  };
}

function assertStaffGroupOnly(bot, { textPattern = /REVIEW REQUIRED/, labels = reviewLabels() } = {}) {
  assert.equal(bot.calls.send.length, 1, `expected exactly one send, got ${bot.calls.send.map((c) => c.chatId).join(',')}`);
  assert.equal(bot.calls.send[0].chatId, STAFF_GROUP_ID);
  assert.match(bot.calls.send[0].text, textPattern);
  assertValidReplyMarkup(bot.calls.send[0].extra, labels);
  const forbidden = new Set([ROOT_ID, COADMIN_ID, STAFF_ID, PLAYER_ID, HUB_CHANNEL_ID]);
  for (const call of bot.calls.send) {
    assert.equal(forbidden.has(call.chatId), false, `unexpected private/hub send to ${call.chatId}`);
  }
}

function assertValidReplyMarkup(extra, expectedLabels) {
  assert.equal(extra.inline_keyboard, undefined);
  assert.ok(extra.reply_markup);
  assert.ok(Array.isArray(extra.reply_markup.inline_keyboard));
  const labels = extra.reply_markup.inline_keyboard.flat().map((button) => button.text);
  for (const label of expectedLabels) {
    assert.equal(labels.includes(label), true, `missing button ${label}`);
  }
  for (const button of extra.reply_markup.inline_keyboard.flat()) {
    assert.ok(typeof button.callback_data === 'string');
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') <= CALLBACK_DATA_LIMIT,
      `callback_data too long: ${button.callback_data}`
    );
  }
}

function reviewLabels(frozen = false) {
  return [
    '✅ CREDIT',
    '🔎 ASSIGN PLAYER',
    '💬 ASK PLAYER',
    frozen ? '🔓 UNFREEZE' : '❄️ FREEZE',
    '🚫 IGNORE'
  ];
}

async function insertPayment(store, {
  telegramMessageId,
  name = 'Calvin M.',
  amount = 12,
  status = 'unmatched'
} = {}) {
  const now = new Date().toISOString();
  const result = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      message_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 'Parsed', ?, ?, ?, 'Chime', ?, ?, ?)
  `).run(
    telegramMessageId,
    -100,
    'Pay',
    `You received $${amount}.00 from ${name}.`,
    status,
    amount,
    name,
    now,
    now,
    now
  );
  return store.getPaymentEvent(result.lastInsertRowid);
}

async function run() {
  __resetStaffPendingPromptsForTests();
  const previous = {
    hub: process.env.ROYAL_VIP_HUB_CHANNEL_ID,
    group: process.env.STAFF_TELEGRAM_GROUP_ID,
    root: process.env.ROOT_ADMIN_TELEGRAM_USER_ID
  };
  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = ROOT_ID;

  const wrapped = asTelegramSendExtra(paymentCardButtons(99));
  assert.equal(wrapped.inline_keyboard, undefined);
  assert.ok(wrapped.reply_markup.inline_keyboard);
  const already = asTelegramSendExtra({ reply_markup: { inline_keyboard: [[{ text: 'X', callback_data: 'op:cc' }]] } });
  assert.deepEqual(already.reply_markup.inline_keyboard[0][0].text, 'X');
  console.log('ok helper: wraps inline_keyboard once and does not double-wrap');

  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  await store.bootstrapRootAdminFromEnv();
  await store.grantOperationalRole({
    telegramUserId: COADMIN_ID,
    role: OPERATIONAL_ROLES.COADMIN,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Coadmin'
  });
  await store.grantOperationalRole({
    telegramUserId: STAFF_ID,
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Alice'
  });
  await store.upsertTelegramUser({
    id: Number(ROOT_ID),
    first_name: 'Picasso',
    username: 'rootadmin',
    is_bot: false
  });
  const ordinaryPlayer = await store.upsertTelegramUser({
    id: Number(PLAYER_ID),
    first_name: 'Player',
    username: 'normalplayer',
    is_bot: false
  });

  assert.equal(isPaymentReviewCallback(`${STAFF_CB.CREDIT}12`), true);
  assert.equal(isPaymentReviewCallback(`${STAFF_CB.FREEZE}12`), true);
  assert.equal(isPaymentReviewCallback(STAFF_CB.PENDING_PAYMENTS), true);
  assert.equal(isPaymentReviewCallback(STAFF_CB.CTRL), false);
  assert.equal(isPaymentReviewCallback(STAFF_CB.FP_GIVE), false);

  const cases = [
    { status: 'unmatched', labels: reviewLabels() },
    { status: 'needs_confirmation', labels: reviewLabels() },
    { status: 'ambiguous', labels: reviewLabels() }
  ];
  let telegramMessageId = 1;
  for (const item of cases) {
    const payment = await insertPayment(store, {
      telegramMessageId: telegramMessageId++,
      status: item.status
    });
    const bot = mockTelegram();
    const sent = await notifyOperationalStaffPayment(store, payment, { bot });
    assert.equal(sent.group, true);
    assert.equal(sent.dms, 0);
    assertStaffGroupOnly(bot, { labels: item.labels });
    console.log(`ok card: ${item.status} staff-group only with reply_markup`);
  }

  const autoPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'deposit_window_matched'
  });
  const autoBot = mockTelegram();
  await notifyOperationalStaffPayment(store, autoPayment, {
    bot: autoBot,
    extra: { title: '🟢 AUTO-CREDITED' }
  });
  assertStaffGroupOnly(autoBot, { textPattern: /AUTO-CREDITED/, labels: reviewLabels() });
  console.log('ok card: auto-credit is staff-group only with reply_markup');

  const failedPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'credit_failed'
  });
  const failBot = mockTelegram();
  await notifyOperationalStaffPayment(store, failedPayment, {
    bot: failBot,
    extra: { title: '🔴 CREDIT FAILED', creditFailed: true }
  });
  assertStaffGroupOnly(failBot, { textPattern: /CREDIT FAILED/, labels: ['🔄 RETRY CREDIT'] });
  assert.equal(failBot.calls.send[0].extra.reply_markup.inline_keyboard.flat().length, 1);
  console.log('ok card: credit-failed Retry is staff-group only');

  const hugeId = 9007199254740991;
  const hugeButtons = asTelegramSendExtra(paymentCardButtons(hugeId, { creditFailed: true }));
  assert.ok(Buffer.byteLength(hugeButtons.reply_markup.inline_keyboard[0][0].callback_data, 'utf8') <= CALLBACK_DATA_LIMIT);
  console.log('ok callback_data stays within Telegram 64-byte limit');

  const forged = makeCbCtx({ fromId: '5555', data: `${STAFF_CB.CREDIT}1` });
  await handleStaffCallbackQuery({ ctx: forged, store, bot: mockTelegram() });
  assert.equal(forged.answered, 'Not authorized');
  const forgedAsk = makeCbCtx({ fromId: '5555', data: `${STAFF_CB.ASK}1` });
  await handleStaffCallbackQuery({ ctx: forgedAsk, store, bot: mockTelegram() });
  assert.equal(forgedAsk.answered, 'Not authorized');
  const forgedRetry = makeCbCtx({ fromId: '5555', data: `${STAFF_CB.RETRY}1` });
  await handleStaffCallbackQuery({ ctx: forgedRetry, store, bot: mockTelegram() });
  assert.equal(forgedRetry.answered, 'Not authorized');
  console.log('ok callbacks fresh-check operational role');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {

  const groupFailBot = mockTelegram({
    sendBehavior: ({ chatId }) => (
      String(chatId) === STAFF_GROUP_ID ? telegramError('Bad Request: chat not found') : null
    )
  });
  const routedPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    name: 'Shana B.',
    amount: 12,
    status: 'unrouted'
  });
  const routed = await routeParsedPaymentWithConfidence(store, routedPayment, {
    payment_sender_name: 'Shana B.',
    amount: 12
  }, { bot: groupFailBot });
  assert.equal(routed.used, true);
  assert.equal(routed.result.ok, true);
  assert.equal(routed.result.outcome, 'unmatched');
  const afterRoute = await store.getPaymentEvent(routedPayment.id);
  assert.equal(afterRoute.routing_status, 'unmatched');
  assert.equal(groupFailBot.calls.send.some((call) => call.chatId === STAFF_GROUP_ID), true);
  assert.equal(groupFailBot.calls.send.filter((call) => call.chatId !== STAFF_GROUP_ID).length, 0);
  assert.equal(warnings.some((line) => line.includes('[payment-review] delivery_failed') && line.includes('send_failed')), true);
  console.log('ok routing: group send failure does not crash or fall back to DMs');

  const playerBot = mockTelegram();
  const playerPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  await notifyOperationalStaffPayment(store, playerPayment, { bot: playerBot });
  assert.equal(playerBot.calls.send.some((call) => call.chatId === String(ordinaryPlayer.telegram_id || PLAYER_ID)), false);
  assert.equal(playerBot.calls.send.some((call) => /REVIEW REQUIRED/.test(call.text) && call.chatId !== STAFF_GROUP_ID), false);
  console.log('ok privacy: ordinary player never receives review card');

  delete process.env.STAFF_TELEGRAM_GROUP_ID;
  const missingBot = mockTelegram();
  const missingPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const missingSent = await notifyOperationalStaffPayment(store, missingPayment, { bot: missingBot });
  assert.equal(missingBot.calls.send.length, 0);
  assert.equal(missingSent.group, false);
  assert.equal(missingSent.dms, 0);
  assert.equal(missingSent.reason, 'unconfigured');
  assert.equal(warnings.some((line) => line.includes('[payment-review] delivery_failed') && line.includes('unconfigured')), true);
  process.env.STAFF_TELEGRAM_GROUP_ID = 'not-a-chat-id';
  const invalidBot = mockTelegram();
  const invalidSent = await notifyOperationalStaffPayment(store, missingPayment, { bot: invalidBot });
  assert.equal(invalidBot.calls.send.length, 0);
  assert.equal(invalidSent.reason, 'invalid');
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  console.log('ok fail-closed: missing/invalid staff group does not DM anyone');

  process.env.STAFF_TELEGRAM_GROUP_ID = HUB_CHANNEL_ID;
  const hubBot = mockTelegram();
  const hubPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const refused = await notifyOperationalStaffPayment(store, hubPayment, { bot: hubBot });
  assert.equal(hubBot.calls.send.length, 0);
  assert.equal(refused.failures.some((item) => item.error === 'refused_hub_target'), true);
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  } finally {
    console.warn = origWarn;
  }
  console.log('ok privacy: Hub cannot be used as staff payment target');

  const freezePayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const privateFreeze = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.FREEZE}${freezePayment.id}`,
    chatId: ROOT_ID,
    chatType: 'private'
  });
  await handleStaffCallbackQuery({ ctx: privateFreeze, store, bot: mockTelegram() });
  assert.equal(privateFreeze.answered, PRIVATE_PAYMENT_REJECTION);
  assert.equal(privateFreeze.replies.length, 0);
  assert.equal((await store.getPaymentEvent(freezePayment.id)).routing_status, 'unmatched');

  const creditPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const privateCredit = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.CREDIT}${creditPayment.id}`,
    chatId: ROOT_ID,
    chatType: 'private'
  });
  await handleStaffCallbackQuery({ ctx: privateCredit, store, bot: mockTelegram() });
  assert.equal(privateCredit.answered, PRIVATE_PAYMENT_REJECTION);
  assert.equal((await store.getPaymentEvent(creditPayment.id)).routing_status, 'unmatched');

  const privateAsk = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.ASK}${creditPayment.id}`,
    chatId: ROOT_ID,
    chatType: 'private'
  });
  await handleStaffCallbackQuery({ ctx: privateAsk, store, bot: mockTelegram() });
  assert.equal(privateAsk.answered, PRIVATE_PAYMENT_REJECTION);
  const privateIgnore = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.IGNORE}${creditPayment.id}`,
    chatId: ROOT_ID,
    chatType: 'private'
  });
  await handleStaffCallbackQuery({ ctx: privateIgnore, store, bot: mockTelegram() });
  assert.equal(privateIgnore.answered, PRIVATE_PAYMENT_REJECTION);
  console.log('ok private payment callbacks refuse without mutating');

  const groupFreeze = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.FREEZE}${freezePayment.id}`
  });
  await handleStaffCallbackQuery({ ctx: groupFreeze, store, bot: mockTelegram() });
  assert.equal(groupFreeze.answered, 'Frozen');
  assert.equal((await store.getPaymentEvent(freezePayment.id)).routing_status, 'frozen');

  const groupCredit = makeCbCtx({
    fromId: ROOT_ID,
    data: `${STAFF_CB.CREDIT}${creditPayment.id}`
  });
  await handleStaffCallbackQuery({ ctx: groupCredit, store, bot: mockTelegram() });
  assert.notEqual(groupCredit.answered, PRIVATE_PAYMENT_REJECTION);
  assert.equal((await store.getPaymentEvent(creditPayment.id)).routing_status, 'unmatched');
  console.log('ok staff-group payment callbacks still operate');

  const candidateBot = mockTelegram();
  const candidatePayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  await notifyUnmatchedCandidates(store, {
    bot: candidateBot,
    requesterName: 'Player',
    payments: [candidatePayment]
  });
  assert.equal(candidateBot.calls.send.length, 1);
  assert.equal(candidateBot.calls.send[0].chatId, STAFF_GROUP_ID);
  console.log('ok unmatched-candidate alert is staff-group only');

  const ccBot = mockTelegram();
  const cc = await ensureStaffControlCenter({ store, bot: ccBot, pin: false });
  assert.equal(cc.ok, true);
  const ccSend = ccBot.calls.send.find((call) => /CONTROL CENTER/.test(call.text));
  assert.ok(ccSend);
  assert.ok(ccSend.extra.reply_markup.inline_keyboard);
  assert.equal(ccSend.extra.inline_keyboard, undefined);
  console.log('ok control center send uses reply_markup');

  if (previous.hub == null) delete process.env.ROYAL_VIP_HUB_CHANNEL_ID;
  else process.env.ROYAL_VIP_HUB_CHANNEL_ID = previous.hub;
  if (previous.group == null) delete process.env.STAFF_TELEGRAM_GROUP_ID;
  else process.env.STAFF_TELEGRAM_GROUP_ID = previous.group;
  if (previous.root == null) delete process.env.ROOT_ADMIN_TELEGRAM_USER_ID;
  else process.env.ROOT_ADMIN_TELEGRAM_USER_ID = previous.root;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
