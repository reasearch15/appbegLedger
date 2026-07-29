import { resolveRoyalVipCredentials } from './accountView.js';

export const ASK_FREEPLAY_ACTION = 'bot:help:ask_freeplay';
export const FREEPLAY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const FREEPLAY_INELIGIBLE_TEXT = 'You are not eligible for FreePlay at this time.';
export const FREEPLAY_REQUEST_SENT_TEXT = 'Your FreePlay request has been sent.';

export function resolveBotOwnerTelegramId({ settings = null, env = process.env } = {}) {
  const fromEnv = String(
    env.TELEGRAM_BOT_OWNER_ID
    || env.TELEGRAM_OWNER_CHAT_ID
    || env.TELEGRAM_BOT_OWNER_CHAT_ID
    || ''
  ).trim();
  if (fromEnv) return fromEnv;
  const fromSettings = String(settings?.telegram_account_id || '').trim();
  return fromSettings || null;
}

export function formatFreePlayRequestedAt(iso = new Date().toISOString()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  const pad = (value) => String(value).padStart(2, '0');
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  ].join(' ');
}

export function resolveFreePlayRoyalVipUsername({ contact = {}, info = {} } = {}) {
  const credentials = resolveRoyalVipCredentials({ contact, info });
  if (credentials?.ok && credentials.username) return credentials.username;
  const fallback = String(
    info?.royal_vip_credentials?.username
    || info?.preferred_appbeg_username
    || info?.appbeg_username
    || contact?.appbeg_username
    || ''
  ).trim();
  return fallback || 'Unknown';
}

export function buildFreePlayOwnerNotificationText({
  contact = {},
  info = {},
  requestedAt = new Date().toISOString()
} = {}) {
  const royalVipUsername = resolveFreePlayRoyalVipUsername({ contact, info });
  const telegramName = String(contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown').trim() || 'Unknown';
  const rawUsername = String(contact.username || '').trim().replace(/^@+/, '');
  const telegramUsername = rawUsername ? `@${rawUsername}` : 'n/a';
  const telegramId = contact.telegram_id == null ? 'n/a' : String(contact.telegram_id);
  const contactId = contact.id == null ? 'n/a' : String(contact.id);
  const playerUid = String(
    contact.appbeg_account_id
    || info.appbeg_player_uid
    || info?.royal_vip_credentials?.player_uid
    || ''
  ).trim() || 'n/a';

  return [
    '🎁 New FreePlay Request',
    '',
    `RoyalVIP Username: ${royalVipUsername}`,
    `Telegram Name: ${telegramName}`,
    `Telegram Username: ${telegramUsername}`,
    `Telegram ID: ${telegramId}`,
    `Contact ID: ${contactId}`,
    `Player UID: ${playerUid}`,
    '',
    'Requested at:',
    formatFreePlayRequestedAt(requestedAt)
  ].join('\n');
}

export async function decideAskFreePlayRequest({ store, contact, info = {} }) {
  if (typeof store?.tryClaimFreePlayRequest !== 'function') {
    throw new Error('FreePlay request store is not configured.');
  }

  const claim = await store.tryClaimFreePlayRequest(contact.id, {
    cooldownMs: FREEPLAY_COOLDOWN_MS
  });

  if (!claim?.ok) {
    console.log(`[chatbot] freeplay_request_ineligible contact=${contact.id}`);
    return {
      kind: 'freeplay_request_ineligible',
      replies: [{ text: FREEPLAY_INELIGIBLE_TEXT }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'freeplay_request_ineligible' }
    };
  }

  const requestedAt = claim.requestedAt || new Date().toISOString();
  console.log(`[chatbot] freeplay_request_claimed contact=${contact.id} requested_at=${requestedAt}`);

  return {
    kind: 'freeplay_request_sent',
    replies: [{ text: FREEPLAY_REQUEST_SENT_TEXT }],
    statePatch: null,
    escalate: false,
    freePlayOwnerNotify: {
      claimedAt: requestedAt,
      text: buildFreePlayOwnerNotificationText({ contact, info, requestedAt })
    },
    logEvent: { event: 'freeplay_request_claimed', requested_at: requestedAt }
  };
}

export async function deliverFreePlayOwnerNotification({
  store,
  contact,
  bot = null,
  notify = null
} = {}) {
  if (!notify?.text || !contact?.id) {
    return { delivered: false, reason: 'missing_notify_payload' };
  }

  const activeBot = bot || globalThis.telegramBot || null;
  if (!activeBot?.telegram?.sendMessage) {
    throw new Error('Telegram bot is required to deliver FreePlay owner notification.');
  }

  const settings = typeof store.getCoadminSettings === 'function'
    ? await store.getCoadminSettings().catch(() => null)
    : null;
  const ownerChatId = resolveBotOwnerTelegramId({ settings });
  if (!ownerChatId) {
    throw new Error('FreePlay owner Telegram ID is not configured.');
  }

  console.log(
    `[chatbot] freeplay_owner_notify_send contact=${contact.id} owner_chat_id=${ownerChatId} ` +
    `claimed_at=${notify.claimedAt || 'n/a'}`
  );

  try {
    const response = await activeBot.telegram.sendMessage(ownerChatId, notify.text);
    const messageId = Number(response?.message_id || 0) || null;
    console.log(
      `[chatbot] freeplay_owner_notify_sent contact=${contact.id} owner_chat_id=${ownerChatId} ` +
      `message_id=${messageId || 'n/a'} claimed_at=${notify.claimedAt || 'n/a'}`
    );
    return { delivered: true, messageId, ownerChatId };
  } catch (error) {
    console.error('[chatbot] freeplay_owner_notify_failed', {
      contact_id: contact.id,
      owner_chat_id: ownerChatId,
      claimed_at: notify.claimedAt || null,
      stack: error?.stack || String(error)
    });
    throw error;
  }
}
