import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import {
  ROYAL_VIP_HUB_STOREFRONT_TEXT,
  royalVipBotDeepLinks,
  royalVipHubStorefrontMarkup
} from '../src/telegram/channelDeepLinks.js';
import { ensureRoyalVipHubStorefront } from '../src/telegram/royalVipHubManager.js';
import {
  extractSupportedInboundMedia,
  PRIVATE_SUPPORT_PROMPT,
  shouldMirrorPlayerInboundToStaff,
  staffTopicTitleForContact
} from '../src/telegram/playerSupportMessaging.js';
import {
  deliverStaffReplyToPlayer,
  ensureStaffTopicForContact,
  mirrorPlayerMessageToStaffTopic,
  staffAskPlayer
} from '../src/telegram/staffOperations.js';
import {
  handleStaffCallbackQuery,
  handleStaffGroupMessage,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import { STAFF_CB } from '../src/telegram/staffCards.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-vip-private-support-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const STAFF_GROUP_ID = '-100555000';
const HUB_CHANNEL_ID = '-100777000';
const ROOT_ID = '9001';
const STAFF_ID = '8003';
const STRANGER_ID = '5555';

function telegramError(description) {
  const error = new Error(description);
  error.description = description;
  error.response = { description };
  return error;
}

function mockTelegram({ startThread = 40 } = {}) {
  const calls = {
    send: [],
    edit: [],
    pin: [],
    photo: [],
    document: [],
    copy: [],
    createForumTopic: 0,
    reopen: [],
    editForumTopic: []
  };
  let nextId = 200;
  let nextThread = startThread;
  return {
    calls,
    telegram: {
      async getMe() {
        return { username: 'Royal_Sweeps_bot' };
      },
      async sendMessage(chatId, text, extra = {}) {
        calls.send.push({ chatId: String(chatId), text, extra });
        nextId += 1;
        return { message_id: nextId, message_thread_id: extra.message_thread_id };
      },
      async sendPhoto(chatId, fileId, extra = {}) {
        calls.photo.push({ chatId: String(chatId), fileId, extra });
        nextId += 1;
        return { message_id: nextId };
      },
      async sendDocument(chatId, fileId, extra = {}) {
        calls.document.push({ chatId: String(chatId), fileId, extra });
        nextId += 1;
        return { message_id: nextId };
      },
      async copyMessage(toChatId, fromChatId, messageId, extra = {}) {
        calls.copy.push({
          toChatId: String(toChatId),
          fromChatId: String(fromChatId),
          messageId,
          extra
        });
        nextId += 1;
        return { message_id: nextId };
      },
      async editMessageText(chatId, messageId, _inlineId, text, extra = {}) {
        calls.edit.push({ chatId: String(chatId), messageId, text, extra });
        return true;
      },
      async pinChatMessage(chatId, messageId, extra = {}) {
        calls.pin.push({ chatId: String(chatId), messageId, extra });
        return true;
      },
      async createForumTopic(_chatId, name) {
        calls.createForumTopic += 1;
        nextThread += 1;
        return { message_thread_id: nextThread, name };
      },
      async reopenForumTopic(chatId, threadId) {
        calls.reopen.push({ chatId: String(chatId), threadId });
        return true;
      },
      async editForumTopic(chatId, threadId, name) {
        calls.editForumTopic.push({ chatId: String(chatId), threadId, name });
        return true;
      }
    }
  };
}

function makeGroupCtx({ fromId, text = '', threadId = null, firstName = 'Staff', photo = false, messageId = null }) {
  return {
    replies: [],
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName, is_bot: false },
    message: {
      message_id: messageId || Number(`${fromId}${threadId || 1}`),
      text,
      photo: photo ? [{ file_id: 'staff-photo' }] : undefined,
      message_thread_id: threadId,
      from: { id: Number(fromId) }
    },
    async reply(body) {
      this.replies.push(body);
      return { message_id: this.replies.length };
    }
  };
}

function makeCbCtx({ fromId, data, firstName = 'Staff' }) {
  let answered = null;
  return {
    replies: [],
    get answered() { return answered; },
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName },
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
    group: process.env.STAFF_TELEGRAM_GROUP_ID,
    root: process.env.ROOT_ADMIN_TELEGRAM_USER_ID,
    bot: process.env.TELEGRAM_BOT_USERNAME
  };
  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;
  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = ROOT_ID;
  process.env.TELEGRAM_BOT_USERNAME = 'Royal_Sweeps_bot';

  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  await store.bootstrapRootAdminFromEnv();
  await store.grantOperationalRole({
    telegramUserId: STAFF_ID,
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Alice'
  });

  // 1. Hub storefront contains PLAY / MESSAGE US / FREEPLAY
  const links = royalVipBotDeepLinks('Royal_Sweeps_bot');
  assert.equal(links.support, 'https://t.me/Royal_Sweeps_bot?start=support');
  const markup = royalVipHubStorefrontMarkup('Royal_Sweeps_bot');
  assert.equal(markup.inline_keyboard.length, 3);
  assert.equal(markup.inline_keyboard[1][0].text, '💬 MESSAGE US');
  assert.equal(markup.inline_keyboard[1][0].url, links.support);
  assert.match(ROYAL_VIP_HUB_STOREFRONT_TEXT, /contact our team privately/i);
  assert.doesNotMatch(ROYAL_VIP_HUB_STOREFRONT_TEXT, /telegram id|payment review|freeplay approved/i);
  console.log('ok 1 hub storefront PLAY/MESSAGE US/FREEPLAY');

  const hubBot = mockTelegram();
  const created = await ensureRoyalVipHubStorefront({ store, bot: hubBot });
  assert.equal(created.ok, true);
  assert.equal(hubBot.calls.send.length, 1);
  assert.equal(hubBot.calls.send[0].chatId, HUB_CHANNEL_ID);
  const firstHubId = created.messageId;
  const edited = await ensureRoyalVipHubStorefront({ store, bot: hubBot });
  assert.equal(edited.created, false);
  assert.equal(hubBot.calls.send.filter((call) => call.chatId === HUB_CHANNEL_ID).length, 1);
  assert.equal(Number(hubBot.calls.edit[0].messageId), Number(firstHubId));
  console.log('ok 21 hub refresh edits existing storefront rather than duplicating');

  const john = await store.upsertTelegramUser({
    telegram_id: 7001,
    username: 'john',
    first_name: 'John',
    is_bot: false
  });
  const mike = await store.upsertTelegramUser({
    telegram_id: 7002,
    username: 'mike',
    first_name: 'Mike',
    is_bot: false
  });
  await store.updateRegistrationStatus(mike.id, 'Registered', 'Test');
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ? WHERE id = ?')
    .run('mike123', mike.id);

  // 2-3 /start support
  const registeredStart = await decideBotReply({
    store,
    contact: { ...mike, telegram_sync_source: 'bot_api', active_messaging_source: 'bot_api' },
    messageText: '/start support'
  });
  assert.equal(registeredStart.kind, 'private_support_welcome');
  assert.equal(registeredStart.replies[0].text, PRIVATE_SUPPORT_PROMPT);
  assert.equal(registeredStart.statePatch.currentFlow, 'private_support');
  console.log('ok 2 /start support registered player');

  const unregisteredStart = await decideBotReply({
    store,
    contact: { ...john, telegram_sync_source: 'bot_api', active_messaging_source: 'bot_api' },
    messageText: '/start support'
  });
  assert.equal(unregisteredStart.kind, 'private_support_welcome');
  assert.equal(unregisteredStart.replies[0].text, PRIVATE_SUPPORT_PROMPT);
  console.log('ok 3 /start support unregistered user');

  await store.updateAutomationState(john.id, unregisteredStart.statePatch);

  // 4 unregistered support creates one Telegram contact, no AppBeg player
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: 'I need help before I register',
    automationState: { current_flow: 'private_support', current_step: 'awaiting_message' }
  }), true);
  const supportBot = mockTelegram();
  const firstMirror = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: supportBot,
    contact: john,
    text: 'I need help before I register'
  });
  assert.equal(firstMirror.mirrored, true);
  assert.equal(firstMirror.created, true);
  assert.equal(supportBot.calls.createForumTopic, 1);
  assert.match(supportBot.calls.send.find((call) => call.extra.message_thread_id).text, /Not registered/);
  assert.match(staffTopicTitleForContact(john), /Not registered/);
  const contactsNamedJohn = await store.db.prepare(
    "SELECT id FROM telegram_users WHERE telegram_id = ?"
  ).all(7001);
  assert.equal(contactsNamedJohn.length, 1);
  assert.equal(john.appbeg_account_id == null || john.appbeg_account_id === '', true);
  console.log('ok 4 unregistered support message creates one Telegram contact');

  // 12 channel never receives support text
  assert.equal(supportBot.calls.send.some((call) => call.chatId === HUB_CHANNEL_ID), false);
  console.log('ok 12 channel never receives support text');

  // 6 same staff topic reused
  const secondMirror = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: supportBot,
    contact: john,
    text: 'Still me'
  });
  assert.equal(secondMirror.created, false);
  assert.equal(supportBot.calls.createForumTopic, 1);
  assert.equal(Number((await store.getStaffTopicForContact(john.id)).message_thread_id), Number(firstMirror.topic.message_thread_id));
  console.log('ok 6 same staff topic reused');

  // 5 later registration attaches to the same contact/topic
  await store.updateRegistrationStatus(john.id, 'Registered', 'Test');
  await store.updateAutomationState(john.id, {
    registrationInfo: {
      preferred_appbeg_username: 'john123',
      appbeg_player_uid: 'player-john',
      appbeg_creation_complete: true
    }
  });
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('john123', 'linked', john.id);
  const afterRegister = await store.upsertTelegramUser({
    telegram_id: 7001,
    username: 'john',
    first_name: 'John',
    is_bot: false
  });
  assert.equal(Number(afterRegister.id), Number(john.id));
  const registeredJohn = await store.getUserProfile(john.id);
  const titleRefresh = await ensureStaffTopicForContact({
    store,
    bot: supportBot,
    contact: registeredJohn
  });
  assert.equal(Number(titleRefresh.topic.message_thread_id), Number(firstMirror.topic.message_thread_id));
  assert.match(titleRefresh.title, /john123/);
  const stillOne = await store.db.prepare('SELECT COUNT(*) AS n FROM telegram_users WHERE telegram_id = ?').get(7001);
  assert.equal(Number(stillOne.n), 1);
  const topicCount = await store.db.prepare('SELECT COUNT(*) AS n FROM telegram_staff_topics WHERE contact_id = ?').get(john.id);
  assert.equal(Number(topicCount.n), 1);
  console.log('ok 5 support user later registers → same contact and topic');

  // 7 ordinary player text mirrors with identity
  const mikeBot = mockTelegram({ startThread: 80 });
  const mikeMirror = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: mikeBot,
    contact: await store.getUserProfile(mike.id),
    text: 'Hello'
  });
  assert.equal(mikeMirror.mirrored, true);
  const mikeCard = mikeBot.calls.send.find((call) => call.extra.message_thread_id)?.text || '';
  assert.match(mikeCard, /Player: Mike/);
  assert.match(mikeCard, /AppBeg: mike123/);
  assert.match(mikeCard, /Telegram ID: 7002/);
  assert.match(mikeCard, /Hello/);
  assert.doesNotMatch(mikeCard, /password/i);
  console.log('ok 7 ordinary player text mirrors to staff topic');

  // 8 staff reply returns privately to correct user
  const johnThread = Number((await store.getStaffTopicForContact(john.id)).message_thread_id);
  const mikeThread = Number((await store.getStaffTopicForContact(mike.id)).message_thread_id);
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: STAFF_ID, text: 'We can help, John.', threadId: johnThread, messageId: 501 }),
    store,
    bot: supportBot
  });
  const johnDm = supportBot.calls.send.find((call) => call.chatId === '7001' && /We can help, John/.test(call.text));
  assert.ok(johnDm);
  assert.match(johnDm.text, /^Royal Vip:/);
  assert.equal(supportBot.calls.send.some((call) => call.chatId === '7002' && /We can help, John/.test(call.text)), false);
  console.log('ok 8 staff reply returns privately to correct user');

  // 11 Staff reply to John cannot reach Mike
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: STAFF_ID, text: 'Hi Mike only', threadId: mikeThread, messageId: 502 }),
    store,
    bot: mikeBot
  });
  assert.equal(mikeBot.calls.send.some((call) => call.chatId === '7001' && /Hi Mike only/.test(call.text)), false);
  assert.equal(mikeBot.calls.send.some((call) => call.chatId === '7002' && /Hi Mike only/.test(call.text)), true);
  console.log('ok 11 staff reply to John cannot reach Mike');

  // 9 random group member reply blocked
  const beforeStranger = supportBot.calls.send.length;
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: STRANGER_ID, text: 'I am in the group', threadId: johnThread, messageId: 503 }),
    store,
    bot: supportBot
  });
  assert.equal(supportBot.calls.send.length, beforeStranger);
  console.log('ok 9 random group member reply blocked');

  // 10 revoked staff reply blocked immediately
  await store.revokeOperationalRole({ telegramUserId: STAFF_ID, revokedByTelegramUserId: ROOT_ID });
  const beforeRevoke = supportBot.calls.send.length;
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: STAFF_ID, text: 'Still trying', threadId: johnThread, messageId: 504 }),
    store,
    bot: supportBot
  });
  assert.equal(supportBot.calls.send.length, beforeRevoke);
  await store.grantOperationalRole({
    telegramUserId: STAFF_ID,
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: ROOT_ID,
    telegramDisplayName: 'Alice'
  });
  console.log('ok 10 revoked staff reply blocked immediately');

  // 13 registration input is not ordinary support
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: 'secret-pass',
    automationState: { current_flow: 'bot_registration', current_step: 'password' }
  }), false);
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: 'john123',
    automationState: { current_flow: 'bot_registration', current_step: 'username' }
  }), false);
  const playStart = await decideBotReply({
    store,
    contact: {
      ...await store.upsertTelegramUser({ telegram_id: 7003, first_name: 'Guest', is_bot: false }),
      telegram_sync_source: 'bot_api',
      registration_status: 'New'
    },
    messageText: '/start play'
  });
  assert.notEqual(playStart.kind, 'private_support_welcome');
  console.log('ok 13 registration state input is not mistaken for support');

  // 14 deposit flow input is not support
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: '25',
    automationState: { current_flow: 'registered_deposit', current_step: 'deposit_amount' }
  }), false);
  console.log('ok 14 deposit flow input is not mistaken for support');

  // 15 Freeplay command is not support
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: '/start freeplay',
    automationState: { current_flow: null, current_step: null }
  }), false);
  console.log('ok 15 Freeplay flow input is not mistaken for support');

  // 16 ASK PLAYER uses same conversation/topic
  const now = new Date().toISOString();
  const paymentInsert = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      payer_contact_id, message_date, created_at, updated_at
    ) VALUES (9901, -100, 'Pay', 'You received $10.00 from John.', '{}', 'Parsed', 'unmatched', 10, 'John', 'Chime', ?, ?, ?, ?)
  `).run(john.id, now, now, now);
  const askBot = mockTelegram({ startThread: 160 });
  globalThis.telegramBot = askBot;
  const asked = await staffAskPlayer(store, paymentInsert.lastInsertRowid, ROOT_ID, { bot: askBot });
  assert.equal(Number(asked.contactId), Number(john.id));
  assert.equal(Number((await store.getStaffTopicForContact(john.id)).message_thread_id), johnThread);
  assert.equal(askBot.calls.createForumTopic, 0);
  assert.equal(askBot.calls.send.some((call) => /Is this your payment/.test(call.text) && call.chatId === '7001'), true);
  assert.equal(askBot.calls.send.some((call) => /asked the player/i.test(call.text) && call.extra.message_thread_id === johnThread), true);
  const askCb = makeCbCtx({ fromId: ROOT_ID, data: `${STAFF_CB.ASK}${paymentInsert.lastInsertRowid}` });
  await handleStaffCallbackQuery({ ctx: askCb, store, bot: askBot });
  assert.equal(askCb.answered, 'Asked player');
  console.log('ok 16 ASK PLAYER uses same conversation/topic');

  // 17 closed topic reopens
  let sendAttempts = 0;
  const reopenBot = mockTelegram();
  reopenBot.telegram.sendMessage = async (chatId, text, extra = {}) => {
    reopenBot.calls.send.push({ chatId: String(chatId), text, extra });
    if (extra?.message_thread_id === johnThread && sendAttempts === 0) {
      sendAttempts += 1;
      throw telegramError('Bad Request: TOPIC_CLOSED');
    }
    sendAttempts += 1;
    return { message_id: 800 + sendAttempts, message_thread_id: extra.message_thread_id };
  };
  const reopened = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: reopenBot,
    contact: john,
    text: 'are you there'
  });
  assert.equal(reopened.mirrored, true);
  assert.equal(reopened.reopened, true);
  assert.equal(reopenBot.calls.reopen.length, 1);
  console.log('ok 17 closed topic reopens');

  // 18 topic failure preserves message
  const failBot = mockTelegram();
  failBot.telegram.sendMessage = async (chatId, text, extra = {}) => {
    failBot.calls.send.push({ chatId: String(chatId), text, extra });
    if (extra?.message_thread_id === johnThread) throw telegramError('Bad Request: TOPIC_CLOSED');
    return { message_id: 900, message_thread_id: extra.message_thread_id };
  };
  failBot.telegram.reopenForumTopic = async () => {
    throw telegramError('Forbidden: not enough rights to manage topics');
  };
  const persistedInbound = await store.storeIncomingTelegramMessage({
    message: {
      message_id: 42,
      date: Math.floor(Date.now() / 1000),
      text: 'please keep this',
      from: { id: 7001, first_name: 'John', is_bot: false }
    }
  });
  const reopenFailed = await mirrorPlayerMessageToStaffTopic({
    store,
    bot: failBot,
    contact: john,
    text: 'please keep this'
  });
  assert.equal(persistedInbound.inserted, true);
  assert.equal(reopenFailed.persisted, true);
  assert.equal(reopenFailed.mirrored, false);
  assert.equal(reopenFailed.reason, 'reopen_failed');
  console.log('ok 18 topic failure preserves message');

  // 19 duplicate Telegram inbound update does not duplicate mirrored message
  const dupCtx = {
    message: {
      message_id: 77,
      date: Math.floor(Date.now() / 1000),
      text: 'duplicate inbound',
      from: { id: 7002, first_name: 'Mike', is_bot: false }
    }
  };
  const firstInbound = await store.storeIncomingTelegramMessage(dupCtx);
  const secondInbound = await store.storeIncomingTelegramMessage(dupCtx);
  assert.equal(firstInbound.inserted, true);
  assert.equal(secondInbound.inserted, false);
  console.log('ok 19 duplicate Telegram inbound update does not duplicate mirrored message');

  // 20 media support: photo and document
  const photoMessage = {
    chat: { id: 7002 },
    message_id: 88,
    photo: [{ file_id: 'small' }, { file_id: 'large-photo' }],
    caption: 'receipt'
  };
  assert.deepEqual(extractSupportedInboundMedia(photoMessage), {
    kind: 'photo',
    fileId: 'large-photo',
    fileUniqueId: null
  });
  const mediaBot = mockTelegram({ startThread: 120 });
  await mirrorPlayerMessageToStaffTopic({
    store,
    bot: mediaBot,
    contact: await store.getUserProfile(mike.id),
    text: 'receipt',
    message: photoMessage
  });
  assert.equal(mediaBot.calls.copy.length, 1);
  await deliverStaffReplyToPlayer({
    store,
    bot: mediaBot,
    contact: await store.getUserProfile(mike.id),
    text: 'got it',
    media: { kind: 'document', fileId: 'doc-1', fileName: 'note.pdf' }
  });
  assert.equal(mediaBot.calls.document.some((call) => call.chatId === '7002' && call.fileId === 'doc-1'), true);
  assert.match(mediaBot.calls.document[0].extra.caption, /^Royal Vip:/);
  assert.equal(shouldMirrorPlayerInboundToStaff({
    text: '',
    hasSupportedMedia: true,
    automationState: { current_flow: 'private_support' }
  }), true);
  console.log('ok 20 media support for photo and document');

  // Privacy: player A cannot see player B
  assert.notEqual(johnThread, mikeThread);
  assert.equal(shouldMirrorPlayerInboundToStaff({ text: '/start support' }), false);

  restoreEnv(previous);
  console.log('All Royal VIP private support tests passed.');
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
