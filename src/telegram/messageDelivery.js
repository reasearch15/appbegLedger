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
    const telegramResponse = await bot.telegram.sendMessage(
      user.telegram_id,
      text,
      replyMarkup ? { reply_markup: replyMarkup } : undefined
    );
    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: telegramResponse.message_id,
      text,
      payload: { telegramResponse, buttons: normalizedButtons },
      senderType: 'bot',
      messageType: normalizedButtons.length ? 'buttons' : messageType
    });
    if (normalizedButtons.length) {
      console.log(`[telegram-outbound] welcome_buttons_sent contact=${user.id} channel=bot_api buttons=${countButtons(normalizedButtons)}`);
    }
    return telegramResponse;
  };
}

export function createAccountReplySender({ store }) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text' }) {
    const normalizedButtons = normalizeButtonRows(buttons);
    const temporaryTelegramMessageId = -Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
    const stored = await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: temporaryTelegramMessageId,
      text,
      payload: {
        queued: true,
        buttons: normalizedButtons,
        sync_kind: 'queued',
        source: 'business_account'
      },
      senderType: 'bot',
      source: 'business_account',
      messageType: normalizedButtons.length ? 'buttons' : messageType,
      sentAt: new Date().toISOString()
    });
    const outbound = await store.queueTelegramOutboundMessage({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      body: text,
      buttons: normalizedButtons,
      localMessageId: stored.messageId
    });
    await store.db.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ('outbound_queue:nudge', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(outbound.id), new Date().toISOString());
    console.log(`[telegram-outbound] queued id=${outbound.id} contact=${user.id} telegram=${user.telegram_id} buttons=${countButtons(normalizedButtons)}`);
    if (normalizedButtons.length) {
      console.log(`[telegram-outbound] welcome_buttons_queued id=${outbound.id} contact=${user.id} buttons=${countButtons(normalizedButtons)}`);
    }
    return {
      ok: true,
      queued: true,
      source: 'business_account',
      outboundId: outbound.id,
      buttons: normalizedButtons
    };
  };
}

/**
 * Prefer Bot API whenever inline buttons are present.
 * Telegram user/business accounts often cannot display Bot-style inline
 * callback buttons, so those messages would arrive as text-only.
 */
export async function createReplySender({ store, user, rootDir, bot, preferButtonsViaBot = true }) {
  const preferredSource = await store.getContactPreferredMessageSource(user.id);
  const accountEnabled = process.env.TELEGRAM_ACCOUNT_SYNC_ENABLED === 'true';

  return async function sendReply(options = {}) {
    const hasButtons = normalizeButtonRows(options.buttons).length > 0;
    if (preferButtonsViaBot && hasButtons && bot) {
      try {
        return await createBotReplySender(bot, store)(options);
      } catch (error) {
        console.warn(`[telegram-outbound] bot_api button send failed contact=${user.id}: ${error.message}; falling back to outbound queue`);
        if (accountEnabled) {
          return createAccountReplySender({ store })(options);
        }
        throw error;
      }
    }
    if (preferredSource === 'business_account' && accountEnabled) {
      return createAccountReplySender({ store })(options);
    }
    if (bot) {
      return createBotReplySender(bot, store)(options);
    }
    if (accountEnabled) {
      // Last resort: queue text (+ buttons_json) for Telethon. Buttons may be
      // stripped by Telegram if the sender is not a bot account.
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
          // Telegram callback_data max is 64 bytes.
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
