/**
 * Royal Vip Hub native Channel Direct Messages.
 *
 * Public Hub posts stay on the channel. Player conversations use Telegram's
 * native Direct Messages chat + DirectMessagesTopic. Staff with
 * can_manage_direct_messages see those chat heads in Telegram. Ledger persists
 * identity, messages, and topic mapping. Old staff-forum topics remain fallback
 * only when no native topic exists.
 */

import { ensureBotApiPrivateContact } from './botPrivateEntry.js';
import {
  OPERATIONAL_ROLES,
  isRoyalVipHubChat,
  normalizeTelegramUserId,
  royalVipHubChannelIdFromEnv,
  royalVipHubDmChatIdFromEnv,
  rootAdminTelegramUserIdFromEnv
} from './operationalRoles.js';
import {
  appBegUsernameForContact,
  extractSupportedInboundMedia,
  formatHubDmIdentityCard,
  isRegisteredRoyalVipContact,
  unsupportedInboundMediaLabel
} from './playerSupportMessaging.js';
import { telegramErrorText } from './telegramApiErrors.js';
import { notifyStaffNewSupportConversation } from './operationalAlerts.js';

export const HUB_CHANNEL_DM_SOURCE = 'hub_channel_dm';

export const HUB_ADMIN_STATUS = {
  ACTIVE: 'active',
  PENDING: 'pending',
  ERROR: 'error',
  SKIPPED_ROOT: 'skipped_root',
  SKIPPED_CREATOR: 'skipped_creator'
};

export const HUB_DM_STAFF_ADMIN_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_messages: false,
  can_edit_messages: false,
  can_pin_messages: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_manage_topics: false,
  can_manage_direct_messages: true
};

export const HUB_DM_DEMOTE_RIGHTS = {
  ...HUB_DM_STAFF_ADMIN_RIGHTS,
  can_manage_direct_messages: false
};

const MEDIA_API_METHODS = {
  photo: 'sendPhoto',
  video: 'sendVideo',
  document: 'sendDocument',
  audio: 'sendAudio',
  voice: 'sendVoice'
};

export function telegramIdToText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return String(value);
  const text = String(value).trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  return text;
}

export function telegramApiId(value) {
  const text = telegramIdToText(value);
  if (!text) return null;
  if (text.length <= 15 && Number.isSafeInteger(Number(text))) return Number(text);
  return text;
}

export function extractDirectMessagesTopic(message = null) {
  const topic = message?.direct_messages_topic;
  if (!topic || typeof topic !== 'object') return null;
  const topicId = telegramIdToText(topic.topic_id);
  const user = topic.user && typeof topic.user === 'object' ? topic.user : null;
  const userId = telegramIdToText(user?.id);
  if (!topicId || !userId) return null;
  return { topicId, user, userId };
}

export function extractParentChatId(chat = null) {
  return telegramIdToText(chat?.parent_chat?.id);
}

export function isDirectMessagesChat(chat = null) {
  return Boolean(chat?.is_direct_messages === true);
}

export function describeHubDirectMessagesChat(chat = null, {
  env = process.env,
  storedDmChatId = null,
  hubChannelId = royalVipHubChannelIdFromEnv(env),
  dmChatId = royalVipHubDmChatIdFromEnv(env) || telegramIdToText(storedDmChatId)
} = {}) {
  const chatId = telegramIdToText(chat?.id);
  const parentId = extractParentChatId(chat);
  const configuredHub = telegramIdToText(hubChannelId);
  const configuredDm = telegramIdToText(dmChatId);
  const reasons = [];
  if (!chatId) {
    return { matched: false, chatId: null, parentId, reasons: ['missing_chat_id'] };
  }
  if (configuredHub && chatId === configuredHub) {
    return { matched: false, chatId, parentId, reasons: ['public_hub_channel'] };
  }
  if (isDirectMessagesChat(chat)) reasons.push('is_direct_messages');
  if (configuredHub && parentId && parentId === configuredHub) reasons.push('parent_chat');
  if (configuredDm && chatId === configuredDm) reasons.push('configured_dm_chat');
  const matched = reasons.includes('parent_chat')
    || reasons.includes('configured_dm_chat')
    || (reasons.includes('is_direct_messages') && !configuredHub);
  return { matched, chatId, parentId, reasons };
}

export function isRoyalVipHubDirectMessagesChat(chat, options = {}) {
  return describeHubDirectMessagesChat(chat, options).matched;
}

export function hubDmAccessLabel(role = null) {
  if (!role) return '⚠️ Pending';
  if (role.role === OPERATIONAL_ROLES.ROOT_ADMIN) return '✅ Owner';
  const status = String(role.telegram_channel_admin_status || '').trim();
  if (status === HUB_ADMIN_STATUS.ACTIVE) return '✅';
  if (status === HUB_ADMIN_STATUS.SKIPPED_ROOT || status === HUB_ADMIN_STATUS.SKIPPED_CREATOR) return '✅ Owner';
  if (status === HUB_ADMIN_STATUS.PENDING || status === HUB_ADMIN_STATUS.ERROR || !status) return '⚠️ Pending';
  return '⚠️ Pending';
}

export function hubDmAccessIsReady(role = null) {
  if (!role) return false;
  if (role.role === OPERATIONAL_ROLES.ROOT_ADMIN) return true;
  return String(role.telegram_channel_admin_status || '') === HUB_ADMIN_STATUS.ACTIVE
    || String(role.telegram_channel_admin_status || '') === HUB_ADMIN_STATUS.SKIPPED_CREATOR
    || String(role.telegram_channel_admin_status || '') === HUB_ADMIN_STATUS.SKIPPED_ROOT;
}

export function needsHubTelegramRetry(role = null) {
  if (!role || role.role === OPERATIONAL_ROLES.ROOT_ADMIN) return false;
  return !hubDmAccessIsReady(role);
}

function callTelegramApi(telegram, method, payload) {
  if (typeof telegram?.callApi === 'function') {
    return telegram.callApi(method, payload);
  }
  if (typeof telegram?.[method] === 'function') {
    return telegram[method](payload);
  }
  const error = new Error(`Telegram method ${method} is not available.`);
  error.code = 'TELEGRAM_METHOD_MISSING';
  throw error;
}

export function extractHubDirectMessageMedia(message = null) {
  const basic = extractSupportedInboundMedia(message);
  if (basic) return basic;
  if (!message || typeof message !== 'object') return null;
  if (message.video?.file_id) {
    return { kind: 'video', fileId: message.video.file_id, fileUniqueId: message.video.file_unique_id || null };
  }
  if (message.audio?.file_id) {
    return { kind: 'audio', fileId: message.audio.file_id, fileUniqueId: message.audio.file_unique_id || null };
  }
  if (message.voice?.file_id) {
    return { kind: 'voice', fileId: message.voice.file_id, fileUniqueId: message.voice.file_unique_id || null };
  }
  return null;
}

export async function sendToHubDirectMessageTopic(telegram, {
  dmChatId,
  topicId,
  text = '',
  media = null,
  sourceChatId = null,
  sourceMessageId = null
} = {}) {
  const chatId = telegramApiId(dmChatId);
  const directMessagesTopicId = telegramApiId(topicId);
  if (chatId == null || directMessagesTopicId == null) {
    const error = new Error('Hub direct-message topic is incomplete.');
    error.code = 'HUB_DM_TOPIC_INCOMPLETE';
    throw error;
  }
  const caption = String(text || '').trim();
  if (sourceChatId && sourceMessageId) {
    try {
      return await callTelegramApi(telegram, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: telegramApiId(sourceChatId),
        message_id: Number(sourceMessageId),
        direct_messages_topic_id: directMessagesTopicId,
        ...(caption ? { caption } : {})
      });
    } catch (error) {
      if (!media?.fileId && !caption) throw error;
    }
  }
  if (media?.fileId && MEDIA_API_METHODS[media.kind]) {
    const method = MEDIA_API_METHODS[media.kind];
    const fileField = media.kind === 'document' ? 'document'
      : media.kind === 'photo' ? 'photo'
        : media.kind === 'video' ? 'video'
          : media.kind === 'audio' ? 'audio'
            : 'voice';
    return callTelegramApi(telegram, method, {
      chat_id: chatId,
      [fileField]: media.fileId,
      direct_messages_topic_id: directMessagesTopicId,
      ...(caption ? { caption } : {})
    });
  }
  if (!caption) {
    const error = new Error('Hub direct-message text is empty.');
    error.code = 'HUB_DM_EMPTY';
    throw error;
  }
  return callTelegramApi(telegram, 'sendMessage', {
    chat_id: chatId,
    text: caption,
    direct_messages_topic_id: directMessagesTopicId
  });
}

export async function inspectHubBotAdminRights(telegram, {
  hubChannelId,
  botId
} = {}) {
  const chatId = telegramApiId(hubChannelId);
  const userId = telegramApiId(botId);
  if (chatId == null || userId == null) {
    return {
      ok: false,
      reason: 'missing_ids',
      canManageDirectMessages: false,
      canPromoteMembers: false
    };
  }
  try {
    const member = await (typeof telegram.getChatMember === 'function'
      ? telegram.getChatMember(chatId, userId)
      : callTelegramApi(telegram, 'getChatMember', { chat_id: chatId, user_id: userId }));
    const canManageDirectMessages = Boolean(member?.can_manage_direct_messages);
    const canPromoteMembers = Boolean(member?.can_promote_members);
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    return {
      ok: isAdmin,
      status: member?.status || null,
      canManageDirectMessages,
      canPromoteMembers,
      member
    };
  } catch (error) {
    return {
      ok: false,
      reason: telegramErrorText(error),
      canManageDirectMessages: false,
      canPromoteMembers: false,
      error
    };
  }
}

function botRightsError(rights) {
  if (!rights?.canPromoteMembers) {
    return {
      code: 'BOT_CANNOT_PROMOTE',
      message: 'Bot cannot promote administrators.'
    };
  }
  if (!rights?.canManageDirectMessages) {
    return {
      code: 'BOT_CANNOT_MANAGE_DIRECT_MESSAGES',
      message: 'Bot cannot manage Royal Vip Hub Direct Messages.'
    };
  }
  return null;
}

async function readChatMember(telegram, chatId, userId) {
  if (typeof telegram.getChatMember === 'function') {
    return telegram.getChatMember(chatId, userId);
  }
  return callTelegramApi(telegram, 'getChatMember', { chat_id: chatId, user_id: userId });
}

export async function syncHubChannelAdminAccess({
  store,
  bot,
  telegramUserId,
  env = process.env
} = {}) {
  const userId = normalizeTelegramUserId(telegramUserId);
  const hubChannelId = royalVipHubChannelIdFromEnv(env);
  const now = new Date().toISOString();
  if (!userId) {
    return { ok: false, status: HUB_ADMIN_STATUS.ERROR, error: 'Telegram user ID is required.' };
  }
  if (userId === rootAdminTelegramUserIdFromEnv(env)) {
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.SKIPPED_ROOT,
      error: null,
      syncedAt: now
    });
    return { ok: true, status: HUB_ADMIN_STATUS.SKIPPED_ROOT, skipped: 'root_admin' };
  }
  if (!hubChannelId) {
    const error = 'Royal Vip Hub channel is not configured.';
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.PENDING,
      error,
      syncedAt: now
    });
    return { ok: false, status: HUB_ADMIN_STATUS.PENDING, error, code: 'HUB_NOT_CONFIGURED' };
  }
  const telegram = bot?.telegram;
  if (!telegram) {
    const error = 'Telegram bot is not configured.';
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.PENDING,
      error,
      syncedAt: now
    });
    return { ok: false, status: HUB_ADMIN_STATUS.PENDING, error, code: 'BOT_UNCONFIGURED' };
  }
  let botId = bot?.botInfo?.id || null;
  if (!botId && typeof telegram.getMe === 'function') {
    try {
      botId = (await telegram.getMe())?.id || null;
    } catch {
      botId = null;
    }
  }
  const rights = await inspectHubBotAdminRights(telegram, { hubChannelId, botId });
  const rightsError = botRightsError(rights);
  if (rightsError) {
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.PENDING,
      error: rightsError.message,
      syncedAt: now
    });
    return { ok: false, status: HUB_ADMIN_STATUS.PENDING, error: rightsError.message, code: rightsError.code };
  }
  try {
    const member = await readChatMember(telegram, telegramApiId(hubChannelId), telegramApiId(userId));
    if (member?.status === 'creator') {
      await store.setOperationalRoleHubAccess?.({
        telegramUserId: userId,
        status: HUB_ADMIN_STATUS.SKIPPED_CREATOR,
        error: null,
        syncedAt: now
      });
      return { ok: true, status: HUB_ADMIN_STATUS.SKIPPED_CREATOR, skipped: 'creator' };
    }
  } catch {
    // User may not be a member yet; promotion still attempts.
  }
  try {
    await callTelegramApi(telegram, 'promoteChatMember', {
      chat_id: telegramApiId(hubChannelId),
      user_id: telegramApiId(userId),
      ...HUB_DM_STAFF_ADMIN_RIGHTS
    });
    let verified = false;
    try {
      const updated = await readChatMember(telegram, telegramApiId(hubChannelId), telegramApiId(userId));
      verified = Boolean(updated?.can_manage_direct_messages);
    } catch {
      verified = false;
    }
    if (!verified) {
      const error = 'Staff does not have can_manage_direct_messages.';
      await store.setOperationalRoleHubAccess?.({
        telegramUserId: userId,
        status: HUB_ADMIN_STATUS.PENDING,
        error,
        syncedAt: now
      });
      return { ok: false, status: HUB_ADMIN_STATUS.PENDING, error, code: 'MISSING_DIRECT_MESSAGE_RIGHT' };
    }
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.ACTIVE,
      error: null,
      syncedAt: now
    });
    return { ok: true, status: HUB_ADMIN_STATUS.ACTIVE };
  } catch (error) {
    const message = telegramErrorText(error).slice(0, 400) || 'Telegram promotion failed.';
    await store.setOperationalRoleHubAccess?.({
      telegramUserId: userId,
      status: HUB_ADMIN_STATUS.PENDING,
      error: message,
      syncedAt: now
    });
    return { ok: false, status: HUB_ADMIN_STATUS.PENDING, error: message, code: 'TELEGRAM_API_ERROR' };
  }
}

export async function demoteHubChannelAdminAccess({
  store,
  bot,
  telegramUserId,
  env = process.env
} = {}) {
  const userId = normalizeTelegramUserId(telegramUserId);
  const hubChannelId = royalVipHubChannelIdFromEnv(env);
  if (!userId) return { ok: false, error: 'Telegram user ID is required.' };
  if (userId === rootAdminTelegramUserIdFromEnv(env)) {
    return { ok: true, skipped: 'root_admin' };
  }
  const telegram = bot?.telegram;
  if (!telegram || !hubChannelId) {
    return { ok: false, error: !hubChannelId ? 'Royal Vip Hub channel is not configured.' : 'Telegram bot is not configured.', drifted: true };
  }
  try {
    const member = await readChatMember(telegram, telegramApiId(hubChannelId), telegramApiId(userId));
    if (member?.status === 'creator') {
      return { ok: true, skipped: 'creator' };
    }
  } catch {
    // Continue to demote attempt.
  }
  try {
    await callTelegramApi(telegram, 'promoteChatMember', {
      chat_id: telegramApiId(hubChannelId),
      user_id: telegramApiId(userId),
      ...HUB_DM_DEMOTE_RIGHTS
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      drifted: true,
      error: telegramErrorText(error).slice(0, 400) || 'Telegram demotion failed.'
    };
  }
}

export async function grantOperationalRoleWithHubAccess(store, grantArgs, { bot, env = process.env } = {}) {
  const granted = await store.grantOperationalRole(grantArgs);
  const telegramAccess = await syncHubChannelAdminAccess({
    store,
    bot,
    telegramUserId: grantArgs.telegramUserId,
    env
  });
  return { ...granted, telegramAccess };
}

export async function revokeOperationalRoleWithHubAccess(store, revokeArgs, { bot, env = process.env } = {}) {
  const revoked = await store.revokeOperationalRole(revokeArgs);
  const telegramAccess = await demoteHubChannelAdminAccess({
    store,
    bot,
    telegramUserId: revokeArgs.telegramUserId,
    env
  });
  return { ...revoked, telegramAccess };
}

export function formatStaffGrantResultText(telegramUserId, telegramAccess) {
  const user = String(telegramUserId);
  if (telegramAccess?.ok && hubDmAccessIsReady({ telegram_channel_admin_status: telegramAccess.status, role: OPERATIONAL_ROLES.STAFF })) {
    return `Staff access granted to Telegram user ${user}.\nHub DM Access: ✅`;
  }
  const reason = telegramAccess?.error || 'Telegram Hub access is not ready.';
  return [
    `Staff Ledger role granted to Telegram user ${user}.`,
    'Hub DM Access: ⚠️ Pending',
    reason,
    'Staff were not told Hub Direct Messages are ready.'
  ].join('\n');
}

export function formatStaffRevokeResultText(telegramUserId, telegramAccess) {
  const user = String(telegramUserId);
  if (telegramAccess?.ok) {
    return `Removed operational access for ${user}. Authority ends immediately. Hub DM admin rights were removed.`;
  }
  return [
    `Removed operational access for ${user}. Authority ends immediately.`,
    `Telegram Hub admin rights could not be removed: ${telegramAccess?.error || 'unknown error'}.`,
    'Correct Telegram admin rights manually if they still appear.'
  ].join('\n');
}

async function persistDiscoveredDmChatId(store, chatId) {
  if (!chatId || typeof store.saveDiscoveredHubDmChatId !== 'function') return;
  await store.saveDiscoveredHubDmChatId(chatId).catch(() => null);
}

export async function deliverPlayerFacingHubNotice({
  store,
  bot,
  contact,
  text,
  media = null,
  sourceChatId = null,
  sourceMessageId = null,
  actorName = 'Royal Vip'
} = {}) {
  const body = String(text || '').trim();
  if (!contact?.id || !body) return { ok: false, delivered: false, reason: 'empty' };
  const topic = await store.getChannelDmTopicForContact?.(contact.id);
  const telegram = bot?.telegram;
  if (topic && telegram) {
    try {
      const sent = await sendToHubDirectMessageTopic(telegram, {
        dmChatId: topic.direct_messages_chat_id,
        topicId: topic.direct_messages_topic_id,
        text: body,
        media,
        sourceChatId,
        sourceMessageId
      });
      await store.storeOutgoingMessage?.({
        telegramUserId: contact.id,
        userId: contact.id,
        text: body,
        senderType: 'bot',
        staffName: actorName,
        telegramMessageId: sent?.message_id || null,
        messageType: media?.kind || 'text',
        source: HUB_CHANNEL_DM_SOURCE,
        payload: {
          hubChannelId: topic.hub_channel_id,
          directMessagesChatId: topic.direct_messages_chat_id,
          directMessagesTopicId: topic.direct_messages_topic_id,
          via: 'native_hub_dm'
        }
      }).catch(() => null);
      return {
        ok: true,
        delivered: true,
        via: 'native_hub_dm',
        telegramMessageId: sent?.message_id || null,
        topic
      };
    } catch (error) {
      return { ok: false, delivered: false, via: 'native_hub_dm', error, topic };
    }
  }
  return { ok: true, delivered: false, via: 'fallback', reason: 'no_native_topic', topic: topic || null };
}

export async function handleRoyalVipHubDirectMessage({
  ctx,
  store,
  bot,
  io = null,
  env = process.env
} = {}) {
  const message = ctx?.message;
  const chat = ctx?.chat || message?.chat;
  const storedDmChatId = await store.getDiscoveredHubDmChatId?.().catch(() => null);
  const described = describeHubDirectMessagesChat(chat, { env, storedDmChatId });
  if (!described.matched || !message) {
    return { handled: false, reason: 'not_hub_dm' };
  }
  if (isRoyalVipHubChat(chat?.id, env)) {
    return { handled: false, reason: 'public_hub_channel' };
  }
  const topic = extractDirectMessagesTopic(message);
  if (!topic) {
    return { handled: true, ignored: true, reason: 'missing_direct_messages_topic' };
  }
  const hubChannelId = described.parentId || royalVipHubChannelIdFromEnv(env);
  if (!hubChannelId) {
    return { handled: true, ignored: true, reason: 'hub_not_configured' };
  }
  const contact = await ensureBotApiPrivateContact(store, topic.user);
  const automation = await store.getAutomationState?.(contact.id).catch(() => null);
  const enriched = {
    ...contact,
    registration_info: automation?.registration_info || contact.registration_info || {}
  };
  const mapping = await store.upsertChannelDmTopic({
    hubChannelId,
    directMessagesChatId: described.chatId,
    directMessagesTopicId: topic.topicId,
    telegramUserId: topic.userId,
    contactId: contact.id
  });
  await persistDiscoveredDmChatId(store, described.chatId);

  const actorId = normalizeTelegramUserId(ctx.from?.id || message.from?.id);
  const actorRole = actorId ? await store.getActiveOperationalRole(actorId).catch(() => null) : null;
  const senderChatId = telegramIdToText(message.sender_chat?.id);
  const isChannelSide = Boolean(senderChatId && (senderChatId === hubChannelId || senderChatId === described.chatId));
  const isStaffActor = Boolean(actorRole) || isChannelSide || Boolean(ctx.from?.is_bot);
  const text = String(message.text || message.caption || '').trim();
  const media = extractHubDirectMessageMedia(message);
  const sentAt = message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString();

  if (isStaffActor) {
    await store.storeOutgoingMessage?.({
      telegramUserId: contact.id,
      userId: contact.id,
      text: text || `[${media?.kind || 'message'}]`,
      senderType: actorRole ? 'staff' : 'bot',
      staffName: ctx.from?.first_name || actorId || 'Royal Vip',
      telegramMessageId: message.message_id,
      messageType: media?.kind || (message.text ? 'text' : 'unknown'),
      source: HUB_CHANNEL_DM_SOURCE,
      sentAt,
      payload: {
        updateId: ctx.update?.update_id ?? null,
        hubChannelId,
        directMessagesChatId: described.chatId,
        directMessagesTopicId: topic.topicId,
        actorTelegramUserId: actorId,
        via: 'native_hub_dm_staff'
      }
    }).catch(() => null);
    return {
      handled: true,
      persisted: true,
      direction: 'outgoing',
      contact,
      mapping,
      isolatedUserId: topic.userId
    };
  }

  const persisted = await store.storeIncomingTelegramMessage({
    ...ctx,
    message: { ...message, from: topic.user }
  }, {
    source: HUB_CHANNEL_DM_SOURCE,
    fromUser: topic.user
  });

  if (persisted?.inserted && mapping?.created) {
    await notifyStaffNewSupportConversation(store, {
      bot,
      contact: enriched,
      nativeHubDm: true
    }).catch(() => null);
  }
  if (persisted?.inserted && io) {
    io.emit('message:new', {
      userId: contact.id,
      contactId: contact.id,
      telegramId: contact.telegram_id
    });
    io.emit('contacts:changed');
  }
  return {
    handled: true,
    persisted: Boolean(persisted),
    inserted: Boolean(persisted?.inserted),
    direction: 'incoming',
    contact: enriched,
    mapping,
    registered: isRegisteredRoyalVipContact(enriched),
    identityCard: formatHubDmIdentityCard(enriched),
    isolatedUserId: topic.userId,
    unsupportedMedia: unsupportedInboundMediaLabel(message),
    media,
    username: appBegUsernameForContact(enriched)
  };
}
