import { createReplySender, normalizeButtonRows } from './messageDelivery.js';

/**
 * Prefer Bot API for messages that include inline buttons (Telegram user
 * accounts often cannot render callback buttons). Text-only replies still go
 * through the existing outbound queue when that is the preferred channel.
 */
export async function queueBotReply({ store, user, text, buttons = [], bot = null }) {
  const normalizedButtons = normalizeButtonRows(buttons);
  const sendReply = await createReplySender({
    store,
    user,
    bot: bot || globalThis.telegramBot || null,
    preferButtonsViaBot: true
  });
  const result = await sendReply({
    user,
    text,
    buttons: normalizedButtons,
    messageType: normalizedButtons.length ? 'buttons' : 'text'
  });
  const buttonCount = normalizedButtons.flat().length;
  if (result?.queued) {
    console.log(`[chatbot] bot reply queued contact=${user.id} outbound=${result.outboundId || 'n/a'} buttons=${buttonCount}`);
  } else {
    console.log(`[chatbot] bot reply sent contact=${user.id} channel=${result?.source || 'bot_api'} message_id=${result?.messageId || 'n/a'} buttons=${buttonCount}`);
  }
  if (buttonCount) {
    console.log(`[chatbot] welcome_buttons_${result?.queued ? 'queued' : 'sent'} contact=${user.id} channel=${result?.source || 'unknown'} buttons=${JSON.stringify(normalizedButtons)}`);
  }
  return result;
}

export async function queueBotPhotoReply({ store, user, text, mediaPath, buttons = [], bot = null }) {
  const normalizedButtons = normalizeButtonRows(buttons);
  const sendReply = await createReplySender({
    store,
    user,
    bot: bot || globalThis.telegramBot || null,
    preferButtonsViaBot: true
  });
  const result = await sendReply({
    user,
    text,
    mediaPath,
    buttons: normalizedButtons,
    messageType: 'image'
  });
  if (result?.queued) {
    console.log(`[chatbot] bot photo queued contact=${user.id} outbound=${result.outboundId || 'n/a'} media=${mediaPath}`);
  } else {
    console.log(`[chatbot] bot photo sent contact=${user.id} channel=${result?.source || 'bot_api'} message_id=${result?.messageId || 'n/a'}`);
  }
  return result;
}
