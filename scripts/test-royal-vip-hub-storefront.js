import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import {
  ROYAL_VIP_HUB_STOREFRONT_TEXT,
  royalVipBotDeepLinks,
  royalVipHubStorefrontMarkup
} from '../src/telegram/channelDeepLinks.js';
import { describeRoyalVipHubStatus, ensureRoyalVipHubStorefront } from '../src/telegram/royalVipHubManager.js';
import { ensureStaffControlCenter } from '../src/telegram/staffControlCenter.js';
import { notifyOperationalStaffPayment } from '../src/telegram/operationalAlerts.js';
import {
  controlCenterButtons,
  staffAssignAndCredit,
  staffFreezePayment,
  staffIgnorePayment,
  mirrorPlayerMessageToStaffTopic
} from '../src/telegram/staffOperations.js';
import { STAFF_CB, paymentCardButtons } from '../src/telegram/staffCards.js';
import {
  handleStaffCallbackQuery,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { ROUTING_STATUS } from '../src/payments/constants.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-vip-hub-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const STAFF_GROUP_ID = '-100555000';
const HUB_CHANNEL_ID = '-100777000';
const ROOT_ID = '9001';
const COADMIN_ID = '8002';
const STAFF_ID = '8003';

function telegramError(description) {
  const error = new Error(description);
  error.description = description;
  error.response = { description };
  return error;
}

function mockHubTelegram({
  editBehavior = null,
  sendBehavior = null,
  pinBehavior = null,
  startId = 100
} = {}) {
  const calls = { send: [], edit: [], pin: [], getMe: 0, createForumTopic: 0, reopen: [] };
  let nextId = startId;
  return {
    calls,
    telegram: {
      async getMe() {
        calls.getMe += 1;
        return { username: 'RoyalVipBot' };
      },
      async sendMessage(chatId, text, extra = {}) {
        calls.send.push({ chatId: String(chatId), text, extra });
        if (typeof sendBehavior === 'function') {
          const override = sendBehavior({ chatId, text, extra });
          if (override) throw override;
        }
        nextId += 1;
        return { message_id: nextId, message_thread_id: extra.message_thread_id || undefined };
      },
      async editMessageText(chatId, messageId, _inlineId, text, extra = {}) {
        calls.edit.push({ chatId: String(chatId), messageId, text, extra });
        if (typeof editBehavior === 'function') {
          const override = editBehavior({ chatId, messageId, text, extra });
          if (override) throw override;
        }
        return true;
      },
      async pinChatMessage(chatId, messageId, extra = {}) {
        calls.pin.push({ chatId: String(chatId), messageId, extra });
        if (typeof pinBehavior === 'function') {
          const override = pinBehavior({ chatId, messageId, extra });
          if (override) throw override;
        }
        return true;
      },
      async createForumTopic() {
        calls.createForumTopic += 1;
        return { message_thread_id: 88, name: 'Player' };
      },
      async reopenForumTopic(chatId, threadId) {
        calls.reopen.push({ chatId: String(chatId), threadId });
        return true;
      }
    }
  };
}

function makeCbCtx({ fromId, data, firstName = 'Staff' }) {
  const replies = [];
  let answered = null;
  return {
    replies,
    get answered() { return answered; },
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName, username: `user${fromId}` },
    callbackQuery: { data, message: { message_thread_id: 1 } },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body, extra) {
      replies.push({ body, extra });
      return { message_id: replies.length };
    }
  };
}

async function insertPayment(store, { telegramMessageId, name = 'Calvin M.', amount = 10, status = 'unmatched', payerContactId = null }) {
  const now = new Date().toISOString();
  const result = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      payer_contact_id, message_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 'Parsed', ?, ?, ?, 'Chime', ?, ?, ?, ?)
  `).run(
    telegramMessageId,
    -100,
    'Pay',
    `You received $${amount}.00 from ${name}.`,
    status,
    amount,
    name,
    payerContactId,
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
    root: process.env.ROOT_ADMIN_TELEGRAM_USER_ID,
    bot: process.env.TELEGRAM_BOT_USERNAME
  };
  delete process.env.ROYAL_VIP_HUB_CHANNEL_ID;
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = ROOT_ID;
  process.env.TELEGRAM_BOT_USERNAME = 'RoyalVipBot';

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

  const calvin = await store.upsertTelegramUser({
    telegram_id: 1001,
    username: 'calvin',
    first_name: 'Calvin',
    is_bot: false
  });
  await store.updateRegistrationStatus(calvin.id, 'Registered', 'Test');
  await store.updateAutomationState(calvin.id, {
    registrationInfo: {
      preferred_appbeg_username: 'Calvin',
      appbeg_player_uid: 'player-calvin',
      appbeg_creation_complete: true
    }
  });
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('player-calvin', 'linked', calvin.id);

  const mike = await store.upsertTelegramUser({
    telegram_id: 1002,
    username: 'mike',
    first_name: 'Mike',
    is_bot: false
  });
  await store.updateRegistrationStatus(mike.id, 'Registered', 'Test');
  await store.updateAutomationState(mike.id, {
    registrationInfo: {
      preferred_appbeg_username: 'Mike',
      appbeg_player_uid: 'player-mike',
      appbeg_creation_complete: true
    }
  });
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('player-mike', 'linked', mike.id);

  const links = royalVipBotDeepLinks('RoyalVipBot');
  assert.equal(links.play, 'https://t.me/RoyalVipBot?start=play');
  assert.equal(links.support, 'https://t.me/RoyalVipBot?start=support');
  assert.equal(links.freeplay, 'https://t.me/RoyalVipBot?start=freeplay');
  const markup = royalVipHubStorefrontMarkup('RoyalVipBot');
  assert.equal(markup.inline_keyboard[0][0].text, '🔴 PLAY');
  assert.equal(markup.inline_keyboard[0][0].url, links.play);
  assert.equal(markup.inline_keyboard[1][0].text, '💬 MESSAGE US');
  assert.equal(markup.inline_keyboard[1][0].url, links.support);
  assert.equal(markup.inline_keyboard[2][0].text, '🎁 FREEPLAY');
  assert.equal(markup.inline_keyboard[2][0].url, links.freeplay);

  // 1. no channel ID → no crash
  const unconfiguredBot = mockHubTelegram();
  const missing = await ensureRoyalVipHubStorefront({ store, bot: unconfiguredBot });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_configured');
  assert.equal(unconfiguredBot.calls.send.length, 0);
  assert.match(describeRoyalVipHubStatus({}).text, /not configured/i);
  console.log('ok hub 1: missing channel id does not crash or post');

  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;

  // 2. first ensure → create once
  const createBot = mockHubTelegram();
  const created = await ensureRoyalVipHubStorefront({ store, bot: createBot });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(createBot.calls.send.length, 1);
  assert.equal(createBot.calls.send[0].chatId, HUB_CHANNEL_ID);
  assert.equal(createBot.calls.send[0].text, ROYAL_VIP_HUB_STOREFRONT_TEXT);
  assert.equal(createBot.calls.pin.length, 1);
  const firstId = created.messageId;
  const persisted = await store.getHubStorefrontState();
  assert.equal(Number(persisted.storefrontMessageId), Number(firstId));
  console.log('ok hub 2: first ensure creates storefront once');

  // 3 + 7. second ensure → reuse/edit same message; identical → no extra create
  const editBot = mockHubTelegram({
    editBehavior: () => telegramError('Bad Request: message is not modified')
  });
  const unchanged = await ensureRoyalVipHubStorefront({ store, bot: editBot });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.created, false);
  assert.equal(editBot.calls.send.length, 0);
  assert.equal(editBot.calls.edit.length, 1);
  assert.equal(Number(editBot.calls.edit[0].messageId), Number(firstId));
  console.log('ok hub 3/7: second ensure reuses message; identical is a safe no-op');

  // 4. restart with stored message ID → no duplicate
  const restartBot = mockHubTelegram();
  const restarted = await ensureRoyalVipHubStorefront({ store, bot: restartBot });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.created, false);
  assert.equal(restartBot.calls.send.length, 0);
  assert.equal(Number((await store.getHubStorefrontState()).storefrontMessageId), Number(firstId));
  console.log('ok hub 4: restart with stored id does not duplicate');

  // 6. text/buttons changed → edit existing
  const updateBot = mockHubTelegram();
  const edited = await ensureRoyalVipHubStorefront({ store, bot: updateBot });
  assert.equal(edited.ok, true);
  assert.equal(edited.edited, true);
  assert.equal(updateBot.calls.send.length, 0);
  console.log('ok hub 6: changed storefront edits existing message');

  // 5. stored message missing → create replacement and persist new ID
  const missingBot = mockHubTelegram({
    startId: 500,
    editBehavior: () => telegramError('Bad Request: message to edit not found')
  });
  const replaced = await ensureRoyalVipHubStorefront({ store, bot: missingBot });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.created, true);
  assert.equal(missingBot.calls.send.length, 1);
  assert.notEqual(Number(replaced.messageId), Number(firstId));
  assert.equal(Number((await store.getHubStorefrontState()).storefrontMessageId), Number(replaced.messageId));
  console.log('ok hub 5: missing stored message creates replacement');

  // 8. permission denied → failure visible, app continues
  await store.saveHubStorefrontState({ storefrontMessageId: null, syncedAt: null, lastError: null, pinned: false });
  const deniedBot = mockHubTelegram({
    sendBehavior: () => telegramError('Forbidden: bot is not a member of the channel chat')
  });
  const denied = await ensureRoyalVipHubStorefront({ store, bot: deniedBot });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'permission_denied');
  assert.match(denied.error, /cannot post\/edit/i);
  const deniedState = await store.getHubStorefrontState();
  assert.match(describeRoyalVipHubStatus(deniedState).text, /Hub sync failed/i);
  assert.match(describeRoyalVipHubStatus(deniedState).text, /cannot post\/edit/i);
  console.log('ok hub 8: permission denied is visible and does not throw');

  await store.saveHubStorefrontState({ storefrontMessageId: null, syncedAt: null, lastError: null, pinned: false });
  const pinBot = mockHubTelegram();
  const pinned = await ensureRoyalVipHubStorefront({ store, bot: pinBot });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.pinned, true);
  assert.equal(pinBot.calls.pin.length, 1);
  console.log('ok hub 9: pin succeeds');

  const alreadyPinnedBot = mockHubTelegram({
    pinBehavior: () => telegramError('Bad Request: CHAT_NOT_MODIFIED')
  });
  const alreadyPinned = await ensureRoyalVipHubStorefront({ store, bot: alreadyPinnedBot });
  assert.equal(alreadyPinned.ok, true);
  assert.equal(alreadyPinned.created, false);
  assert.equal(alreadyPinnedBot.calls.send.length, 0);
  console.log('ok hub 9b: already pinned is idempotent');

  const pinFailBot = mockHubTelegram({
    pinBehavior: () => telegramError('Bad Request: not enough rights to pin a message')
  });
  const pinFailed = await ensureRoyalVipHubStorefront({ store, bot: pinFailBot });
  assert.equal(pinFailed.ok, true);
  assert.equal(pinFailed.created, false);
  assert.equal(pinFailBot.calls.send.length, 0);
  assert.equal(Number((await store.getHubStorefrontState()).storefrontMessageId), Number(pinFailed.messageId));
  console.log('ok hub 10: pin failure does not create a duplicate');

  const unavailableBot = mockHubTelegram({
    editBehavior: () => telegramError('Bad Request: chat not found')
  });
  const unavailable = await ensureRoyalVipHubStorefront({ store, bot: unavailableBot });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailableBot.calls.send.length, 0);
  console.log('ok hub 10b: channel unavailable does not create a duplicate');

  // 11-14 Hub role checks
  const hubRefreshBot = mockHubTelegram();
  globalThis.telegramBot = hubRefreshBot;
  const staffRefresh = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.HUB_REFRESH, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: staffRefresh, store, bot: hubRefreshBot });
  assert.equal(staffRefresh.answered, 'Not authorized');
  assert.equal(hubRefreshBot.calls.send.filter((call) => call.chatId === HUB_CHANNEL_ID).length, 0);
  console.log('ok hub 11: staff cannot refresh hub');

  const coadminRefresh = makeCbCtx({ fromId: COADMIN_ID, data: STAFF_CB.HUB_REFRESH, firstName: 'Coadmin' });
  await handleStaffCallbackQuery({ ctx: coadminRefresh, store, bot: hubRefreshBot });
  assert.equal(coadminRefresh.answered, 'Hub refreshed');
  console.log('ok hub 12: coadmin can refresh hub');

  const rootRefresh = makeCbCtx({ fromId: ROOT_ID, data: STAFF_CB.HUB_REFRESH, firstName: 'Root' });
  await handleStaffCallbackQuery({ ctx: rootRefresh, store, bot: hubRefreshBot });
  assert.equal(rootRefresh.answered, 'Hub refreshed');
  console.log('ok hub 13: root can refresh hub');

  const forged = makeCbCtx({ fromId: '5555', data: STAFF_CB.HUB_REFRESH });
  await handleStaffCallbackQuery({ ctx: forged, store, bot: hubRefreshBot });
  assert.equal(forged.answered, 'Not authorized');
  const staffHubMenu = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.HUB, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: staffHubMenu, store, bot: hubRefreshBot });
  assert.equal(staffHubMenu.answered, 'Not authorized');
  console.log('ok hub 14: hub callbacks fresh-check role');

  // 15-16 public privacy
  const storefrontSends = createBot.calls.send.concat(pinBot.calls.send);
  for (const call of storefrontSends) {
    assert.equal(call.text, ROYAL_VIP_HUB_STOREFRONT_TEXT);
    assert.doesNotMatch(call.text, /Calvin|Mike|payment|Confidence|Staff Management/i);
  }
  const crmBot = mockHubTelegram();
  await notifyOperationalStaffPayment(store, {
    id: 1,
    parsed_sender_name: 'Calvin M.',
    parsed_amount: 25,
    routing_status: 'unmatched'
  }, { bot: crmBot });
  assert.equal(crmBot.calls.send.some((call) => call.chatId === HUB_CHANNEL_ID), false);
  assert.equal(crmBot.calls.send.some((call) => call.chatId === STAFF_GROUP_ID), true);
  process.env.STAFF_TELEGRAM_GROUP_ID = HUB_CHANNEL_ID;
  const misconfigBot = mockHubTelegram();
  const refused = await notifyOperationalStaffPayment(store, {
    id: 2,
    parsed_sender_name: 'Calvin M.',
    parsed_amount: 25,
    routing_status: 'unmatched'
  }, { bot: misconfigBot });
  assert.equal(misconfigBot.calls.send.some((call) => call.chatId === HUB_CHANNEL_ID && /Calvin/.test(call.text)), false);
  assert.equal(refused.failures.some((item) => item.error === 'refused_hub_target'), true);
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  console.log('ok privacy 15-16: hub never receives payment/CRM content');

  // 17 unknown payer + assign recipient Mike
  const unknownPayment = await insertPayment(store, { telegramMessageId: 9001, name: 'Calvin M.' });
  await staffAssignAndCredit(store, {
    paymentId: unknownPayment.id,
    recipientContactId: mike.id,
    payerContactId: null,
    actorTelegramUserId: ROOT_ID
  });
  const creditedUnknown = await store.getPaymentEvent(unknownPayment.id);
  assert.equal(creditedUnknown.payer_contact_id == null || Number(creditedUnknown.payer_contact_id) === 0, true);
  assert.equal(Number(creditedUnknown.recipient_contact_id), Number(mike.id));
  const identity = await store.ensurePaymentIdentity('Calvin M.');
  const evidence = await store.listPaymentIdentityEvidence(identity.id);
  assert.equal(evidence.some((row) => Number(row.contact_id) === Number(mike.id) && row.evidence_kind === 'staff_confirmed'), false);
  console.log('ok payer 17: unknown payer credits Mike without payer evidence');

  // 18 known payer + different recipient
  const knownPayment = await insertPayment(store, {
    telegramMessageId: 9002,
    name: 'Calvin M.',
    payerContactId: calvin.id
  });
  await staffAssignAndCredit(store, {
    paymentId: knownPayment.id,
    recipientContactId: mike.id,
    payerContactId: calvin.id,
    actorTelegramUserId: ROOT_ID
  });
  const creditedKnown = await store.getPaymentEvent(knownPayment.id);
  assert.equal(Number(creditedKnown.payer_contact_id), Number(calvin.id));
  assert.equal(Number(creditedKnown.recipient_contact_id), Number(mike.id));
  const knownEvidence = await store.listPaymentIdentityEvidence(identity.id);
  assert.equal(knownEvidence.some((row) => Number(row.contact_id) === Number(calvin.id) && row.evidence_kind === 'staff_confirmed'), true);
  assert.equal(knownEvidence.some((row) => Number(row.contact_id) === Number(mike.id) && row.evidence_kind === 'staff_confirmed'), false);
  console.log('ok payer 18: known payer evidence stays on the payer');

  // 19 closed mapped topic → reopen and reuse
  await store.upsertStaffTopic({
    contactId: calvin.id,
    telegramUserId: calvin.telegram_id,
    staffGroupId: STAFF_GROUP_ID,
    messageThreadId: 77,
    topicName: 'Calvin'
  });
  let sendAttempts = 0;
  const topicBot = mockHubTelegram({
    sendBehavior: ({ extra }) => {
      if (extra?.message_thread_id === 77 && sendAttempts === 0) {
        sendAttempts += 1;
        return telegramError('Bad Request: TOPIC_CLOSED');
      }
      sendAttempts += 1;
      return null;
    }
  });
  const reopened = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: topicBot,
    contact: calvin,
    text: 'hello from player'
  });
  assert.equal(reopened.mirrored, true);
  assert.equal(reopened.reopened, true);
  assert.equal(topicBot.calls.createForumTopic, 0);
  assert.equal(topicBot.calls.reopen.length, 1);
  assert.equal(Number((await store.getStaffTopicForContact(calvin.id)).message_thread_id), 77);
  console.log('ok topic 19: closed topic is reopened and reused');

  // 20 reopen failure → fallback, no lost message
  const failTopicBot = mockHubTelegram({
    sendBehavior: ({ extra }) => {
      if (extra?.message_thread_id === 77) return telegramError('Bad Request: TOPIC_CLOSED');
      return null;
    }
  });
  failTopicBot.telegram.reopenForumTopic = async () => {
    throw telegramError('Forbidden: not enough rights to manage topics');
  };
  const reopenFailed = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: failTopicBot,
    contact: calvin,
    text: 'please help'
  });
  assert.equal(reopenFailed.persisted, true);
  assert.equal(reopenFailed.mirrored, false);
  assert.equal(reopenFailed.reason, 'reopen_failed');
  assert.equal(failTopicBot.calls.createForumTopic, 0);
  assert.equal(failTopicBot.calls.send.some((call) => call.chatId === STAFF_GROUP_ID && /please help/.test(call.text)), true);
  console.log('ok topic 20: reopen failure falls back without losing the message');

  // 21-23 Ignore
  const ignorePayment = await insertPayment(store, { telegramMessageId: 9003, name: 'Noise' });
  const freezePayment = await insertPayment(store, { telegramMessageId: 9004, name: 'Hold Me' });
  const ignorePrompt = makeCbCtx({ fromId: STAFF_ID, data: `${STAFF_CB.IGNORE}${ignorePayment.id}`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: ignorePrompt, store, bot: hubRefreshBot });
  assert.match(ignorePrompt.replies[0].body, /not a deposit credit event/i);
  const ignoreConfirm = makeCbCtx({ fromId: STAFF_ID, data: `${STAFF_CB.IGNORE_CONFIRM}${ignorePayment.id}`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: ignoreConfirm, store, bot: hubRefreshBot });
  assert.equal(ignoreConfirm.answered, 'Ignored');
  const ignored = await store.getPaymentEvent(ignorePayment.id);
  assert.equal(ignored.routing_status, 'ignored');
  const ignoreAgain = await staffIgnorePayment(store, ignorePayment.id, STAFF_ID);
  assert.equal(ignoreAgain.alreadyIgnored, true);
  const duplicateCb = makeCbCtx({ fromId: STAFF_ID, data: `${STAFF_CB.IGNORE_CONFIRM}${ignorePayment.id}`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: duplicateCb, store, bot: hubRefreshBot });
  assert.equal(duplicateCb.answered, 'Already ignored');
  await staffFreezePayment(store, freezePayment.id, STAFF_ID);
  const frozen = await store.getPaymentEvent(freezePayment.id);
  assert.equal(frozen.routing_status, ROUTING_STATUS.FROZEN || 'frozen');
  assert.notEqual(frozen.routing_status, 'ignored');
  const buttons = paymentCardButtons(freezePayment.id, { frozen: true });
  const labels = buttons.inline_keyboard.flat().map((button) => button.text);
  assert.equal(labels.includes('❄️ FREEZE') || labels.includes('🔓 UNFREEZE'), true);
  assert.equal(labels.includes('🚫 IGNORE'), true);
  console.log('ok ignore 21-23: ignore is idempotent and distinct from freeze');

  // 24-25 Control Center
  const ccBot = mockHubTelegram();
  const firstCc = await ensureStaffControlCenter({ store, bot: ccBot });
  assert.equal(firstCc.ok, true);
  assert.equal(firstCc.created, true);
  const secondCc = await ensureStaffControlCenter({ store, bot: ccBot });
  assert.equal(secondCc.created, false);
  assert.equal(ccBot.calls.send.filter((call) => /CONTROL CENTER/.test(call.text)).length, 1);
  const rootButtons = controlCenterButtons(OPERATIONAL_ROLES.ROOT_ADMIN).inline_keyboard.flat().map((button) => button.text);
  const coadminButtons = controlCenterButtons(OPERATIONAL_ROLES.COADMIN).inline_keyboard.flat().map((button) => button.text);
  const staffButtons = controlCenterButtons(OPERATIONAL_ROLES.STAFF).inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(rootButtons, ['⚡ CONFIDENCE MODE', '👥 STAFF MANAGEMENT', '👑 HUB MANAGEMENT', '💰 PAYMENTS', '🎁 FREEPLAY']);
  assert.deepEqual(coadminButtons, rootButtons);
  assert.deepEqual(staffButtons, ['💰 PAYMENTS', '🎁 FREEPLAY']);
  const staffCc = makeCbCtx({ fromId: STAFF_ID, data: STAFF_CB.CTRL, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: staffCc, store, bot: ccBot });
  const staffCcLabels = (staffCc.replies[0].extra?.inline_keyboard || []).flat().map((button) => button.text);
  assert.deepEqual(staffCcLabels, ['💰 PAYMENTS', '🎁 FREEPLAY']);
  const rootCc = makeCbCtx({ fromId: ROOT_ID, data: STAFF_CB.CTRL, firstName: 'Root' });
  await handleStaffCallbackQuery({ ctx: rootCc, store, bot: ccBot });
  const rootCcLabels = (rootCc.replies[0].extra?.inline_keyboard || []).flat().map((button) => button.text);
  assert.ok(rootCcLabels.includes('👑 HUB MANAGEMENT'));
  console.log('ok control center 24-25: entry is reused and role buttons are correct');

  restoreEnv(previous);
  console.log('All Royal VIP Hub storefront tests passed.');
}

function restoreEnv(previous) {
  restore('ROYAL_VIP_HUB_CHANNEL_ID', previous.hub);
  restore('STAFF_TELEGRAM_GROUP_ID', previous.group);
  restore('ROOT_ADMIN_TELEGRAM_USER_ID', previous.root);
  restore('TELEGRAM_BOT_USERNAME', previous.bot);
}

function restore(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
