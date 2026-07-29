import { Telegraf } from 'telegraf';
import {
  SUPPORT_SUBSCRIBED_TEXT,
  SUPPORT_UNSUBSCRIBED_TEXT,
  SUPPORT_CLAIM_PREFIX,
  SUPPORT_DONE_PREFIX,
  buildSupportRequestMessage,
  buildSupportRequestReplyMarkup,
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

  bot.on('callback_query', async (ctx) => {
    await handleSupportCallback(ctx, store, bot);
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

export async function handleSupportCallback(ctx, store, bot) {
  const action = String(ctx.callbackQuery?.data || '').trim();
  const fromId = ctx.from?.id == null ? null : String(ctx.from.id);
  const requestId = parseSupportRequestCallback(action);
  if (!requestId) {
    await answerCallback(ctx, 'Unknown action.');
    return;
  }

  const subscriber = typeof store.getActiveSupportNotificationSubscriberByTelegramUserId === 'function'
    ? await store.getActiveSupportNotificationSubscriberByTelegramUserId(fromId)
    : null;
  if (!subscriber) {
    await answerCallback(ctx, 'Subscribe with /start first.');
    return;
  }

  const displayName = safeTelegramDisplayName(ctx.from);

  if (action.startsWith(SUPPORT_CLAIM_PREFIX)) {
    await handleClaimCallback(ctx, store, bot, requestId, { fromId, displayName });
    return;
  }

  if (action.startsWith(SUPPORT_DONE_PREFIX)) {
    await handleDoneCallback(ctx, store, bot, requestId, { fromId, displayName });
  }
}

async function handleClaimCallback(ctx, store, bot, requestId, staff) {
  const result = await store.claimSupportRequest(requestId, {
    telegramUserId: staff.fromId,
    displayName: staff.displayName
  });

  if (result.ok) {
    await answerCallback(ctx, 'Claimed.');
    await editDeliveredSupportRequestCopies({ store, bot, request: result.request });
    return;
  }

  const request = result.request || await store.getSupportRequest?.(requestId);
  if (request?.status === 'completed') {
    await answerCallback(ctx, 'This job is already completed.');
    return;
  }
  await answerCallback(ctx, `Already claimed by ${request?.claimed_by_name || 'another staff member'}.`);
}

async function handleDoneCallback(ctx, store, bot, requestId, staff) {
  const request = await store.getSupportRequest?.(requestId);
  if (!request) {
    await answerCallback(ctx, 'This job is no longer available.');
    return;
  }
  if (request.status === 'completed') {
    await answerCallback(ctx, 'This job is already completed.');
    return;
  }
  if (request.status === 'pending') {
    await answerCallback(ctx, 'Claim this job first.');
    return;
  }
  if (String(request.claimed_by_telegram_user_id || '') !== String(staff.fromId)) {
    await answerCallback(ctx, `Only ${request.claimed_by_name || 'the claimant'} can complete this job.`);
    return;
  }

  const result = await store.completeSupportRequest(requestId, {
    telegramUserId: staff.fromId,
    displayName: staff.displayName
  });

  if (result.ok) {
    await answerCallback(ctx, 'Completed.');
    await editDeliveredSupportRequestCopies({ store, bot, request: result.request });
    return;
  }

  const latest = result.request || await store.getSupportRequest?.(requestId);
  if (latest?.status === 'completed') {
    await answerCallback(ctx, 'This job is already completed.');
    return;
  }
  if (latest?.status === 'pending') {
    await answerCallback(ctx, 'Claim this job first.');
    return;
  }
  await answerCallback(ctx, `Only ${latest?.claimed_by_name || 'the claimant'} can complete this job.`);
}

export async function editDeliveredSupportRequestCopies({ store, bot, request }) {
  if (!request?.id || typeof store.listSupportRequestDeliveries !== 'function') return;
  const deliveries = await store.listSupportRequestDeliveries(request.id);
  const text = buildSupportRequestMessage(request);
  const replyMarkup = buildSupportRequestReplyMarkup(request);
  for (const delivery of deliveries) {
    const chatId = String(delivery.telegram_chat_id || '').trim();
    const messageId = Number(delivery.telegram_message_id || 0);
    if (!chatId || !messageId) continue;
    try {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      if (typeof store.markSupportRequestDeliveryEdit === 'function') {
        await store.markSupportRequestDeliveryEdit(request.id, chatId, { status: 'edited' }).catch(() => null);
      }
    } catch (error) {
      console.error('[support-notification-bot] message_edit_failed', {
        request_id: request.id,
        telegram_chat_id: chatId,
        telegram_message_id: messageId,
        error_code: error?.code || error?.response?.error_code || error?.message || 'edit_failed'
      });
      if (typeof store.markSupportRequestDeliveryEdit === 'function') {
        await store.markSupportRequestDeliveryEdit(request.id, chatId, {
          status: 'edit_failed',
          error: error?.description || error?.message || 'edit_failed'
        }).catch(() => null);
      }
    }
  }
}

function parseSupportRequestCallback(action) {
  const prefix = action.startsWith(SUPPORT_CLAIM_PREFIX)
    ? SUPPORT_CLAIM_PREFIX
    : action.startsWith(SUPPORT_DONE_PREFIX)
      ? SUPPORT_DONE_PREFIX
      : null;
  if (!prefix) return null;
  const id = Number(action.slice(prefix.length));
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function answerCallback(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.error('[support-notification-bot] callback_answer_failed', {
      error_code: error?.code || error?.message || 'answer_failed'
    });
  }
}

function safeTelegramDisplayName(from = {}) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    || (from.username ? `@${from.username}` : '')
    || (from.id == null ? '' : `Staff ${from.id}`);
  return String(name).replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 80) || 'Staff';
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
