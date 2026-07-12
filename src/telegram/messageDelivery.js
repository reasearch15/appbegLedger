import fs from 'node:fs';
import { resolvePaymentQrTelegramInput } from '../payments/methodUtils.js';

export function createBotReplySender(bot, store) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text' }) {
    const normalizedButtons = normalizeButtonRows(buttons);
    const replyMarkup = normalizedButtons.length
      ? {
        inline_keyboard: normalizedButtons.map((row) => row.map((button) => ({
          text: button.text,
          callback_data: button.data
        })))
      }
      : undefined;

    console.log(`[telegram-outbound] bot_api send contact=${user.id} buttons=${JSON.stringify(normalizedButtons)}`);
    if (replyMarkup) {
      console.log(`[telegram-outbound] bot_api reply_markup=${JSON.stringify(replyMarkup)}`);
    }

    const telegramResponse = await bot.telegram.sendMessage(
      user.telegram_id,
      text,
      replyMarkup ? { reply_markup: replyMarkup } : undefined
    );

    const returnedMarkup = telegramResponse?.reply_markup || telegramResponse?.replyMarkup || null;
    console.log(
      `[telegram-outbound] bot_api returned message_id=${telegramResponse.message_id} ` +
      `reply_markup=${JSON.stringify(returnedMarkup)}`
    );
    if (normalizedButtons.length && !returnedMarkup) {
      throw new Error(
        'Bot API send returned no reply_markup. Inline buttons were not accepted for this chat.'
      );
    }

    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: telegramResponse.message_id,
      text,
      payload: {
        telegramResponse,
        buttons: normalizedButtons,
        reply_markup: returnedMarkup,
        channel: 'bot_api'
      },
      senderType: 'bot',
      source: 'bot_api',
      messageType: normalizedButtons.length ? 'buttons' : messageType
    });
    if (normalizedButtons.length) {
      console.log(`[telegram-outbound] welcome_buttons_sent contact=${user.id} channel=bot_api buttons=${countButtons(normalizedButtons)}`);
    }
    return {
      ok: true,
      queued: false,
      source: 'bot_api',
      messageId: telegramResponse.message_id,
      buttons: normalizedButtons,
      replyMarkup: returnedMarkup
    };
  };
}

export function createBotPhotoSender(bot, store) {
  return async function sendPhoto({ user, text, mediaPath, mediaBuffer = null, mediaFilename = 'qr.png', buttons = [], messageType = 'image' }) {
    const normalizedButtons = normalizeButtonRows(buttons);
    const replyMarkup = normalizedButtons.length
      ? {
        inline_keyboard: normalizedButtons.map((row) => row.map((button) => ({
          text: button.text,
          callback_data: button.data
        })))
      }
      : undefined;

    let photoInput;
    let resolvedPath = null;

    if (mediaBuffer) {
      photoInput = {
        source: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
        filename: mediaFilename
      };
    } else {
      const resolved = resolvePaymentQrTelegramInput(mediaPath);
      if (!resolved.ok) {
        throw new Error(`Photo file not found: ${resolved.absolutePath || mediaPath || resolved.reason}`);
      }
      if (resolved.type === 'url') {
        photoInput = resolved.mediaPath;
        resolvedPath = resolved.mediaPath;
      } else {
        resolvedPath = resolved.absolutePath;
        photoInput = { source: fs.createReadStream(resolved.absolutePath) };
      }
    }

    console.log(`[telegram-outbound] bot_api send_photo contact=${user.id} media=${resolvedPath || mediaPath || mediaFilename} buttons=${normalizedButtons.length}`);
    const telegramResponse = await bot.telegram.sendPhoto(
      user.telegram_id,
      photoInput,
      {
        caption: text || undefined,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }
    );

    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: telegramResponse.message_id,
      text,
      payload: {
        telegramResponse,
        mediaPath: resolvedPath || mediaPath || null,
        buttons: normalizedButtons,
        channel: 'bot_api'
      },
      senderType: 'bot',
      source: 'bot_api',
      messageType: normalizedButtons.length ? 'buttons' : messageType
    });

    return {
      ok: true,
      queued: false,
      source: 'bot_api',
      messageId: telegramResponse.message_id,
      mediaPath: resolvedPath || mediaPath || null,
      buttons: normalizedButtons
    };
  };
}

export function createAccountReplySender({ store }) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text', mediaPath = null }) {
    throw new Error('Personal Telegram account delivery is disabled. Staff and automation replies must use the official Bot API.');
  };
}

/**
 * Inline-button messages MUST use Bot API.
 * Text-only replies may still use the business-account outbound queue.
 */
export async function createReplySender({ store, user, rootDir, bot }) {
  const preferredSource = await store.getContactPreferredMessageSource(user.id);

  return async function sendReply(options = {}) {
    const normalizedButtons = normalizeButtonRows(options.buttons);
    const hasButtons = normalizedButtons.length > 0;
    const hasMedia = Boolean(options.mediaPath || options.mediaBuffer);

    if (preferredSource !== 'bot_api') {
      throw new Error('This contact is not available through the official Bot API.');
    }

    if (!bot) {
      throw new Error('TELEGRAM_BOT_TOKEN bot is required for contact delivery.');
    }

    if (hasMedia) {
      return createBotPhotoSender(bot, store)({
        ...options,
        buttons: normalizedButtons
      });
    }

    if (hasButtons) {
      console.log(`[telegram-outbound] routing button message via bot_api contact=${user.id}`);
      return createBotReplySender(bot, store)({ ...options, buttons: normalizedButtons });
    }

    return createBotReplySender(bot, store)(options);
  };
}

export function normalizeButtonRows(buttons = []) {
  if (!Array.isArray(buttons) || !buttons.length) return [];
  return buttons
    .map((row) => {
      const items = Array.isArray(row) ? row : [row];
      return items
        .map((button) => {
          if (!button || typeof button !== 'object') return null;
          const text = String(button.text || button.label || '').trim();
          const data = String(button.data || button.action || button.callback_data || '').trim();
          if (!text || !data) return null;
          const encoded = Buffer.from(data, 'utf8');
          if (encoded.length > 64) {
            console.warn(`[telegram-outbound] callback_data too long (${encoded.length} bytes): ${data}`);
            return null;
          }
          return { text, data };
        })
        .filter(Boolean);
    })
    .filter((row) => row.length);
}

function countButtons(rows) {
  return rows.reduce((sum, row) => sum + row.length, 0);
}
