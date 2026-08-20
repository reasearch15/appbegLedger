import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import {
  HUB_DM_STAFF_ADMIN_RIGHTS,
  describeHubDirectMessagesChat,
  extractDirectMessagesTopic,
  formatStaffGrantResultText,
  grantOperationalRoleWithHubAccess,
  handleRoyalVipHubDirectMessage,
  hubDmAccessIsReady,
  isRoyalVipHubDirectMessagesChat,
  revokeOperationalRoleWithHubAccess,
  sendToHubDirectMessageTopic,
  syncHubChannelAdminAccess,
  telegramIdToText
} from '../src/telegram/hubDirectMessages.js';
import { staffAskPlayer, deliverStaffReplyToPlayer, mirrorPlayerMessageToStaffTopic } from '../src/telegram/staffOperations.js';
import {
  handleStaffCallbackQuery,
  handleStaffGroupMessage,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { STAFF_CB } from '../src/telegram/staffCards.js';
import { royalVipHubStorefrontMarkup } from '../src/telegram/channelDeepLinks.js';
import { formatHubDmIdentityCard } from '../src/telegram/playerSupportMessaging.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-vip-hub-dm-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const HUB_CHANNEL_ID = '-100777000111';
const DM_CHAT_ID = '-207777000111';
const STAFF_GROUP_ID = '-100555000';
const ROOT_ID = '9001';
const COADMIN_ID = '9002';
const STAFF_ID = '8003';
const JOHN_ID = '7001';
const MIKE_ID = '7002';
const JOHN_TOPIC = '3000000001';
const MIKE_TOPIC = '3000000002';

function telegramError(description) {
  const error = new Error(description);
  error.description = description;
  error.response = { description };
  return error;
}

function mockHubTelegram({
  botRights = { can_promote_members: true, can_manage_direct_messages: true },
  memberByUser = {},
  promoteError = null,
  copyError = null
} = {}) {
  const calls = { api: [], send: [], photo: [], video: [], document: [] };
  let nextId = 400;
  const members = {
    8682428291: { status: 'administrator', ...botRights },
    ...memberByUser
  };
  const telegram = {
    async getMe() {
      return { id: 8682428291, username: 'Royal_Sweeps_bot' };
    },
    async getChatMember(chatId, userId) {
      calls.api.push({ method: 'getChatMember', chatId: String(chatId), userId: String(userId) });
      const member = members[String(userId)];
      if (!member) {
        throw telegramError('Bad Request: user not found');
      }
      return { ...member, user: { id: Number(userId) } };
    },
    async callApi(method, payload = {}) {
      calls.api.push({ method, payload });
      if (method === 'promoteChatMember') {
        if (promoteError) throw telegramError(promoteError);
        members[String(payload.user_id)] = {
          status: 'administrator',
          can_manage_direct_messages: Boolean(payload.can_manage_direct_messages),
          can_promote_members: Boolean(payload.can_promote_members)
        };
        return true;
      }
      if (method === 'getChatMember') {
        return telegram.getChatMember(payload.chat_id, payload.user_id);
      }
      if (method === 'copyMessage') {
        if (copyError) throw telegramError(copyError);
        nextId += 1;
        return { message_id: nextId };
      }
      if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendVideo' || method === 'sendDocument' || method === 'sendAudio' || method === 'sendVoice') {
        nextId += 1;
        return { message_id: nextId };
      }
      return true;
    },
    async sendMessage(chatId, text, extra = {}) {
      calls.send.push({ chatId: String(chatId), text, extra });
      nextId += 1;
      return { message_id: nextId };
    },
    async sendPhoto(chatId, fileId, extra = {}) {
      calls.photo.push({ chatId: String(chatId), fileId, extra });
      nextId += 1;
      return { message_id: nextId };
    }
  };
  return { calls, telegram, bot: { telegram, botInfo: { id: 8682428291 } } };
}

function hubDmCtx({
  userId,
  topicId,
  text = 'Hello',
  messageId = 11,
  updateId = 501,
  fromId = null,
  isStaff = false,
  photo = false,
  senderChatId = null
}) {
  const user = { id: Number(userId), first_name: userId === JOHN_ID ? 'John' : 'Mike', username: userId === JOHN_ID ? 'john' : 'mike' };
  const from = isStaff
    ? { id: Number(fromId || STAFF_ID), first_name: 'Staff', is_bot: false }
    : user;
  return {
    update: { update_id: updateId },
    chat: {
      id: Number(DM_CHAT_ID),
      type: 'supergroup',
      is_direct_messages: true,
      parent_chat: { id: Number(HUB_CHANNEL_ID) }
    },
    from,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text: photo ? undefined : text,
      photo: photo ? [{ file_id: 'hub-photo', file_unique_id: 'u1' }] : undefined,
      caption: photo ? text : undefined,
      from,
      sender_chat: senderChatId ? { id: Number(senderChatId) } : undefined,
      chat: {
        id: Number(DM_CHAT_ID),
        type: 'supergroup',
        is_direct_messages: true,
        parent_chat: { id: Number(HUB_CHANNEL_ID) }
      },
      direct_messages_topic: {
        topic_id: topicId,
        user
      }
    }
  };
}

function makeGroupCtx({ fromId, text = '', threadId = null, firstName = 'Root' }) {
  return {
    replies: [],
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName, is_bot: false },
    message: {
      message_id: Number(`${fromId}1`),
      text,
      message_thread_id: threadId,
      from: { id: Number(fromId) }
    },
    async reply(body) {
      this.replies.push(body);
      return { message_id: this.replies.length };
    }
  };
}

function makeCbCtx({ fromId, data }) {
  let answered = null;
  return {
    replies: [],
    get answered() { return answered; },
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: 'Root' },
    callbackQuery: { data, message: { message_thread_id: 1 } },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body) {
      this.replies.push(body);
      return { message_id: this.replies.length };
    }
  };
}

async function run() {
  __resetStaffPendingPromptsForTests();
  const previous = {
    hub: process.env.ROYAL_VIP_HUB_CHANNEL_ID,
    dm: process.env.ROYAL_VIP_HUB_DM_CHAT_ID,
    group: process.env.STAFF_TELEGRAM_GROUP_ID,
    root: process.env.ROOT_ADMIN_TELEGRAM_USER_ID
  };
  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;
  process.env.ROYAL_VIP_HUB_DM_CHAT_ID = DM_CHAT_ID;
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = ROOT_ID;

  assert.equal(telegramIdToText(3000000001), '3000000001');
  assert.equal(extractDirectMessagesTopic({
    direct_messages_topic: { topic_id: JOHN_TOPIC, user: { id: JOHN_ID, first_name: 'John' } }
  }).userId, JOHN_ID);
  const recognized = describeHubDirectMessagesChat({
    id: Number(DM_CHAT_ID),
    is_direct_messages: true,
    parent_chat: { id: Number(HUB_CHANNEL_ID) }
  });
  assert.equal(recognized.matched, true);
  assert.ok(recognized.reasons.includes('is_direct_messages'));
  assert.ok(recognized.reasons.includes('parent_chat'));
  assert.equal(isRoyalVipHubDirectMessagesChat({
    id: Number(HUB_CHANNEL_ID),
    type: 'channel'
  }), false);
  console.log('ok 1 Direct Messages Chat recognition / is_direct_messages / parent_chat');

  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  await store.bootstrapRootAdminFromEnv();
  await store.grantOperationalRole({
    telegramUserId: COADMIN_ID,
    role: OPERATIONAL_ROLES.COADMIN,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Co'
  });

  const columns = await store.db.prepare('PRAGMA table_info(telegram_channel_dm_topics)').all();
  assert.equal(columns.find((col) => col.name === 'direct_messages_topic_id').type, 'TEXT');
  const roleCols = await store.db.prepare('PRAGMA table_info(operational_roles)').all();
  assert.ok(roleCols.some((col) => col.name === 'telegram_channel_admin_status'));
  console.log('ok 2 schema stores topic ids as TEXT and role sync columns exist');

  const bot = mockHubTelegram();
  const johnInbound = await handleRoyalVipHubDirectMessage({
    ctx: hubDmCtx({ userId: JOHN_ID, topicId: JOHN_TOPIC, text: 'Hello', messageId: 21, updateId: 801 }),
    store,
    bot: bot.bot,
    io: { emit() {} }
  });
  assert.equal(johnInbound.handled, true);
  assert.equal(johnInbound.inserted, true);
  assert.equal(String(johnInbound.isolatedUserId), JOHN_ID);
  assert.match(johnInbound.identityCard, /NOT REGISTERED/);
  const johnContact = johnInbound.contact;
  const johnTopic = await store.getChannelDmTopicForContact(johnContact.id);
  assert.equal(String(johnTopic.direct_messages_topic_id), JOHN_TOPIC);
  assert.equal(String(johnTopic.telegram_user_id), JOHN_ID);
  assert.equal(String(johnTopic.direct_messages_chat_id), DM_CHAT_ID);
  assert.equal(await store.getDiscoveredHubDmChatId(), DM_CHAT_ID);
  const johnMessages = await store.db.prepare('SELECT * FROM messages WHERE telegram_user_id = ?').all(johnContact.id);
  assert.equal(johnMessages.length, 1);
  assert.equal(johnMessages[0].source, 'hub_channel_dm');
  console.log('ok 3 subscriber Hub DM maps to Ledger contact + topic');

  const duplicate = await handleRoyalVipHubDirectMessage({
    ctx: hubDmCtx({ userId: JOHN_ID, topicId: JOHN_TOPIC, text: 'Hello', messageId: 21, updateId: 801 }),
    store,
    bot: bot.bot
  });
  assert.equal(duplicate.inserted, false);
  const johnMessagesAfter = await store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE telegram_user_id = ?').get(johnContact.id);
  assert.equal(johnMessagesAfter.n, 1);
  console.log('ok 4 duplicate Hub DM update does not create a second CRM message');

  const mikeInbound = await handleRoyalVipHubDirectMessage({
    ctx: hubDmCtx({ userId: MIKE_ID, topicId: MIKE_TOPIC, text: 'Hi from Mike', messageId: 22, updateId: 802 }),
    store,
    bot: bot.bot
  });
  assert.equal(String(mikeInbound.isolatedUserId), MIKE_ID);
  assert.notEqual(mikeInbound.contact.id, johnContact.id);
  const mikeTopic = await store.getChannelDmTopicForContact(mikeInbound.contact.id);
  assert.equal(String(mikeTopic.direct_messages_topic_id), MIKE_TOPIC);
  assert.notEqual(String(mikeTopic.direct_messages_topic_id), String(johnTopic.direct_messages_topic_id));
  console.log('ok 5 John and Mike map to isolated topics');

  await store.db.prepare('UPDATE telegram_users SET registration_status = ?, appbeg_account_id = ? WHERE id = ?')
    .run('Registered', 'john123', johnContact.id);
  await store.updateAutomationState(johnContact.id, {
    registrationInfo: { preferred_appbeg_username: 'john123', appbeg_creation_complete: true }
  });
  const later = {
    ...await store.getUserProfile(johnContact.id),
    registration_info: (await store.getAutomationState(johnContact.id))?.registration_info || {}
  };
  assert.match(formatHubDmIdentityCard(later), /john123/);
  assert.match(formatHubDmIdentityCard(later), /Registered/);
  const stillSame = await store.getChannelDmTopicForContact(johnContact.id);
  assert.equal(stillSame.id, johnTopic.id);
  const contactsForJohn = await store.db.prepare('SELECT COUNT(*) AS n FROM telegram_users WHERE telegram_id = ?').get(JOHN_ID);
  assert.equal(contactsForJohn.n, 1);
  console.log('ok 6 unregistered then registered keeps the same Telegram contact and DM history');

  const sent = await sendToHubDirectMessageTopic(bot.telegram, {
    dmChatId: DM_CHAT_ID,
    topicId: JOHN_TOPIC,
    text: 'Only for John'
  });
  assert.ok(sent.message_id);
  const johnSend = bot.calls.api.find((call) => call.method === 'sendMessage' && String(call.payload.direct_messages_topic_id) === JOHN_TOPIC);
  assert.equal(String(johnSend.payload.chat_id), DM_CHAT_ID);
  assert.equal(johnSend.payload.text, 'Only for John');
  assert.equal(bot.calls.api.some((call) => call.method === 'sendMessage' && String(call.payload.chat_id) === HUB_CHANNEL_ID), false);
  console.log('ok 7 Ledger/system send uses native topic and never the public Hub');

  const delivery = await deliverStaffReplyToPlayer({
    store,
    bot: bot.bot,
    contact: later,
    text: 'Secret to John',
    actorName: 'Staff'
  });
  assert.equal(delivery.via, 'native_hub_dm');
  assert.equal(delivery.delivered, true);
  const mikeSends = bot.calls.api.filter((call) => (
    call.method === 'sendMessage'
    && String(call.payload.direct_messages_topic_id) === MIKE_TOPIC
    && /Secret to John/.test(call.payload.text || '')
  ));
  assert.equal(mikeSends.length, 0);
  const publicLeak = bot.calls.api.filter((call) => String(call.payload?.chat_id) === HUB_CHANNEL_ID);
  assert.equal(publicLeak.length, 0);
  console.log('ok 8 two-user isolation: John reply cannot target Mike or public Hub');

  const now = new Date().toISOString();
  const paymentInsert = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      payer_contact_id, message_date, created_at, updated_at
    ) VALUES (9901, -100, 'Pay', 'You received $12.00 from John.', '{}', 'Parsed', 'unmatched', 12, 'John Payer', 'Chime', ?, ?, ?, ?)
  `).run(johnContact.id, now, now, now);
  await staffAskPlayer(store, paymentInsert.lastInsertRowid, ROOT_ID, { bot: bot.bot });
  const askSend = bot.calls.api.find((call) => (
    call.method === 'sendMessage'
    && /Is this your payment/.test(call.payload.text || '')
  ));
  assert.equal(String(askSend.payload.direct_messages_topic_id), JOHN_TOPIC);
  assert.equal(String(askSend.payload.chat_id), DM_CHAT_ID);
  console.log('ok 9 ASK PLAYER prefers native Hub DM topic');

  await sendToHubDirectMessageTopic(bot.telegram, {
    dmChatId: DM_CHAT_ID,
    topicId: JOHN_TOPIC,
    media: { kind: 'photo', fileId: 'photo-1' },
    text: 'Receipt'
  });
  const photoSend = bot.calls.api.find((call) => call.method === 'sendPhoto');
  assert.equal(photoSend.payload.photo, 'photo-1');
  assert.equal(String(photoSend.payload.direct_messages_topic_id), JOHN_TOPIC);
  await sendToHubDirectMessageTopic(bot.telegram, {
    dmChatId: DM_CHAT_ID,
    topicId: JOHN_TOPIC,
    media: { kind: 'video', fileId: 'vid-1' }
  });
  assert.ok(bot.calls.api.some((call) => call.method === 'sendVideo'));
  console.log('ok 10 media send uses direct_messages_topic_id');

  const skippedMirror = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: bot.bot,
    contact: later,
    text: 'already in native DM'
  });
  assert.equal(skippedMirror.reason, 'native_hub_dm_primary');
  console.log('ok 11 native DM is primary; staff forum topic is not duplicated');

  const storefront = royalVipHubStorefrontMarkup('Royal_Sweeps_bot');
  assert.equal(storefront.inline_keyboard.some((row) => row.some((btn) => /payment|staff|confidence/i.test(btn.text))), false);
  console.log('ok 12 public Hub markup has no staff/payment controls');

  const grantBot = mockHubTelegram();
  const granted = await grantOperationalRoleWithHubAccess(store, {
    telegramUserId: STAFF_ID,
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Alice'
  }, { bot: grantBot.bot });
  assert.equal(granted.ok, true);
  assert.equal(granted.telegramAccess.status, 'active');
  const promote = grantBot.calls.api.find((call) => call.method === 'promoteChatMember');
  assert.equal(promote.payload.can_manage_direct_messages, true);
  assert.equal(promote.payload.can_promote_members, false);
  assert.equal(promote.payload.can_change_info, false);
  assert.equal(promote.payload.can_delete_messages, false);
  assert.equal(promote.payload.can_post_messages, false);
  assert.deepEqual(
    Object.keys(HUB_DM_STAFF_ADMIN_RIGHTS).sort(),
    Object.keys(promote.payload).filter((key) => key !== 'chat_id' && key !== 'user_id').sort()
  );
  const staffRole = await store.getActiveOperationalRole(STAFF_ID);
  assert.equal(staffRole.telegram_channel_admin_status, 'active');
  assert.equal(hubDmAccessIsReady(staffRole), true);
  console.log('ok 13 Root grant Staff promotes with least privilege + can_manage_direct_messages');

  await assert.rejects(
    () => store.grantOperationalRole({
      telegramUserId: '111222',
      role: OPERATIONAL_ROLES.STAFF,
      grantedByTelegramUserId: STAFF_ID
    }),
    /not authorized/i
  );
  console.log('ok 14 Staff cannot grant Staff');

  const coadminGrantBot = mockHubTelegram({
    memberByUser: {
      [STAFF_ID]: { status: 'administrator', can_manage_direct_messages: true, can_promote_members: false }
    }
  });
  await handleStaffCallbackQuery({
    ctx: makeCbCtx({ fromId: COADMIN_ID, data: STAFF_CB.STAFF_ADD }),
    store,
    bot: coadminGrantBot.bot
  });
  const extraStaff = '8009';
  const coadminAdd = makeGroupCtx({ fromId: COADMIN_ID, text: extraStaff, firstName: 'Co' });
  await handleStaffGroupMessage({ ctx: coadminAdd, store, bot: coadminGrantBot.bot });
  assert.equal((await store.getActiveOperationalRole(extraStaff))?.role, OPERATIONAL_ROLES.STAFF);
  assert.match(coadminAdd.replies.join('\n'), /Hub DM Access/);
  console.log('ok 15 Coadmin can grant Staff and sees Hub DM access state');

  const revoked = await revokeOperationalRoleWithHubAccess(store, {
    telegramUserId: extraStaff,
    revokedByTelegramUserId: COADMIN_ID
  }, { bot: coadminGrantBot.bot });
  assert.equal(revoked.ok, true);
  assert.equal(await store.getActiveOperationalRole(extraStaff), null);
  const demote = coadminGrantBot.calls.api.find((call) => (
    call.method === 'promoteChatMember'
    && String(call.payload.user_id) === extraStaff
    && call.payload.can_manage_direct_messages === false
  ));
  assert.ok(demote);
  console.log('ok 16 Coadmin revoke demotes Telegram Hub DM rights; Ledger authority ends');

  const noPromoteBot = mockHubTelegram({
    botRights: { can_promote_members: false, can_manage_direct_messages: true }
  });
  const pendingStaff = '8010';
  const pendingGrant = await grantOperationalRoleWithHubAccess(store, {
    telegramUserId: pendingStaff,
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID
  }, { bot: noPromoteBot.bot });
  assert.equal((await store.getActiveOperationalRole(pendingStaff))?.role, OPERATIONAL_ROLES.STAFF);
  assert.equal(pendingGrant.telegramAccess.ok, false);
  assert.equal(pendingGrant.telegramAccess.code, 'BOT_CANNOT_PROMOTE');
  assert.match(formatStaffGrantResultText(pendingStaff, pendingGrant.telegramAccess), /Pending/);
  assert.doesNotMatch(formatStaffGrantResultText(pendingStaff, pendingGrant.telegramAccess), /Hub DM Access: ✅/);
  const pendingRole = await store.getActiveOperationalRole(pendingStaff);
  assert.equal(hubDmAccessIsReady(pendingRole), false);
  console.log('ok 17 bot lacking can_promote_members keeps Ledger role pending, not ready');

  const noDmBot = mockHubTelegram({
    botRights: { can_promote_members: true, can_manage_direct_messages: false }
  });
  const dmFail = await syncHubChannelAdminAccess({
    store,
    bot: noDmBot.bot,
    telegramUserId: pendingStaff
  });
  assert.equal(dmFail.code, 'BOT_CANNOT_MANAGE_DIRECT_MESSAGES');
  console.log('ok 18 bot lacking can_manage_direct_messages reports configuration error');

  const apiFailBot = mockHubTelegram({ promoteError: 'Bad Request: not enough rights to change member rights' });
  const apiFail = await syncHubChannelAdminAccess({
    store,
    bot: apiFailBot.bot,
    telegramUserId: pendingStaff
  });
  assert.equal(apiFail.ok, false);
  assert.equal(apiFail.status, 'pending');
  console.log('ok 19 Telegram API promotion errors stay pending');

  const noRightBot = mockHubTelegram({
    memberByUser: {
      8080: { status: 'administrator', can_manage_direct_messages: false, can_promote_members: false }
    }
  });
  noRightBot.telegram.callApi = async (method, payload = {}) => {
    noRightBot.calls.api.push({ method, payload });
    if (method === 'promoteChatMember') return true;
    if (method === 'getChatMember') {
      return {
        status: 'administrator',
        can_manage_direct_messages: false,
        user: { id: Number(payload.user_id) }
      };
    }
    return true;
  };
  await store.grantOperationalRole({
    telegramUserId: '8080',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID
  });
  const falseReady = await syncHubChannelAdminAccess({
    store,
    bot: noRightBot.bot,
    telegramUserId: '8080'
  });
  assert.equal(falseReady.ok, false);
  assert.equal(hubDmAccessIsReady(await store.getActiveOperationalRole('8080')), false);
  console.log('ok 20 Staff without can_manage_direct_messages is not reported ready');

  await store.revokeOperationalRole({
    telegramUserId: STAFF_ID,
    revokedByTelegramUserId: ROOT_ID
  });
  assert.equal(await store.getActiveOperationalRole(STAFF_ID), null);
  const revokedForward = await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: STAFF_ID, text: 'should not forward', threadId: 99 }),
    store,
    bot: grantBot.bot
  });
  assert.equal(revokedForward, true);
  assert.equal(grantBot.calls.send.some((call) => /should not forward/.test(call.text || '')), false);
  console.log('ok 21 revoked Ledger Staff loses backend authority immediately');

  const listCtx = makeCbCtx({ fromId: ROOT_ID, data: STAFF_CB.STAFF_LIST });
  await handleStaffCallbackQuery({ ctx: listCtx, store, bot: grantBot.bot });
  assert.match(listCtx.replies.join('\n'), /Hub DM Access/);
  console.log('ok 22 Control Center staff list shows Hub DM access state');

  const subscriberRights = await store.getActiveOperationalRole(JOHN_ID);
  assert.equal(subscriberRights, null);
  console.log('ok 23 ordinary subscribers have no staff rights');

  function restore(key, value) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  restore('ROYAL_VIP_HUB_CHANNEL_ID', previous.hub);
  restore('ROYAL_VIP_HUB_DM_CHAT_ID', previous.dm);
  restore('STAFF_TELEGRAM_GROUP_ID', previous.group);
  restore('ROOT_ADMIN_TELEGRAM_USER_ID', previous.root);
  console.log('ok royal vip hub native direct-message CRM');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
