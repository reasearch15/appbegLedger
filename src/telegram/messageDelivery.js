export function createBotReplySender(bot, store) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text' }) {
    const replyMarkup = buttons.length
      ? { inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.label, callback_data: button.action }))) }
      : undefined;
    const telegramResponse = await bot.telegram.sendMessage(user.telegram_id, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: telegramResponse.message_id,
      text,
      payload: { telegramResponse, buttons },
      senderType: 'bot',
      messageType: buttons.length ? 'buttons' : messageType
    });
    return telegramResponse;
  };
}

export function createAccountReplySender({ store }) {
  return async function sendReply({ user, text, buttons = [], messageType = 'text' }) {
    const temporaryTelegramMessageId = -Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
    const stored = await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: temporaryTelegramMessageId,
      text,
      payload: {
        queued: true,
        buttons,
        sync_kind: 'queued',
        source: 'business_account'
      },
      senderType: 'bot',
      source: 'business_account',
      messageType: buttons.length ? 'buttons' : messageType,
      sentAt: new Date().toISOString()
    });
    const outbound = await store.queueTelegramOutboundMessage({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      body: text,
      buttons,
      localMessageId: stored.messageId
    });
    await store.db.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ('outbound_queue:nudge', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(outbound.id), new Date().toISOString());
    console.log(`[telegram-outbound] queued id=${outbound.id} contact=${user.id} telegram=${user.telegram_id}`);
    return {
      ok: true,
      queued: true,
      source: 'business_account',
      outboundId: outbound.id
    };
  };
}

export async function createReplySender({ store, user, rootDir, bot }) {
  const preferredSource = await store.getContactPreferredMessageSource(user.id);
  const accountEnabled = process.env.TELEGRAM_ACCOUNT_SYNC_ENABLED === 'true';
  if (preferredSource === 'business_account' && accountEnabled) {
    return createAccountReplySender({ store });
  }
  if (bot) {
    return createBotReplySender(bot, store);
  }
  throw new Error('No Telegram reply channel is available for this contact.');
}
