import {
  getSupportNotificationConfig,
  isPermanentSupportDeliveryError
} from './supportNotificationBot.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup
} from './cashoutNotificationCards.js';

export function isTelegramMessageNotModifiedError(errorCode, description = '') {
  const desc = String(description || '').toLowerCase();
  return /message is not modified/i.test(desc);
}

export function isPermanentCashoutEditError(errorCode, description = '') {
  if (isTelegramMessageNotModifiedError(errorCode, description)) return false;
  if (isPermanentSupportDeliveryError(errorCode, description)) return true;
  const code = Number(errorCode);
  const desc = String(description || '').toLowerCase();
  if (/message to edit not found|message can't be edited|message_id_invalid|message identifier is not specified/i.test(desc)) {
    return true;
  }
  if (code === 400 && /message to edit not found|can't be edited|message_id_invalid/i.test(desc)) {
    return true;
  }
  return false;
}

/**
 * Send one cash-out notification to a single Telegram chat.
 * Card content reflects CURRENT AppBeg task status (authoritative).
 */
export async function sendCashoutNotificationToChat({
  chatId,
  task,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeZone = 'UTC',
  nowMs = Date.now(),
  viewerTelegramUserId = null
} = {}) {
  const config = getSupportNotificationConfig(env);
  const telegramChatId = String(chatId ?? '').trim();

  if (!config.configured) {
    return {
      ok: false,
      permanent: false,
      error: 'SUPPORT_NOTIFICATION_NOT_CONFIGURED'
    };
  }
  if (!telegramChatId) {
    return {
      ok: false,
      permanent: true,
      error: 'MISSING_CHAT_ID'
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      permanent: false,
      error: 'FETCH_UNAVAILABLE'
    };
  }

  const text = buildCashoutNotificationCard(task, { timeZone, nowMs });
  const replyMarkup = buildCashoutNotificationReplyMarkup(task, {
    env,
    viewerTelegramUserId
  });
  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;

  let response;
  let payload = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      })
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      error: error?.code || error?.message || 'network_error'
    };
  }

  if (payload?.ok && payload.result?.message_id != null) {
    return {
      ok: true,
      telegramMessageId: Number(payload.result.message_id),
      permanent: false,
      error: null
    };
  }

  const errorCode = payload?.error_code ?? response?.status ?? 'TELEGRAM_SEND_FAILED';
  const description = payload?.description || '';
  const permanent = isPermanentSupportDeliveryError(errorCode, description);
  return {
    ok: false,
    permanent,
    error: String(description || errorCode).slice(0, 300),
    errorCode
  };
}

/**
 * Edit an existing cash-out Telegram card to match CURRENT AppBeg task state.
 * "message is not modified" is treated as success (already synchronized).
 */
export async function editCashoutNotificationMessage({
  chatId,
  messageId,
  task,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeZone = 'UTC',
  nowMs = Date.now(),
  viewerTelegramUserId = null
} = {}) {
  const config = getSupportNotificationConfig(env);
  const telegramChatId = String(chatId ?? '').trim();
  const telegramMessageId = Number(messageId);

  if (!config.configured) {
    return {
      ok: false,
      permanent: false,
      error: 'SUPPORT_NOTIFICATION_NOT_CONFIGURED'
    };
  }
  if (!telegramChatId) {
    return {
      ok: false,
      permanent: true,
      error: 'MISSING_CHAT_ID'
    };
  }
  if (!Number.isFinite(telegramMessageId)) {
    return {
      ok: false,
      permanent: true,
      error: 'MISSING_MESSAGE_ID'
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      permanent: false,
      error: 'FETCH_UNAVAILABLE'
    };
  }

  const text = buildCashoutNotificationCard(task, { timeZone, nowMs });
  const replyMarkup = buildCashoutNotificationReplyMarkup(task, {
    env,
    viewerTelegramUserId
  });
  const url = `https://api.telegram.org/bot${config.token}/editMessageText`;

  let response;
  let payload = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        message_id: telegramMessageId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      })
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      error: error?.code || error?.message || 'network_error'
    };
  }

  if (payload?.ok) {
    return {
      ok: true,
      unchanged: false,
      permanent: false,
      error: null
    };
  }

  const errorCode = payload?.error_code ?? response?.status ?? 'TELEGRAM_EDIT_FAILED';
  const description = payload?.description || '';

  if (isTelegramMessageNotModifiedError(errorCode, description)) {
    return {
      ok: true,
      unchanged: true,
      permanent: false,
      error: null
    };
  }

  const permanent = isPermanentCashoutEditError(errorCode, description);
  return {
    ok: false,
    permanent,
    messageMissing: /message to edit not found/i.test(String(description)),
    error: String(description || errorCode).slice(0, 300),
    errorCode
  };
}
