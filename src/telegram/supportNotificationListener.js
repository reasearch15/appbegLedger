import { Telegraf } from 'telegraf';
import {
  SUPPORT_SUBSCRIBED_TEXT,
  SUPPORT_UNSUBSCRIBED_TEXT,
  getSupportNotificationConfig
} from './supportNotificationBot.js';

/**
 * Support Notification Bot listener.
 * Anyone who /start this bot becomes an active notification subscriber.
 */
export function startSupportNotificationListener({ token, store, env = process.env } = {}) {
  const config = token
    ? { token: String(token).trim() || null, configured: Boolean(String(token || '').trim()) }
    : getSupportNotificationConfig(env);

  if (!config.configured || !config.token) {
    console.warn('SUPPORT_NOTIFICATION_BOT_TOKEN is not set. Support notification bot is disabled.');
    return null;
  }

  if (!store || typeof store.upsertSupportNotificationSubscriber !== 'function') {
    console.warn('Support notification subscriber store is unavailable. Support notification bot is disabled.');
    return null;
  }

  const bot = new Telegraf(config.token);

  bot.start(async (ctx) => {
    await handleSubscribe(ctx, store);
  });

  bot.command('stop', async (ctx) => {
    await handleUnsubscribe(ctx, store);
  });

  bot.catch((error) => {
    console.error('[support-notification-bot] update_failed', {
      stack: error?.stack || String(error)
    });
  });

  launchSupportBot(bot).catch((error) => {
    console.error('Support notification bot failed to start:', error);
  });

  return bot;
}

async function handleSubscribe(ctx, store) {
  if (ctx.chat?.type !== 'private') return;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id ?? null;
  if (chatId == null) return;

  try {
    const result = await store.upsertSupportNotificationSubscriber({
      telegramChatId: chatId,
      telegramUserId: userId
    });
    if (result?.reactivated) {
      console.log('[chatbot] support_subscriber_reactivated', {
        telegram_chat_id: String(chatId),
        subscriber_created: false
      });
    } else if (result?.created) {
      console.log('[chatbot] support_subscriber_registered', {
        telegram_chat_id: String(chatId),
        subscriber_created: true
      });
    } else {
      console.log('[chatbot] support_subscriber_registered', {
        telegram_chat_id: String(chatId),
        subscriber_created: false,
        already_active: true
      });
    }
    await ctx.reply(SUPPORT_SUBSCRIBED_TEXT);
  } catch (error) {
    console.error('[support-notification-bot] subscribe_failed', {
      telegram_chat_id: String(chatId),
      stack: error?.stack || String(error)
    });
  }
}

async function handleUnsubscribe(ctx, store) {
  if (ctx.chat?.type !== 'private') return;
  const chatId = ctx.chat?.id;
  if (chatId == null) return;

  try {
    await store.deactivateSupportNotificationSubscriber(chatId, { reason: 'user_stop' });
    console.log('[chatbot] support_subscriber_disabled', {
      telegram_chat_id: String(chatId),
      reason: 'user_stop'
    });
    await ctx.reply(SUPPORT_UNSUBSCRIBED_TEXT);
  } catch (error) {
    console.error('[support-notification-bot] unsubscribe_failed', {
      telegram_chat_id: String(chatId),
      stack: error?.stack || String(error)
    });
  }
}

async function launchSupportBot(bot) {
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    if (webhookInfo?.url) {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      console.log('[support-notification-bot] webhook deleted before polling start.');
    }
    await bot.launch();
    console.log('Support notification bot listener started.');
  } catch (error) {
    console.error('Support notification bot listener failed to start:', error);
  }
}
