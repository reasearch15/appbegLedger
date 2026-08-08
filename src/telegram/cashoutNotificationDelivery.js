import {
  getSupportNotificationConfig,
  isPermanentSupportDeliveryError
} from './supportNotificationBot.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup
} from './cashoutNotificationCards.js';

export const CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT = 'text';
export const CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO = 'photo';

export function normalizeCashoutTelegramMessageType(value) {
  return String(value || '').trim().toLowerCase() === CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO
    ? CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO
    : CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT;
}

/**
 * Accept only fetchable http(s) QR image URLs for Telegram sendPhoto.
 */
export function resolveCashoutQrImageUrl(task) {
  const raw = String(task?.qrImageUrl ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

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
 * Telegram rejected the photo URL (unreachable / wrong content) — safe to fall back to text.
 */
export function isCashoutPhotoUrlDeliveryError(errorCode, description = '') {
  const desc = String(description || '').toLowerCase();
  if (!desc) return false;
  if (/failed to get http url content/i.test(desc)) return true;
  if (/wrong type of the web page content/i.test(desc)) return true;
  if (/wrong file identifier\/http url specified/i.test(desc)) return true;
  if (/failed to get file/i.test(desc)) return true;
  if (/url host is empty/i.test(desc)) return true;
  if (/wrong http url/i.test(desc)) return true;
  const code = Number(errorCode);
  if (code === 400 && /photo|http url|webpage content|file/i.test(desc)) return true;
  return false;
}

async function postTelegramApi(url, body, fetchImpl) {
  let response;
  let payload = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    payload = await response.json().catch(() => null);
    return { ok: true, response, payload, networkError: null };
  } catch (error) {
    return {
      ok: false,
      response: null,
      payload: null,
      networkError: error?.code || error?.message || 'network_error'
    };
  }
}

async function sendCashoutTextMessage({
  config,
  telegramChatId,
  text,
  replyMarkup,
  fetchImpl
}) {
  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
  const posted = await postTelegramApi(url, {
    chat_id: telegramChatId,
    text,
    reply_markup: replyMarkup,
    disable_web_page_preview: true
  }, fetchImpl);

  if (!posted.ok) {
    return {
      ok: false,
      permanent: false,
      error: posted.networkError,
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT
    };
  }

  const { response, payload } = posted;
  if (payload?.ok && payload.result?.message_id != null) {
    return {
      ok: true,
      telegramMessageId: Number(payload.result.message_id),
      permanent: false,
      error: null,
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT,
      usedPhotoFallback: false
    };
  }

  const errorCode = payload?.error_code ?? response?.status ?? 'TELEGRAM_SEND_FAILED';
  const description = payload?.description || '';
  const permanent = isPermanentSupportDeliveryError(errorCode, description);
  return {
    ok: false,
    permanent,
    error: String(description || errorCode).slice(0, 300),
    errorCode,
    messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT
  };
}

async function sendCashoutPhotoMessage({
  config,
  telegramChatId,
  photoUrl,
  caption,
  replyMarkup,
  fetchImpl
}) {
  const url = `https://api.telegram.org/bot${config.token}/sendPhoto`;
  const posted = await postTelegramApi(url, {
    chat_id: telegramChatId,
    photo: photoUrl,
    caption,
    reply_markup: replyMarkup
  }, fetchImpl);

  if (!posted.ok) {
    return {
      ok: false,
      permanent: false,
      error: posted.networkError,
      errorCode: null,
      photoUrlFailed: false,
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO
    };
  }

  const { response, payload } = posted;
  if (payload?.ok && payload.result?.message_id != null) {
    return {
      ok: true,
      telegramMessageId: Number(payload.result.message_id),
      permanent: false,
      error: null,
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO,
      usedPhotoFallback: false
    };
  }

  const errorCode = payload?.error_code ?? response?.status ?? 'TELEGRAM_SEND_FAILED';
  const description = payload?.description || '';
  const photoUrlFailed = isCashoutPhotoUrlDeliveryError(errorCode, description);
  const permanent = !photoUrlFailed && isPermanentSupportDeliveryError(errorCode, description);
  return {
    ok: false,
    permanent,
    photoUrlFailed,
    error: String(description || errorCode).slice(0, 300),
    errorCode,
    messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO
  };
}

/**
 * Send one cash-out notification to a single Telegram chat.
 * Uses sendPhoto + caption when task.qrImageUrl is a valid http(s) URL;
 * falls back to sendMessage if photo delivery fails due to an unreachable/invalid URL.
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
      error: 'SUPPORT_NOTIFICATION_NOT_CONFIGURED',
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT
    };
  }
  if (!telegramChatId) {
    return {
      ok: false,
      permanent: true,
      error: 'MISSING_CHAT_ID',
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      permanent: false,
      error: 'FETCH_UNAVAILABLE',
      messageType: CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT
    };
  }

  const text = buildCashoutNotificationCard(task, { timeZone, nowMs });
  const replyMarkup = buildCashoutNotificationReplyMarkup(task, {
    env,
    viewerTelegramUserId
  });
  const photoUrl = resolveCashoutQrImageUrl(task);

  if (photoUrl) {
    const photoResult = await sendCashoutPhotoMessage({
      config,
      telegramChatId,
      photoUrl,
      caption: text,
      replyMarkup,
      fetchImpl
    });
    if (photoResult.ok) {
      return photoResult;
    }

    if (photoResult.photoUrlFailed) {
      console.warn('[cashout-telegram] photo_delivery_failed_text_fallback', {
        task_id: task?.taskId || null,
        telegram_chat_id: telegramChatId,
        error: photoResult.error
      });
      const textResult = await sendCashoutTextMessage({
        config,
        telegramChatId,
        text,
        replyMarkup,
        fetchImpl
      });
      if (textResult.ok) {
        return {
          ...textResult,
          usedPhotoFallback: true,
          photoError: photoResult.error
        };
      }
      return {
        ...textResult,
        usedPhotoFallback: true,
        photoError: photoResult.error
      };
    }

    return photoResult;
  }

  return sendCashoutTextMessage({
    config,
    telegramChatId,
    text,
    replyMarkup,
    fetchImpl
  });
}

/**
 * Edit an existing cash-out Telegram card to match CURRENT AppBeg task state.
 * Photo deliveries use editMessageCaption; text deliveries use editMessageText.
 * "message is not modified" is treated as success (already synchronized).
 */
export async function editCashoutNotificationMessage({
  chatId,
  messageId,
  task,
  messageType = CASHOUT_TELEGRAM_MESSAGE_TYPE_TEXT,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeZone = 'UTC',
  nowMs = Date.now(),
  viewerTelegramUserId = null
} = {}) {
  const config = getSupportNotificationConfig(env);
  const telegramChatId = String(chatId ?? '').trim();
  const telegramMessageId = Number(messageId);
  const deliveryType = normalizeCashoutTelegramMessageType(messageType);

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

  const useCaption = deliveryType === CASHOUT_TELEGRAM_MESSAGE_TYPE_PHOTO;
  const url = useCaption
    ? `https://api.telegram.org/bot${config.token}/editMessageCaption`
    : `https://api.telegram.org/bot${config.token}/editMessageText`;

  const body = useCaption
    ? {
        chat_id: telegramChatId,
        message_id: telegramMessageId,
        caption: text,
        reply_markup: replyMarkup
      }
    : {
        chat_id: telegramChatId,
        message_id: telegramMessageId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      };

  const posted = await postTelegramApi(url, body, fetchImpl);
  if (!posted.ok) {
    return {
      ok: false,
      permanent: false,
      error: posted.networkError
    };
  }

  const { response, payload } = posted;
  if (payload?.ok) {
    return {
      ok: true,
      unchanged: false,
      permanent: false,
      error: null,
      messageType: deliveryType
    };
  }

  const errorCode = payload?.error_code ?? response?.status ?? 'TELEGRAM_EDIT_FAILED';
  const description = payload?.description || '';

  if (isTelegramMessageNotModifiedError(errorCode, description)) {
    return {
      ok: true,
      unchanged: true,
      permanent: false,
      error: null,
      messageType: deliveryType
    };
  }

  const permanent = isPermanentCashoutEditError(errorCode, description);
  return {
    ok: false,
    permanent,
    messageMissing: /message to edit not found/i.test(String(description)),
    error: String(description || errorCode).slice(0, 300),
    errorCode,
    messageType: deliveryType
  };
}
