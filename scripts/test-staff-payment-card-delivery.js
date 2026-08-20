import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import { notifyOperationalStaffPayment } from '../src/telegram/operationalAlerts.js';
import { routeParsedPaymentWithConfidence } from '../src/payments/confidenceRouter.js';
import {
  STAFF_CB,
  asTelegramSendExtra,
  paymentCardButtons
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
const CALLBACK_DATA_LIMIT = 64;

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

function makeCbCtx({ fromId, data }) {
  const replies = [];
  let answered = null;
  return {
    replies,
    get answered() { return answered; },
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: 'Actor', username: `user${fromId}` },
    callbackQuery: { data, message: { message_id: 1 } },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body, extra) {
      replies.push({ body, extra });
      return { message_id: replies.length };
    }
  };
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

  const cases = [
    { status: 'unmatched', title: undefined, labels: reviewLabels() },
    { status: 'needs_confirmation', title: undefined, labels: reviewLabels() },
    { status: 'ambiguous', title: undefined, labels: reviewLabels() }
  ];
  let telegramMessageId = 1;
  for (const item of cases) {
    const payment = await insertPayment(store, {
      telegramMessageId: telegramMessageId++,
      status: item.status
    });
    const bot = mockTelegram();
    await notifyOperationalStaffPayment(store, payment, { bot, extra: item.title ? { title: item.title } : {} });
    const groupSend = bot.calls.send.find((call) => call.chatId === STAFF_GROUP_ID);
    assert.ok(groupSend, `${item.status} missing group send`);
    assert.match(groupSend.text, /REVIEW REQUIRED/);
    assertValidReplyMarkup(groupSend.extra, item.labels);
    const dmChats = bot.calls.send.filter((call) => call.chatId !== STAFF_GROUP_ID).map((call) => call.chatId).sort();
    assert.deepEqual(dmChats, [COADMIN_ID, ROOT_ID, STAFF_ID].sort());
    for (const dm of bot.calls.send.filter((call) => call.chatId !== STAFF_GROUP_ID)) {
      assertValidReplyMarkup(dm.extra, item.labels);
      assert.equal(dm.chatId === HUB_CHANNEL_ID, false);
    }
    console.log(`ok card: ${item.status} uses reply_markup and staff group + role DMs`);
  }

  const autoPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'deposit_window_matched'
  });
  const autoBot = mockTelegram();
  await notifyOperationalStaffPayment(store, autoPayment, {
    bot: autoBot,
    dmEveryone: false,
    extra: { title: '🟢 AUTO-CREDITED' }
  });
  assert.equal(autoBot.calls.send.length, 1);
  assert.equal(autoBot.calls.send[0].chatId, STAFF_GROUP_ID);
  assert.match(autoBot.calls.send[0].text, /AUTO-CREDITED/);
  assertValidReplyMarkup(autoBot.calls.send[0].extra, reviewLabels());
  console.log('ok card: auto-credit is group-only with reply_markup');

  const failedPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'credit_failed'
  });
  const failBot = mockTelegram();
  await notifyOperationalStaffPayment(store, failedPayment, {
    bot: failBot,
    dmEveryone: true,
    extra: { title: '🔴 CREDIT FAILED', creditFailed: true }
  });
  const failedGroup = failBot.calls.send.find((call) => call.chatId === STAFF_GROUP_ID);
  assert.ok(failedGroup);
  assert.match(failedGroup.text, /CREDIT FAILED/);
  assertValidReplyMarkup(failedGroup.extra, ['🔄 RETRY CREDIT']);
  assert.equal(failedGroup.extra.reply_markup.inline_keyboard.flat().length, 1);
  assert.equal(failBot.calls.send.filter((call) => call.chatId !== STAFF_GROUP_ID).length, 3);
  console.log('ok card: credit-failed Retry uses reply_markup');

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
  assert.equal(groupFailBot.calls.send.filter((call) => call.chatId !== STAFF_GROUP_ID).length >= 1, true);
  console.log('ok routing: group send failure does not crash payment routing');

  const dmFailBot = mockTelegram({
    sendBehavior: ({ chatId }) => (
      String(chatId) === ROOT_ID ? telegramError('Forbidden: bot was blocked by the user') : null
    )
  });
  const dmPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const dmSent = await notifyOperationalStaffPayment(store, dmPayment, { bot: dmFailBot });
  assert.equal(dmSent.group, true);
  assert.equal(dmSent.dms, 2);
  assert.equal(dmSent.failures.some((item) => String(item.target) === ROOT_ID), true);
  const remaining = dmFailBot.calls.send.filter((call) => call.chatId === COADMIN_ID || call.chatId === STAFF_ID);
  assert.equal(remaining.length, 2);
  console.log('ok delivery: one failing staff DM does not stop other recipients');

  process.env.STAFF_TELEGRAM_GROUP_ID = HUB_CHANNEL_ID;
  const hubBot = mockTelegram();
  const hubPayment = await insertPayment(store, {
    telegramMessageId: telegramMessageId++,
    status: 'unmatched'
  });
  const refused = await notifyOperationalStaffPayment(store, hubPayment, { bot: hubBot });
  assert.equal(hubBot.calls.send.some((call) => call.chatId === HUB_CHANNEL_ID && /REVIEW REQUIRED|Calvin/.test(call.text)), false);
  assert.equal(refused.failures.some((item) => item.error === 'refused_hub_target'), true);
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  console.log('ok privacy: Hub cannot be used as staff payment target');

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
