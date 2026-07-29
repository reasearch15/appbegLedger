/**
 * Separate Telegram bot used only for owner/admin support notifications.
 * Player-facing traffic stays on the main RoyalVIP bot.
 * Recipients are registered subscribers (/start on this bot), not a fixed chat ID.
 */

export const SUPPORT_REQUEST_SENT_TEXT = 'Your support request has been sent.';
export const INQUIRY_REQUEST_SENT_TEXT = 'Your inquiry has been sent.';
export const SUPPORT_DELIVERY_FAILED_TEXT = 'We could not send your request right now. Please try again.';
export const SUPPORT_CLAIM_PREFIX = 'support:claim:';
export const SUPPORT_DONE_PREFIX = 'support:done:';
export const SUPPORT_ACCOUNT_NOT_FOUND_TEXT = 'We could not find your RoyalVIP account. Please contact support.';
export const SUPPORT_SUBSCRIBED_TEXT = '✅ You are now subscribed to RoyalVIP support notifications.';
export const SUPPORT_UNSUBSCRIBED_TEXT = 'Notifications disabled.';

export function getSupportNotificationConfig(env = process.env) {
  const token = String(env.SUPPORT_NOTIFICATION_BOT_TOKEN || '').trim();
  return {
    token: token || null,
    configured: Boolean(token)
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
    `RoyalVIP Username: ${sanitizePlain(username)}`,
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
    `RoyalVIP Username: ${sanitizePlain(username)}`,
    'Question:',
    sanitizePlain(question)
  ].join('\n');
}

export function buildFreePlayNotificationText({ username } = {}) {
  return [
    '🎁 FreePlay Request',
    `RoyalVIP Username: ${sanitizePlain(username)}`
  ].join('\n');
}

export function buildSupportRequestRecord({
  kind = 'support',
  username,
  topic = null,
  question = null,
  message = null
} = {}) {
  return {
    kind: ['freeplay', 'inquiry', 'support', 'faq'].includes(String(kind)) ? String(kind) : 'support',
    username: sanitizePlain(username),
    topic: sanitizePlain(topic),
    question: sanitizePlain(question),
    message: sanitizePlain(message)
  };
}

export function buildSupportRequestMessage(request = {}) {
  const kind = String(request.kind || 'support');
  const status = String(request.status || 'pending');
  const lines = [
    supportRequestTitle(kind),
    '',
    `RoyalVIP Username: ${sanitizePlain(request.username)}`
  ];

  if (kind === 'support' || kind === 'faq') {
    const topic = sanitizePlain(request.topic);
    if (topic) lines.push(`Topic: ${topic}`);
  }

  if (kind === 'inquiry') {
    lines.push('', 'Question:', sanitizePlain(request.question || request.message));
  } else {
    const body = sanitizePlain(request.message);
    if (body) lines.push('', 'Message:', body);
  }

  lines.push('');

  if (status === 'completed') {
    lines.push(
      'Status: 🟢 COMPLETED',
      `Completed by: ${sanitizePlain(request.completed_by_name || request.claimed_by_name || 'Staff')}`,
      `Completed at: ${formatSupportRequestTime(request.completed_at)}`,
      '',
      completedLine(kind)
    );
    return lines.join('\n');
  }

  if (status === 'claimed') {
    lines.push(
      'Status: 🔵 CLAIMED',
      `Claimed by: ${sanitizePlain(request.claimed_by_name || 'Staff')}`,
      `Claimed at: ${formatSupportRequestTime(request.claimed_at)}`
    );
    return lines.join('\n');
  }

  lines.push('Status: 🟡 PENDING');
  return lines.join('\n');
}

export function buildSupportRequestReplyMarkup(request = {}) {
  const id = Number(request.id);
  if (!Number.isFinite(id) || id <= 0 || request.status === 'completed') return undefined;
  if (request.status === 'claimed') {
    return {
      inline_keyboard: [[
        { text: '🟢 Done', callback_data: `${SUPPORT_DONE_PREFIX}${id}` }
      ]]
    };
  }
  return {
    inline_keyboard: [[
      { text: '🔵 Claim', callback_data: `${SUPPORT_CLAIM_PREFIX}${id}` },
      { text: '🟢 Done', callback_data: `${SUPPORT_DONE_PREFIX}${id}` }
    ]]
  };
}

export function supportRequestTitle(kind = 'support') {
  if (kind === 'freeplay') return '🎁 FreePlay Request';
  if (kind === 'inquiry') return '❓ New Inquiry';
  return '🆘 Support Request';
}

function completedLine(kind = 'support') {
  if (kind === 'freeplay') return '✅ Job completed';
  if (kind === 'inquiry') return '✅ Inquiry completed';
  return '✅ Support request completed';
}

export function formatSupportRequestTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return sanitizePlain(value);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

export function isPermanentSupportDeliveryError(errorCode, description = '') {
  const code = Number(errorCode);
  const desc = String(description || '').toLowerCase();
  if (code === 403) return true;
  if (/forbidden|blocked by the user|bot was blocked|chat not found|user is deactivated|peer_id_invalid|chat_id is empty/i.test(desc)) {
    return true;
  }
  if (code === 400 && /chat not found|user is deactivated|peer_id_invalid/i.test(desc)) {
    return true;
  }
  return false;
}

/**
 * Broadcast a notification to every active support subscriber.
 * Success = at least one subscriber received the message.
 * Never logs token or full message body.
 */
export async function sendSupportBotNotification({
  store,
  kind = 'support',
  text,
  request = null,
  meta = {},
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = getSupportNotificationConfig(env);
  const logMeta = {
    contact_id: meta.contactId ?? null,
    job_id: meta.jobId ?? null,
    update_id: meta.updateId ?? null,
    action: meta.action ?? null,
    topic: meta.topic ?? null,
    kind,
    configured: config.configured
  };

  console.log('[chatbot] support_notification_broadcast', logMeta);

  if (!config.configured) {
    const error = new Error('SUPPORT_NOTIFICATION_BOT_TOKEN is not configured.');
    error.code = 'SUPPORT_NOTIFICATION_NOT_CONFIGURED';
    console.error('[chatbot] support_notification_failed', {
      ...logMeta,
      error_code: error.code
    });
    throw error;
  }

  if (!store || typeof store.listActiveSupportNotificationSubscribers !== 'function') {
    const error = new Error('Support notification subscriber store is not configured.');
    error.code = 'SUPPORT_NOTIFICATION_STORE_UNAVAILABLE';
    console.error('[chatbot] support_notification_failed', {
      ...logMeta,
      error_code: error.code
    });
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is required to deliver support notifications.');
    error.code = 'SUPPORT_NOTIFICATION_FETCH_UNAVAILABLE';
    throw error;
  }

  const subscribers = await store.listActiveSupportNotificationSubscribers();
  if (!subscribers.length) {
    const error = new Error('No active support notification subscribers.');
    error.code = 'SUPPORT_NOTIFICATION_NO_SUBSCRIBERS';
    console.warn('[chatbot] support_notification_no_subscribers', logMeta);
    console.error('[chatbot] support_notification_failed', {
      ...logMeta,
      error_code: error.code
    });
    throw error;
  }

  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
  const bodyText = request ? buildSupportRequestMessage(request) : String(text || '');
  const replyMarkup = request ? buildSupportRequestReplyMarkup(request) : undefined;
  let successCount = 0;
  let failureCount = 0;
  let firstMessageId = null;
  const deliveryResults = [];

  for (const subscriber of subscribers) {
    const chatId = String(subscriber.telegram_chat_id || '').trim();
    if (!chatId) {
      failureCount += 1;
      continue;
    }

    let response;
    let payload = null;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: bodyText,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          disable_web_page_preview: true
        })
      });
      payload = await response.json().catch(() => null);
    } catch (error) {
      failureCount += 1;
      deliveryResults.push({
        telegram_chat_id: chatId,
        ok: false,
        error_code: error?.code || 'SUPPORT_NOTIFICATION_NETWORK_ERROR'
      });
      if (typeof store.markSupportNotificationDelivery === 'function') {
        await store.markSupportNotificationDelivery(chatId, {
          status: 'failed',
          error: error?.code || error?.message || 'network_error',
          deactivate: false
        }).catch(() => null);
      }
      console.error('[chatbot] support_notification_failed', {
        ...logMeta,
        subscriber_id: subscriber.id ?? null,
        telegram_chat_id: chatId,
        error_code: error?.code || 'SUPPORT_NOTIFICATION_NETWORK_ERROR'
      });
      continue;
    }

    if (!response.ok || !payload?.ok) {
      const errorCode = payload?.error_code || `HTTP_${response.status}`;
      const description = payload?.description || `Support notification bot send failed (${response.status})`;
      const permanent = isPermanentSupportDeliveryError(errorCode, description);
      failureCount += 1;
      deliveryResults.push({
        telegram_chat_id: chatId,
        ok: false,
        error_code: errorCode,
        deactivated: permanent
      });
      if (typeof store.markSupportNotificationDelivery === 'function') {
        await store.markSupportNotificationDelivery(chatId, {
          status: 'failed',
          error: `${errorCode}: ${description}`.slice(0, 300),
          deactivate: permanent
        }).catch(() => null);
      } else if (permanent && typeof store.deactivateSupportNotificationSubscriber === 'function') {
        await store.deactivateSupportNotificationSubscriber(chatId, {
          reason: `${errorCode}: ${description}`.slice(0, 300)
        }).catch(() => null);
      }
      if (permanent) {
        console.log('[chatbot] support_subscriber_disabled', {
          subscriber_id: subscriber.id ?? null,
          telegram_chat_id: chatId,
          reason: 'permanent_delivery_failure',
          error_code: errorCode
        });
      }
      console.error('[chatbot] support_notification_failed', {
        ...logMeta,
        subscriber_id: subscriber.id ?? null,
        telegram_chat_id: chatId,
        error_code: errorCode,
        http_status: response.status,
        deactivated: permanent
      });
      continue;
    }

    successCount += 1;
    const messageId = Number(payload?.result?.message_id || 0) || null;
    if (!firstMessageId) firstMessageId = messageId;
    deliveryResults.push({
      telegram_chat_id: chatId,
      ok: true,
      message_id: messageId
    });
    if (typeof store.markSupportNotificationDelivery === 'function') {
      await store.markSupportNotificationDelivery(chatId, {
        status: 'sent',
        error: null,
        deactivate: false
      }).catch(() => null);
    }
    if (request?.id && typeof store.recordSupportRequestDelivery === 'function') {
      await store.recordSupportRequestDelivery(request.id, {
        subscriberId: subscriber.id ?? null,
        telegramChatId: chatId,
        telegramMessageId: messageId,
        status: 'sent'
      }).catch((error) => {
        console.error('[chatbot] support_request_delivery_record_failed', {
          ...logMeta,
          request_id: request.id,
          telegram_chat_id: chatId,
          message_id: messageId,
          error_code: error?.code || error?.message || 'record_failed'
        });
      });
    }
    console.log('[chatbot] support_notification_sent', {
      ...logMeta,
      subscriber_id: subscriber.id ?? null,
      telegram_chat_id: chatId,
      message_id: messageId,
      delivery_status: 'sent'
    });
  }

  if (successCount < 1) {
    const error = new Error('Support notification broadcast failed for all subscribers.');
    error.code = 'SUPPORT_NOTIFICATION_ALL_FAILED';
    console.error('[chatbot] support_notification_failed', {
      ...logMeta,
      error_code: error.code,
      success_count: successCount,
      failure_count: failureCount,
      subscriber_count: subscribers.length
    });
    throw error;
  }

  console.log('[chatbot] support_notification_broadcast_complete', {
    ...logMeta,
    success_count: successCount,
    failure_count: failureCount,
    subscriber_count: subscribers.length,
    delivery_status: 'sent'
  });

  return {
    ok: true,
    messageId: firstMessageId,
    successCount,
    failureCount,
    subscriberCount: subscribers.length,
    deliveryResults
  };
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
