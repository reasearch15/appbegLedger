import {
  ROYAL_VIP_HUB_STOREFRONT_TEXT,
  royalVipHubStorefrontMarkup
} from './channelDeepLinks.js';
import { royalVipHubChannelIdFromEnv } from './operationalRoles.js';
import {
  isAlreadyPinnedError,
  isChatNotFoundError,
  isMessageNotFoundError,
  isMessageNotModifiedError,
  isPermissionDeniedError,
  telegramErrorText
} from './telegramApiErrors.js';

const HUB_NOT_CONFIGURED_LOG = 'Royal Vip Hub not configured.';
const HUB_PERMISSION_ERROR = 'Bot cannot post/edit messages in Royal Vip Hub.';

function resolveBotUsername(bot, env = process.env) {
  const fromEnv = String(env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (fromEnv) return fromEnv;
  return String(
    bot?.botInfo?.username
    || bot?.telegram?.options?.username
    || ''
  ).replace(/^@/, '').trim() || null;
}

function storefrontPayload(botUsername) {
  const replyMarkup = royalVipHubStorefrontMarkup(botUsername);
  return {
    text: ROYAL_VIP_HUB_STOREFRONT_TEXT,
    replyMarkup
  };
}

function describeHubFailure(error) {
  if (isPermissionDeniedError(error) || isChatNotFoundError(error)) {
    return HUB_PERMISSION_ERROR;
  }
  return telegramErrorText(error).slice(0, 400) || 'Hub sync failed.';
}

export function describeRoyalVipHubStatus(state = {}, env = process.env) {
  const channelId = royalVipHubChannelIdFromEnv(env);
  if (!channelId) {
    return {
      configured: false,
      text: '⚠️ Royal Vip Hub is not configured.'
    };
  }
  const lines = [
    '👑 HUB STATUS',
    'Configured: yes',
    `Storefront message: ${state.storefrontMessageId ? 'known' : 'missing'}`,
    `Last sync: ${state.syncedAt || 'never'}`,
    `Pinned: ${state.pinned ? 'yes' : 'no'}`
  ];
  if (state.lastError) {
    lines.push('', `❌ Hub sync failed:`, state.lastError);
  }
  return {
    configured: true,
    text: lines.join('\n')
  };
}

export async function ensureRoyalVipHubStorefront({
  store,
  bot,
  pin = true,
  env = process.env
} = {}) {
  const channelId = royalVipHubChannelIdFromEnv(env);
  if (!channelId) {
    console.warn(HUB_NOT_CONFIGURED_LOG);
    return { ok: false, reason: 'not_configured', created: false, edited: false };
  }

  const telegram = bot?.telegram;
  if (!telegram) {
    return { ok: false, reason: 'bot_unconfigured', created: false, edited: false };
  }

  let username = resolveBotUsername(bot, env);
  if (!username && typeof telegram.getMe === 'function') {
    try {
      const me = await telegram.getMe();
      username = String(me?.username || '').replace(/^@/, '').trim() || null;
    } catch (error) {
      return { ok: false, reason: 'bot_username_missing', error: telegramErrorText(error), created: false, edited: false };
    }
  }
  const payload = username ? storefrontPayload(username) : null;
  if (!payload?.replyMarkup) {
    return { ok: false, reason: 'bot_username_missing', created: false, edited: false };
  }

  const current = typeof store.getHubStorefrontState === 'function'
    ? await store.getHubStorefrontState()
    : {};
  let messageId = Number(current.storefrontMessageId);
  if (!Number.isInteger(messageId) || messageId <= 0) messageId = null;

  let created = false;
  let edited = false;
  let reused = false;

  if (messageId) {
    try {
      await telegram.editMessageText(channelId, messageId, undefined, payload.text, {
        reply_markup: payload.replyMarkup
      });
      edited = true;
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        reused = true;
      } else if (isMessageNotFoundError(error)) {
        messageId = null;
      } else {
        const lastError = describeHubFailure(error);
        await store.saveHubStorefrontState?.({
          storefrontMessageId: current.storefrontMessageId || null,
          lastError,
          syncedAt: current.syncedAt || null,
          pinned: Boolean(current.pinned)
        }).catch(() => null);
        console.warn('[hub] storefront_sync_failed', lastError);
        return {
          ok: false,
          reason: isPermissionDeniedError(error) ? 'permission_denied' : 'sync_failed',
          error: lastError,
          created: false,
          edited: false,
          messageId: current.storefrontMessageId || null
        };
      }
    }
  }

  if (!messageId) {
    try {
      const sent = await telegram.sendMessage(channelId, payload.text, {
        reply_markup: payload.replyMarkup
      });
      messageId = Number(sent?.message_id);
      created = true;
    } catch (error) {
      const lastError = describeHubFailure(error);
      await store.saveHubStorefrontState?.({
        storefrontMessageId: null,
        lastError,
        syncedAt: null,
        pinned: false
      }).catch(() => null);
      console.warn('[hub] storefront_create_failed', lastError);
      return {
        ok: false,
        reason: isPermissionDeniedError(error) ? 'permission_denied' : 'create_failed',
        error: lastError,
        created: false,
        edited: false
      };
    }
  }

  let pinned = Boolean(current.pinned);
  let pinError = null;
  if (pin && messageId) {
    try {
      await telegram.pinChatMessage(channelId, messageId, { disable_notification: true });
      pinned = true;
    } catch (error) {
      if (isAlreadyPinnedError(error)) {
        pinned = true;
      } else {
        pinError = telegramErrorText(error).slice(0, 400);
        console.warn('[hub] storefront_pin_failed', pinError);
      }
    }
  }

  const syncedAt = new Date().toISOString();
  await store.saveHubStorefrontState?.({
    storefrontMessageId: messageId,
    lastError: null,
    syncedAt,
    pinned
  });

  return {
    ok: true,
    reason: created ? 'created' : (edited ? 'edited' : 'unchanged'),
    created,
    edited,
    reused,
    pinned,
    pinError,
    messageId,
    channelId
  };
}
