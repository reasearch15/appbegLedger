import { Telegraf } from 'telegraf';
import { PROFILE_PHOTOS_ENABLED } from '../config/profilePhotos.js';
import { enqueueChatbotJob } from './chatbotProcessor.js';
import { tryEnqueueRegistrationBotJob } from './autoRegistrationBot.js';
import { ensureBotApiPrivateContact } from './botPrivateEntry.js';
import { EXPIRED_CALLBACK_MESSAGE, validateCallbackFreshness } from './callbackSafety.js';
import { handleStaffCallbackQuery, handleStaffGroupMessage } from './staffGroupHandler.js';
import { mirrorPlayerMessageToStaffTopic } from './staffOperations.js';
import { isStaffGroupChat } from './operationalRoles.js';
import { isStaffCallback } from './staffCards.js';
import { ensureRoyalVipHubStorefront } from './royalVipHubManager.js';
import { ensureStaffControlCenter } from './staffControlCenter.js';
import { handleRoyalVipHubDirectMessage } from './hubDirectMessages.js';
import {
  extractSupportedInboundMedia,
  shouldMirrorPlayerInboundToStaff,
  unsupportedInboundMediaLabel
} from './playerSupportMessaging.js';

const CHATBOT_ENABLED = process.env.CHATBOT_ENABLED !== 'false';

export function startTelegramListener({ token, store, io }) {
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram listener is disabled.');
    return null;
  }

  const bot = new Telegraf(token);

  bot.on('callback_query', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) {
      if (isStaffGroupChat(ctx.chat?.id)) {
        await handleStaffCallbackQuery({ ctx, store, bot });
      }
      return;
    }

    if (isStaffCallback(ctx.callbackQuery?.data)) {
      const handled = await handleStaffCallbackQuery({ ctx, store, bot });
      if (handled) return;
    }

    try {
      logTelegramUpdate('callback_received', ctx, {
        action: ctx.callbackQuery?.data || null
      });
      const user = await ensureBotApiPrivateContact(store, ctx.from);
      const action = ctx.callbackQuery.data;
      const fresh = await store.getUserProfile(user.id);
      const callbackMessageId = ctx.callbackQuery.message?.message_id || null;
      const freshness = await validateCallbackFreshness({
        store,
        user: fresh || user,
        action,
        callbackMessageId,
        callbackMessageDate: ctx.callbackQuery.message?.date || null
      });
      if (!freshness.ok) {
        await ctx.answerCbQuery(EXPIRED_CALLBACK_MESSAGE);
        console.log(
          `[chatbot] callback_expired contact=${user.id} action=${action || 'n/a'} ` +
          `pressed_message_id=${freshness.pressedMessageId || 'n/a'} active_message_id=${freshness.activeMessageId || 'n/a'} ` +
          `callback_age_seconds=${freshness.callbackAgeSeconds ?? 'n/a'} rejected=true`
        );
        const recoveryResult = await tryEnqueueRegistrationBotJob(store, enqueueChatbotJob, {
          CHATBOT_ENABLED,
          contact: fresh || user,
          sentAt: ctx.callbackQuery.message?.date
            ? new Date(ctx.callbackQuery.message.date * 1000).toISOString()
            : null,
          enqueueParams: {
            contactId: user.id,
            telegramUserId: user.telegram_id,
            updateId: ctx.update?.update_id,
            incomingTelegramMessageId: callbackMessageId,
            jobType: 'inbound_message',
            inputText: '',
            action: null,
            force_entry_menu: true
          }
        });
        if (recoveryResult.enqueued) {
          io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
          io.emit('contacts:changed');
        }
        return;
      }
      await ctx.answerCbQuery();
      console.log(
        `[chatbot] callback_freshness contact=${user.id} action=${action || 'n/a'} ` +
        `message_id=${callbackMessageId || 'n/a'} callback_age_seconds=${freshness.callbackAgeSeconds ?? 'n/a'} ` +
        `rejected=false persistent=${Boolean(freshness.persistentNavigation)} active_deposit_cancel=${Boolean(freshness.activeDepositCancel)}`
      );

      const enqueueResult = await tryEnqueueRegistrationBotJob(store, enqueueChatbotJob, {
        CHATBOT_ENABLED,
        contact: fresh,
        sentAt: ctx.callbackQuery.message?.date
          ? new Date(ctx.callbackQuery.message.date * 1000).toISOString()
          : null,
        requireChatbotAction: true,
        enqueueParams: {
          contactId: user.id,
          telegramUserId: user.telegram_id,
          updateId: ctx.update?.update_id,
          incomingTelegramMessageId: callbackMessageId,
          jobType: 'callback_action',
          inputText: '',
          action,
          force_entry_menu: false
        }
      });
      if (enqueueResult.enqueued) {
        io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
        io.emit('contacts:changed');
        return;
      }

      const autoBot = await store.getAutoRegistrationBotSettings();
      if (!autoBot.enabled) {
        return;
      }

      console.log(`[chatbot] callback_auto_send_suppressed contact=${user.id} ai_mode=${fresh?.ai_mode || 'train'}`);
    } catch (error) {
      console.error('[telegram] callback_update_failed', {
        update_id: ctx.update?.update_id ?? null,
        message_id: ctx.callbackQuery?.message?.message_id ?? null,
        user_id: ctx.from?.id ?? null,
        chat_id: ctx.chat?.id ?? null,
        stack: error?.stack || String(error)
      });
    }
  });

  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.message?.from) {
      const hubDm = await handleRoyalVipHubDirectMessage({ ctx, store, bot, io }).catch((error) => {
        console.warn('[hub-dm] inbound_failed', error.message);
        return { handled: false };
      });
      if (hubDm?.handled) return;
      if (isStaffGroupChat(ctx.chat?.id)) {
        await handleStaffGroupMessage({ ctx, store, bot });
      }
      return;
    }

    try {
      logTelegramUpdate('message_received', ctx, {
        text_length: String(ctx.message.text || ctx.message.caption || '').trim().length
      });
      const result = await store.storeIncomingTelegramMessage(ctx);
      const inputText = ctx.message.text || ctx.message.caption || '';
      const media = extractSupportedInboundMedia(ctx.message);
      const unsupportedMedia = unsupportedInboundMediaLabel(ctx.message);
      if (result.inserted) {
        const automationState = await store.getAutomationState(result.user.id).catch(() => null);
        const botSession = await store.getBotSession(result.user.id).catch(() => null);
        if (shouldMirrorPlayerInboundToStaff({
          text: inputText,
          automationState,
          botSession,
          hasSupportedMedia: Boolean(media),
          hasUnsupportedMedia: Boolean(unsupportedMedia)
        })) {
          const nativeTopic = await store.getChannelDmTopicForContact?.(result.user.id).catch(() => null);
          if (nativeTopic) {
            console.log('[staff-topic] skipped_native_hub_dm', result.user.id);
          } else {
            await mirrorPlayerMessageToStaffTopic({
              store,
              bot,
              contact: result.user,
              text: inputText,
              message: ctx.message
            }).catch((error) => {
              console.warn('[staff-topic] mirror_failed', error.message);
            });
          }
        }
      }
      console.log(`[chatbot] inbound message saved contact=${result.user.id} inserted=${result.inserted} telegram_message_id=${ctx.message.message_id} first=${Boolean(result.firstMessage)}`);
      await store.ensureBotSession(result.user.id);
      await store.ensureAutomationState(result.user.id);
      if (result.inserted) {
        io.emit('message:new', {
          userId: result.user.id,
          contactId: result.user.id,
          telegramId: result.user.telegram_id
        });
      }
      io.emit('contacts:changed');
      io.emit('users:changed');
      if (PROFILE_PHOTOS_ENABLED) {
        cacheProfilePhoto({ bot, store, user: result.user, io });
      }

      const fresh = await store.getUserProfile(result.user.id);
      const messageSentAt = ctx.message?.date
        ? new Date(ctx.message.date * 1000).toISOString()
        : null;
      const sess = await store.getBotSession(result.user.id).catch(() => null);
      const auto = await store.getAutomationState(result.user.id).catch(() => null);
      console.log(
        `[chatbot] telegram_inbound contact=${result.user.id} telegram_id=${result.user.telegram_id} ` +
        `text=${JSON.stringify(safeTelegramInboundText(inputText, auto))} ` +
        `bot_session=${sess?.workflow_key || 'none'}/${sess?.workflow_step || 'none'} ` +
        `automation_flow=${auto?.current_flow || 'none'} automation_step=${auto?.current_step || 'none'} ` +
        `deposit_in_progress=${Boolean(auto?.registration_info?.deposit_in_progress)}`
      );
      const enqueueResult = await tryEnqueueRegistrationBotJob(store, enqueueChatbotJob, {
        CHATBOT_ENABLED,
        contact: fresh,
        sentAt: messageSentAt,
        enqueueParams: {
          contactId: result.user.id,
          telegramUserId: result.user.telegram_id,
          updateId: ctx.update?.update_id,
          messageId: await store.findLatestIncomingMessageId(result.user.id, ctx.message.message_id),
          incomingTelegramMessageId: ctx.message.message_id,
          jobType: 'inbound_message',
          inputText,
          force_entry_menu: Boolean(result.firstMessage) || !String(inputText).trim()
        }
      });
      if (enqueueResult.enqueued) {
        return;
      }

      // Staff override / handoff: do not auto-reply while bot is paused.
      if (fresh?.bot_paused) {
        return;
      }

      const autoBot = await store.getAutoRegistrationBotSettings();
      if (!autoBot.enabled) {
        console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${result.user.id}`);
        return;
      }

      console.log(`[chatbot] direct_auto_send_suppressed contact=${result.user.id} ai_mode=${fresh?.ai_mode || 'train'}`);
    } catch (error) {
      console.error('[telegram] message_update_failed', {
        update_id: ctx.update?.update_id ?? null,
        message_id: ctx.message?.message_id ?? null,
        user_id: ctx.message?.from?.id ?? null,
        chat_id: ctx.chat?.id ?? null,
        stack: error?.stack || String(error)
      });
    }
  });

  startPollingBot(bot, store);

  const stop = (signal) => {
    console.log(`Stopping Telegram listener after ${signal}.`);
    bot.stop(signal);
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  return bot;
}

function logTelegramUpdate(event, ctx, extra = {}) {
  console.log('[telegram-update]', JSON.stringify({
    event,
    update_id: ctx.update?.update_id ?? null,
    message_id: ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id ?? null,
    telegram_user_id: ctx.from?.id ?? ctx.message?.from?.id ?? null,
    chat_id: ctx.chat?.id ?? null,
    chat_type: ctx.chat?.type || null,
    ...extra
  }));
}

function safeTelegramInboundText(value = '', automationState = null) {
  const step = String(automationState?.current_step || automationState?.currentStep || '').toLowerCase();
  if (step.includes('password')) return '[redacted]';
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

export async function startPollingBot(bot, store) {
  try {
    const me = await bot.telegram.getMe();
    console.log(`[telegram] getMe ok id=${me.id} username=@${me.username || 'unknown'}`);

    const webhookInfo = await bot.telegram.getWebhookInfo();
    const webhookConfigured = Boolean(webhookInfo?.url);
    console.log(
      `[telegram] webhook configured=${webhookConfigured} pending_updates=${webhookInfo?.pending_update_count ?? 0}` +
      `${webhookInfo?.last_error_message ? ` last_error=${webhookInfo.last_error_message}` : ''}`
    );

    if (webhookConfigured) {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      console.log('[telegram] webhook deleted before polling start.');
    }

    // Telegraf 4.16 launch() awaits polling.loop(), which does not resolve until
    // bot.stop(). Hub/Control Center ensure must run without waiting for that.
    let launchPromise;
    try {
      launchPromise = bot.launch();
    } catch (error) {
      console.error('Telegram listener failed to start:', error);
      return;
    }
    Promise.resolve(launchPromise).catch((error) => {
      console.error('Telegram listener failed to start:', error);
    });
    bot.botInfo = bot.botInfo || me;
    console.log('Telegram listener started.');
    try {
      const hub = await ensureRoyalVipHubStorefront({ store, bot });
      if (hub?.reason === 'not_configured') {
        // Logged inside the manager. Player bot and CRM continue.
      } else if (hub && !hub.ok) {
        console.warn('[hub] startup_sync_failed', hub.error || hub.reason);
      }
    } catch (error) {
      console.warn('[hub] startup_sync_failed', error.message);
    }
    try {
      const control = await ensureStaffControlCenter({ store, bot });
      if (control && !control.ok && control.reason !== 'staff_group_unconfigured') {
        console.warn('[control-center] startup_ensure_failed', control.error || control.reason);
      }
    } catch (error) {
      console.warn('[control-center] startup_ensure_failed', error.message);
    }
  } catch (error) {
    console.error('Telegram listener failed to start:', error);
  }
}

async function cacheProfilePhoto({ bot, store, user, io }) {
  if (!PROFILE_PHOTOS_ENABLED) return;

  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  try {
    const photos = await bot.telegram.getUserProfilePhotos(user.telegram_id, 0, 1);
    const photo = photos.photos?.[0]?.at(-1);
    if (!photo || photo.file_id === user.profile_photo_file_id) return;

    const fileLink = await bot.telegram.getFileLink(photo.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) return;

    const mediaRoot = path.resolve('data', 'media', 'profile-photos');
    await fs.mkdir(mediaRoot, { recursive: true });
    const fileName = `${user.telegram_id}.jpg`;
    const filePath = path.join(mediaRoot, fileName);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    await store.updateProfilePhoto(user.id, {
      fileId: photo.file_id,
      url: `/media/profile-photos/${fileName}`
    });
    io.emit('users:changed');
    io.emit('user:changed', { userId: user.id });
  } catch (error) {
    console.warn('Profile photo cache skipped:', error.message);
  }
}
