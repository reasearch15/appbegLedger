import fs from 'node:fs';
import path from 'node:path';

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
  return async function sendPhoto({ user, text, mediaPath, messageType = 'image' }) {
    const absolutePath = path.resolve(mediaPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Photo file not found: ${absolutePath}`);
    }

    console.log(`[telegram-outbound] bot_api send_photo contact=${user.id} media=${absolutePath}`);
    const telegramResponse = await bot.telegram.sendPhoto(
      user.telegram_id,
      { source: fs.createReadStream(absolutePath) },
      { caption: text }
    );

    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: telegramResponse.message_id,
      text,
      payload: {
        telegramResponse,
        mediaPath: absolutePath,
        channel: 'bot_api'
      },
      senderType: 'bot',
      source: 'bot_api',
      messageType
    });

    return {
      ok: true,
      queued: false,
      source: 'bot_api',
      messageId: telegramResponse.message_id,
      mediaPath: absolutePath
    };
  };
}

export function createAccountReplySender({ store }) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text', mediaPath = null }) {
    const normalizedButtons = normalizeButtonRows(buttons);
    if (normalizedButtons.length) {
      throw new Error(
        'Inline buttons cannot be sent via the Telethon business-account queue. ' +
        'Configure TELEGRAM_BOT_TOKEN so welcome/register buttons go through Bot API.'
      );
    }

    const temporaryTelegramMessageId = -Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
    const resolvedMessageType = mediaPath ? 'image' : messageType;
    const stored = await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: temporaryTelegramMessageId,
      text,
      payload: {
        queued: true,
        buttons: normalizedButtons,
        mediaPath: mediaPath || null,
        sync_kind: 'queued',
        source: 'business_account'
      },
      senderType: 'bot',
      source: 'business_account',
      messageType: resolvedMessageType,
      sentAt: new Date().toISOString()
    });
    const outbound = await store.queueTelegramOutboundMessage({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      body: text,
      buttons: normalizedButtons,
      localMessageId: stored.messageId,
      mediaPath,
      messageType: resolvedMessageType
    });
    await store.db.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ('outbound_queue:nudge', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(outbound.id), new Date().toISOString());
    console.log(
      `[telegram-outbound] queued id=${outbound.id} contact=${user.id} telegram=${user.telegram_id} ` +
      `buttons=0 media=${mediaPath ? 'yes' : 'no'}`
    );
    return {
      ok: true,
      queued: true,
      source: 'business_account',
      outboundId: outbound.id,
      buttons: normalizedButtons,
      mediaPath: mediaPath || null
    };
  };
}

/**
 * Inline-button messages MUST use Bot API.
 * Text-only replies may still use the business-account outbound queue.
 */
export async function createReplySender({ store, user, rootDir, bot }) {
  const preferredSource = await store.getContactPreferredMessageSource(user.id);
  const accountEnabled = process.env.TELEGRAM_ACCOUNT_SYNC_ENABLED === 'true';

  return async function sendReply(options = {}) {
    const normalizedButtons = normalizeButtonRows(options.buttons);
    const hasButtons = normalizedButtons.length > 0;
    const hasMedia = Boolean(options.mediaPath);

    if (hasMedia) {
      if (bot) {
        return createBotPhotoSender(bot, store)(options);
      }
      if (preferredSource === 'business_account' && accountEnabled) {
        return createAccountReplySender({ store })(options);
      }
      if (accountEnabled) {
        return createAccountReplySender({ store })(options);
      }
      throw new Error('No Telegram photo channel is available for this contact.');
    }

    if (hasButtons) {
      if (!bot) {
        throw new Error(
          'Cannot send welcome/register inline buttons: TELEGRAM_BOT_TOKEN bot is not running. ' +
          'User/business Telethon sessions cannot render Button.inline callback keyboards.'
        );
      }
      console.log(`[telegram-outbound] routing button message via bot_api contact=${user.id}`);
      return createBotReplySender(bot, store)({ ...options, buttons: normalizedButtons });
    }

    if (preferredSource === 'business_account' && accountEnabled) {
      return createAccountReplySender({ store })(options);
    }
    if (bot) {
      return createBotReplySender(bot, store)(options);
    }
    if (accountEnabled) {
      return createAccountReplySender({ store })(options);
    }
    throw new Error('No Telegram reply channel is available for this contact.');
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
