import { Telegraf } from 'telegraf';
import { PROFILE_PHOTOS_ENABLED } from '../config/profilePhotos.js';
import { handleMenuAction, initialScreenForUser, renderMenu } from './menuEngine.js';
import { processAutomationActionForContact, processAutomationForContact } from './processAutomation.js';
import { enqueueChatbotJob } from './chatbotProcessor.js';
import { isBotActiveForContact, isChatbotButtonAction } from './chatbotEngine.js';

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
      const user = await store.upsertTelegramUser(ctx.from);
      await store.ensureConversation(user.id);
      await ctx.answerCbQuery();

      const action = ctx.callbackQuery.data;
      const fresh = await store.getUserProfile(user.id);
      if (CHATBOT_ENABLED && isBotActiveForContact(fresh) && isChatbotButtonAction(action)) {
        await enqueueChatbotJob(store, {
          contactId: user.id,
          telegramUserId: user.telegram_id,
          jobType: 'callback_action',
          inputText: '',
          action
        });
        io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
        io.emit('contacts:changed');
        return;
      }

      const automationResult = await processAutomationActionForContact({
        action,
        store,
        user,
        bot,
        io
      });
      if (!automationResult?.handled) {
        await handleMenuAction({
          action,
          bot,
          store,
          user
        });
      }
      io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
      io.emit('contacts:changed');
      io.emit('users:changed');
    } catch (error) {
      console.error('Failed to handle Telegram menu action:', error);
    }
  });

  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.message?.from) return;

    try {
      const result = await store.storeIncomingTelegramMessage(ctx);
      console.log(`[chatbot] inbound message saved contact=${result.user.id} inserted=${result.inserted} telegram_message_id=${ctx.message.message_id}`);
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
      if (CHATBOT_ENABLED && result.inserted && isBotActiveForContact(fresh)) {
        const messageId = await store.findLatestIncomingMessageId(result.user.id, ctx.message.message_id);
        await enqueueChatbotJob(store, {
          contactId: result.user.id,
          telegramUserId: result.user.telegram_id,
          messageId,
          incomingTelegramMessageId: ctx.message.message_id,
          jobType: 'inbound_message',
          inputText: ctx.message.text || ctx.message.caption || ''
        });
        return;
      }

      // Staff override / handoff: do not auto-reply while bot is paused.
      if (fresh?.bot_paused || fresh?.needs_staff_review) {
        return;
      }

      const automationResult = await processAutomationForContact({
        store,
        user: result.user,
        message: ctx.message,
        inserted: result.inserted,
        bot,
        io
      });

      if (automationResult?.handled) {
        return;
      }

      if (ctx.message.text === '/start' || result.firstMessage) {
        const session = await store.setBotScreen(result.user.id, initialScreenForUser(result.user), {
          actorName: 'Bot',
          pushCurrent: false
        });
        await renderMenu({
          bot,
          store,
          user: result.user,
          screenName: session.current_screen,
          registered: result.user.registration_status === 'Registered'
        });
        io.emit('message:new', {
          userId: result.user.id,
          contactId: result.user.id,
          telegramId: result.user.telegram_id
        });
        io.emit('contacts:changed');
        io.emit('users:changed');
      }
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
