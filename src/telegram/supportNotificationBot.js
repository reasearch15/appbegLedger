/**
 * Separate Telegram bot used only for owner/admin support notifications.
 * Player-facing traffic stays on the main RoyalVIP bot.
 */

export const SUPPORT_REQUEST_SENT_TEXT = 'Your support request has been sent.';
export const INQUIRY_REQUEST_SENT_TEXT = 'Your inquiry has been sent.';
export const SUPPORT_DELIVERY_FAILED_TEXT = 'We could not send your request right now. Please try again.';
export const SUPPORT_ACCOUNT_NOT_FOUND_TEXT = 'We could not find your RoyalVIP account. Please contact support.';

export function getSupportNotificationConfig(env = process.env) {
  const token = String(env.SUPPORT_NOTIFICATION_BOT_TOKEN || '').trim();
  const chatId = String(env.SUPPORT_NOTIFICATION_CHAT_ID || '').trim();
  return {
    token: token || null,
    chatId: chatId || null,
    configured: Boolean(token && chatId)
  };
}

/** Escape user text for Telegram HTML parse_mode without allowing markup injection. */
export function escapeTelegramHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function resolveAppBegUsernameForSupport({ contact = {}, info = {} } = {}) {
  const stored = info?.royal_vip_credentials && typeof info.royal_vip_credentials === 'object'
    ? info.royal_vip_credentials
    : {};
  const username = firstNonBlank(
    stored.username,
    info.royal_vip_username,
    info.preferred_appbeg_username,
    info.appbeg_username,
    contact.appbeg_username
  );
  const credentialTelegramId = firstNonBlank(stored.telegram_user_id, info.telegram_user_id);
  const contactTelegramId = firstNonBlank(contact.telegram_id);
  if (credentialTelegramId && contactTelegramId && credentialTelegramId !== contactTelegramId) {
    return { ok: false, reason: 'ownership_mismatch', username: null };
  }
  const storedUid = firstNonBlank(stored.player_uid);
  const contactUid = firstNonBlank(contact.appbeg_account_id);
  if (storedUid && contactUid && storedUid !== contactUid) {
    return { ok: false, reason: 'ownership_mismatch', username: null };
  }
  if (!username) {
    return { ok: false, reason: 'missing_username', username: null };
  }
  return { ok: true, reason: 'ok', username };
}

export function buildSupportRequestNotificationText({ username, topic, message = null } = {}) {
  const lines = [
    '🆘 Support Request',
    `AppBeg Username: ${sanitizePlain(username)}`,
    `Topic: ${sanitizePlain(topic)}`
  ];
  const body = String(message || '').trim();
  if (body) {
    lines.push('', 'Message:', sanitizePlain(body));
  }
  return lines.join('\n');
}

export function buildInquiryNotificationText({ username, question } = {}) {
  return [
    '❓ New Inquiry',
    `AppBeg Username: ${sanitizePlain(username)}`,
    'Question:',
    sanitizePlain(question)
  ].join('\n');
}

export function buildFreePlayNotificationText({ username } = {}) {
  return [
    '🎁 FreePlay Request',
    `AppBeg Username: ${sanitizePlain(username)}`
  ].join('\n');
}

/**
 * Send a notification through the dedicated support bot.
 * Never logs token or message body.
 */
export async function sendSupportBotNotification({
  kind = 'support',
  text,
  meta = {},
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = getSupportNotificationConfig(env);
  const logPrefix = kind === 'inquiry'
    ? 'inquiry_notification'
    : kind === 'freeplay'
      ? 'freeplay_notification'
      : 'support_notification';

  console.log(`[chatbot] ${logPrefix}_send`, {
    contact_id: meta.contactId ?? null,
    job_id: meta.jobId ?? null,
    update_id: meta.updateId ?? null,
    action: meta.action ?? null,
    topic: meta.topic ?? null,
    configured: config.configured
  });

  if (!config.configured) {
    const error = new Error('SUPPORT_NOTIFICATION_BOT_TOKEN / SUPPORT_NOTIFICATION_CHAT_ID are not configured.');
    error.code = 'SUPPORT_NOTIFICATION_NOT_CONFIGURED';
    console.error(`[chatbot] ${logPrefix}_failed`, {
      contact_id: meta.contactId ?? null,
      job_id: meta.jobId ?? null,
      update_id: meta.updateId ?? null,
      action: meta.action ?? null,
      error_code: error.code
    });
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is required to deliver support notifications.');
    error.code = 'SUPPORT_NOTIFICATION_FETCH_UNAVAILABLE';
    throw error;
  }

  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
  let response;
  let payload = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: String(text || ''),
        disable_web_page_preview: true
      })
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    console.error(`[chatbot] ${logPrefix}_failed`, {
      contact_id: meta.contactId ?? null,
      job_id: meta.jobId ?? null,
      update_id: meta.updateId ?? null,
      action: meta.action ?? null,
      error_code: error?.code || 'SUPPORT_NOTIFICATION_NETWORK_ERROR'
    });
    throw error;
  }

  if (!response.ok || !payload?.ok) {
    const apiError = new Error(payload?.description || `Support notification bot send failed (${response.status})`);
    apiError.code = payload?.error_code || `HTTP_${response.status}`;
    console.error(`[chatbot] ${logPrefix}_failed`, {
      contact_id: meta.contactId ?? null,
      job_id: meta.jobId ?? null,
      update_id: meta.updateId ?? null,
      action: meta.action ?? null,
      error_code: apiError.code,
      http_status: response.status
    });
    throw apiError;
  }

  const messageId = Number(payload?.result?.message_id || 0) || null;
  console.log(`[chatbot] ${logPrefix}_sent`, {
    contact_id: meta.contactId ?? null,
    job_id: meta.jobId ?? null,
    update_id: meta.updateId ?? null,
    action: meta.action ?? null,
    topic: meta.topic ?? null,
    message_id: messageId,
    delivery_status: 'sent'
  });
  return { ok: true, messageId, chatId: config.chatId };
}

function sanitizePlain(value = '') {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 3500);
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = sanitizePlain(value);
    if (text) return text;
  }
  return '';
}
