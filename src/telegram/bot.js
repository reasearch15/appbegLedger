import { Telegraf } from 'telegraf';
import { PROFILE_PHOTOS_ENABLED } from '../config/profilePhotos.js';
import { enqueueChatbotJob } from './chatbotProcessor.js';
import { tryEnqueueRegistrationBotJob } from './autoRegistrationBot.js';
import { ensureBotApiPrivateContact } from './botPrivateEntry.js';

const CHATBOT_ENABLED = process.env.CHATBOT_ENABLED !== 'false';

export function startTelegramListener({ token, store, io }) {
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram listener is disabled.');
    return null;
  }

  const bot = new Telegraf(token);

  bot.on('callback_query', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) return;

    try {
      const user = await ensureBotApiPrivateContact(store, ctx.from);
      await ctx.answerCbQuery();

      const action = ctx.callbackQuery.data;
      const fresh = await store.getUserProfile(user.id);
      const callbackMessageId = ctx.callbackQuery.message?.message_id || null;
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
      console.error('Failed to handle Telegram menu action:', error);
    }
  });

  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.message?.from) return;

    try {
      const result = await store.storeIncomingTelegramMessage(ctx);
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
      const inputText = ctx.message.text || ctx.message.caption || '';
      const enqueueResult = await tryEnqueueRegistrationBotJob(store, enqueueChatbotJob, {
        CHATBOT_ENABLED,
        contact: fresh,
        sentAt: messageSentAt,
        enqueueParams: {
          contactId: result.user.id,
          telegramUserId: result.user.telegram_id,
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
      if (fresh?.bot_paused || fresh?.needs_staff_review) {
        return;
      }

      const autoBot = await store.getAutoRegistrationBotSettings();
      if (!autoBot.enabled) {
        console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${result.user.id}`);
        return;
      }

      console.log(`[chatbot] direct_auto_send_suppressed contact=${result.user.id} ai_mode=${fresh?.ai_mode || 'train'}`);
    } catch (error) {
      console.error('Failed to store Telegram message:', error);
    }
  });

  bot.launch()
    .then(() => console.log('Telegram listener started.'))
    .catch((error) => console.error('Telegram listener failed to start:', error));

  const stop = (signal) => {
    console.log(`Stopping Telegram listener after ${signal}.`);
    bot.stop(signal);
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  return bot;
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
