const DEFAULT_TIMEOUT_MS = 8000;

function teleledgerConfig() {
  return {
    baseUrl: String(process.env.TELELEDGER_API_URL || '').replace(/\/$/, ''),
    token: process.env.TELELEDGER_INTERNAL_TOKEN || process.env.APPBEG_ROUTER_TOKEN || ''
  };
}

export function isTeleledgerConfigured() {
  const { baseUrl, token } = teleledgerConfig();
  return Boolean(baseUrl && token);
}

async function postJson(path, body) {
  const { baseUrl, token } = teleledgerConfig();
  if (!baseUrl || !token) {
    throw new Error('TeleLedger integration is not configured (TELELEDGER_API_URL / TELELEDGER_INTERNAL_TOKEN).');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AppBeg-Token': token
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const message = payload?.detail || payload?.error || text || `TeleLedger request failed (${response.status})`;
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function forwardPaymentToTeleledger({
  idempotencyKey,
  telegramChatId,
  telegramMessageId,
  senderId,
  senderName,
  rawText,
  receivedAt,
  disposition,
  parsed,
  linkedContactId,
  linkedPlayerLabel
}) {
  return postJson('/api/internal/appbeg/payments', {
    idempotency_key: idempotencyKey,
    telegram_chat_id: telegramChatId,
    telegram_message_id: telegramMessageId,
    sender_id: senderId,
    sender_name: senderName,
    raw_text: rawText,
    received_at: receivedAt,
    disposition,
    parsed: parsed
      ? {
          recipient_tag: parsed.recipient_tag,
          amount: parsed.amount,
          payment_sender_name: parsed.payment_sender_name,
          payment_datetime: parsed.payment_datetime,
          total_in: parsed.total_in,
          total_out: parsed.total_out
        }
      : null,
    linked_external_player_id: linkedContactId || null,
    linked_player_label: linkedPlayerLabel || null,
    handled_by: disposition === 'appbeg_claimed' ? 'AppBegBot' : null
  });
}
