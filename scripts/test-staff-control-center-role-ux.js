import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  OPERATIONAL_ROLES,
  isStaffGroupChat,
  normalizeTelegramUserId
} from '../src/telegram/operationalRoles.js';
import {
  STAFF_CB,
  sharedControlCenterButtons,
  sharedControlCenterText
} from '../src/telegram/staffCards.js';
import { controlCenterButtons } from '../src/telegram/staffOperations.js';
import {
  handleStaffCallbackQuery,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { ensureStaffControlCenter } from '../src/telegram/staffControlCenter.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-cc-role-ux-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const STAFF_GROUP_ID = '-1004419236086';
const HUB_CHANNEL_ID = '-1004300917295';
const ROOT_ID = '8448609518';
const COADMIN_ID = '8002';
const STAFF_ID = '8003';
const PICASSO_ID = '5476500286';
const ROOT_BUTTONS = [
  '⚡ CONFIDENCE MODE',
  '👥 STAFF MANAGEMENT',
  '👑 HUB MANAGEMENT',
  '💰 PAYMENTS',
  '🎁 FREEPLAY'
];
const STAFF_BUTTONS = ['💰 PAYMENTS', '🎁 FREEPLAY'];

function extraKeyboard(extra) {
  return extra?.reply_markup?.inline_keyboard || extra?.inline_keyboard || [];
}

function extraLabels(extra) {
  return extraKeyboard(extra).flat().map((button) => button.text);
}

function mockTelegram() {
  const calls = { send: [], pin: [] };
  return {
    calls,
    telegram: {
      async sendMessage(chatId, text, extra = {}) {
        calls.send.push({ chatId: String(chatId), text, extra });
        return { message_id: calls.send.length };
      },
      async editMessageText() {
        return true;
      },
      async pinChatMessage(chatId, messageId) {
        calls.pin.push({ chatId: String(chatId), messageId });
        return true;
      }
    }
  };
}

function makeCbCtx({ fromId, data, chatId = STAFF_GROUP_ID, chatType = 'supergroup' }) {
  const replies = [];
  let answered = null;
  return {
    replies,
    get answered() { return answered; },
    chat: { id: Number(chatId), type: chatType },
    from: { id: fromId, first_name: 'Actor' },
    callbackQuery: { data, message: { message_id: 1, chat: { id: Number(chatId), type: chatType } } },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body, extra) {
      replies.push({ body, extra });
      return { message_id: replies.length };
    }
  };
}

async function routeStaffGroupCallback(ctx, store, bot) {
  if (ctx.chat?.type !== 'private' || !ctx.from) {
    if (isStaffGroupChat(ctx.chat?.id)) {
      return handleStaffCallbackQuery({ ctx, store, bot });
    }
    return false;
  }
  return handleStaffCallbackQuery({ ctx, store, bot });
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

  assert.equal(normalizeTelegramUserId(8448609518), ROOT_ID);
  assert.equal(normalizeTelegramUserId('8448609518'), ROOT_ID);
  assert.notEqual(8448609518 | 0, 8448609518);
  assert.equal(Number.isSafeInteger(8448609518), true);
  console.log('ok 13-14: Root Telegram ID normalizes as number and string; no 32-bit truncation');

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

  const pinBot = mockTelegram();
  const pinned = await ensureStaffControlCenter({ store, bot: pinBot });
  assert.equal(pinned.ok, true);
  const pinSend = pinBot.calls.send[0];
  assert.equal(pinSend.text, sharedControlCenterText());
  assert.equal(pinSend.text.includes('Your role: root_admin'), false);
  assert.match(pinSend.text, /Manage Royal VIP operations securely/);
  const pinLabels = extraLabels(pinSend.extra);
  assert.deepEqual(pinLabels, ['OPEN CONTROL CENTER']);
  assert.equal(extraKeyboard(pinSend.extra)[0][0].callback_data, STAFF_CB.CTRL);
  assert.equal(STAFF_CB.CTRL, 'op:cc');
  assert.deepEqual(sharedControlCenterButtons().inline_keyboard[0][0].callback_data, 'op:cc');
  console.log('ok 1-3: shared pin is role-neutral and only OPEN CONTROL CENTER / op:cc');

  const rootOpen = makeCbCtx({ fromId: 8448609518, data: STAFF_CB.CTRL });
  await handleStaffCallbackQuery({ ctx: rootOpen, store, bot: pinBot });
  assert.match(rootOpen.replies[0].body, /Your role: root_admin/);
  assert.deepEqual(extraLabels(rootOpen.replies[0].extra), ROOT_BUTTONS);
  const rootOpenStr = makeCbCtx({ fromId: '8448609518', data: 'op:cc' });
  await handleStaffCallbackQuery({ ctx: rootOpenStr, store, bot: pinBot });
  assert.deepEqual(extraLabels(rootOpenStr.replies[0].extra), ROOT_BUTTONS);
  console.log('ok 4/12: Root 8448609518 sees full lowercase root_admin Control Center');

  const coadminOpen = makeCbCtx({ fromId: COADMIN_ID, data: STAFF_CB.CTRL });
  await handleStaffCallbackQuery({ ctx: coadminOpen, store, bot: pinBot });
  assert.match(coadminOpen.replies[0].body, /Your role: coadmin/);
  assert.deepEqual(extraLabels(coadminOpen.replies[0].extra), ROOT_BUTTONS);
  assert.deepEqual(
    controlCenterButtons(OPERATIONAL_ROLES.COADMIN).inline_keyboard.flat().map((button) => button.text),
    ROOT_BUTTONS
  );
  console.log('ok 5: Coadmin sees Coadmin-authorized controls');

  const staffOpen = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.CTRL });
  await handleStaffCallbackQuery({ ctx: staffOpen, store, bot: pinBot });
  assert.match(staffOpen.replies[0].body, /Your role: staff/);
  assert.deepEqual(extraLabels(staffOpen.replies[0].extra), STAFF_BUTTONS);
  console.log('ok 6: Staff sees only Payments and Freeplay');

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  try {
    const none = makeCbCtx({ fromId: '5555', data: STAFF_CB.CTRL });
    await handleStaffCallbackQuery({ ctx: none, store, bot: pinBot });
    assert.equal(none.answered, 'Not authorized');
    assert.equal(none.replies.length, 0);
    const picasso = makeCbCtx({ fromId: Number(PICASSO_ID), data: STAFF_CB.PENDING_PAYMENTS });
    await handleStaffCallbackQuery({ ctx: picasso, store, bot: pinBot });
    assert.equal(picasso.answered, 'Not authorized');
    const forbiddenLine = warns.find((line) => line.includes('[staff-cb] forbidden') && line.includes('actor=5476500286'));
    assert.ok(forbiddenLine);
    assert.match(forbiddenLine, /actor=5476500286/);
    assert.match(forbiddenLine, new RegExp(`chat=${STAFF_GROUP_ID}`));
    assert.match(forbiddenLine, /data=op:pp/);
    assert.equal(/token|password|secret/i.test(forbiddenLine), false);
    console.log('ok 7-8/15: no-role and Picasso are unauthorized; forbidden log is safe');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(isStaffGroupChat(STAFF_GROUP_ID), true);
  assert.equal(isStaffGroupChat(HUB_CHANNEL_ID), false);
  const memberOnly = makeCbCtx({ fromId: PICASSO_ID, data: STAFF_CB.CTRL, chatId: STAFF_GROUP_ID });
  await handleStaffCallbackQuery({ ctx: memberOnly, store, bot: pinBot });
  assert.equal(memberOnly.answered, 'Not authorized');
  console.log('ok 9-10: group membership / Telegram admin identity do not authorize');

  const paymentsBefore = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.PENDING_PAYMENTS });
  await handleStaffCallbackQuery({ ctx: paymentsBefore, store, bot: pinBot });
  assert.notEqual(paymentsBefore.answered, 'Not authorized');
  await store.revokeOperationalRole({
    telegramUserId: STAFF_ID,
    revokedByTelegramUserId: ROOT_ID
  });
  const stale = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.PENDING_PAYMENTS });
  await handleStaffCallbackQuery({ ctx: stale, store, bot: pinBot });
  assert.equal(stale.answered, 'Not authorized');
  console.log('ok 11: revoked Staff stale PAYMENTS button is unauthorized');

  const hubCtx = makeCbCtx({
    fromId: ROOT_ID,
    data: STAFF_CB.CTRL,
    chatId: HUB_CHANNEL_ID,
    chatType: 'channel'
  });
  const hubRouted = await routeStaffGroupCallback(hubCtx, store, pinBot);
  assert.equal(hubRouted, false);
  assert.equal(hubCtx.replies.length, 0);
  console.log('ok 16: public Hub callbacks are not routed to Staff CRM controls');

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
