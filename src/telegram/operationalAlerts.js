import { isRoyalVipHubChat, staffGroupIdFromEnv } from './operationalRoles.js';
import {
  paymentCardText,
  paymentCardButtons,
  freeplayCardText,
  freeplayCardButtons,
  paymentStatusLabel,
  STAFF_CB,
  asTelegramSendExtra
} from './staffCards.js';
import { staffReviewReasonLines } from '../payments/confidenceEngine.js';

function resolveBot(bot) {
  return bot || globalThis.telegramBot || null;
}

function resolvePaymentReviewStaffGroup(env = process.env) {
  const groupId = staffGroupIdFromEnv(env);
  if (!groupId) return { ok: false, groupId: null, reason: 'unconfigured' };
  if (!/^-?\d+$/.test(groupId)) return { ok: false, groupId, reason: 'invalid' };
  if (isRoyalVipHubChat(groupId, env)) return { ok: false, groupId, reason: 'refused_hub_target' };
  return { ok: true, groupId, reason: null };
}

function logPaymentReviewDelivery({
  paymentId = null,
  chatId = null,
  ok = false,
  reason = null,
  error = null
} = {}) {
  const line = JSON.stringify({
    paymentId: paymentId ?? null,
    chatId: chatId ?? null,
    ok: Boolean(ok),
    reason: reason || null,
    error: error || null
  });
  if (ok) {
    console.log('[payment-review] delivered', line);
    return;
  }
  console.warn('[payment-review] delivery_failed', line);
}

/**
 * Internal payment-review cards go only to STAFF_TELEGRAM_GROUP_ID.
 * Never DM operational_roles or any private/player chat.
 */
async function sendPaymentReviewToStaffGroup(bot, text, extra, { paymentId = null } = {}) {
  const telegram = resolveBot(bot)?.telegram;
  const resolved = resolvePaymentReviewStaffGroup();
  if (!telegram?.sendMessage) {
    logPaymentReviewDelivery({
      paymentId,
      chatId: resolved.groupId,
      ok: false,
      reason: 'bot_unconfigured'
    });
    return {
      group: false,
      dms: 0,
      reason: 'bot_unconfigured',
      failures: [{ target: 'group', error: 'bot_unconfigured' }]
    };
  }
  if (!resolved.ok) {
    logPaymentReviewDelivery({
      paymentId,
      chatId: resolved.groupId,
      ok: false,
      reason: resolved.reason
    });
    return {
      group: false,
      dms: 0,
      reason: resolved.reason,
      failures: [{ target: 'group', error: resolved.reason }]
    };
  }
  try {
    await telegram.sendMessage(resolved.groupId, text, asTelegramSendExtra(extra));
    logPaymentReviewDelivery({
      paymentId,
      chatId: resolved.groupId,
      ok: true,
      reason: 'staff_group'
    });
    return { group: true, dms: 0, chatId: resolved.groupId };
  } catch (error) {
    const message = error.message || String(error);
    logPaymentReviewDelivery({
      paymentId,
      chatId: resolved.groupId,
      ok: false,
      reason: 'send_failed',
      error: message
    });
    return {
      group: false,
      dms: 0,
      reason: 'send_failed',
      failures: [{ target: 'group', error: message }]
    };
  }
}

async function sendToStaffTargets(store, bot, text, extra = {}) {
  const telegram = resolveBot(bot)?.telegram;
  const sent = { group: false, dms: 0, failures: [] };
  if (!telegram?.sendMessage) {
    return { ...sent, reason: 'bot_unconfigured' };
  }
  const groupId = staffGroupIdFromEnv();
  if (groupId && isRoyalVipHubChat(groupId)) {
    sent.failures.push({ target: 'group', error: 'refused_hub_target' });
  } else if (groupId) {
    try {
      await telegram.sendMessage(groupId, text, asTelegramSendExtra(extra));
      sent.group = true;
    } catch (error) {
      sent.failures.push({ target: 'group', error: error.message });
    }
  }
  const roles = typeof store.listActiveOperationalRoles === 'function'
    ? await store.listActiveOperationalRoles()
    : [];
  for (const role of roles) {
    const chatId = role.telegram_user_id;
    if (!chatId || String(chatId) === String(groupId) || isRoyalVipHubChat(chatId)) continue;
    try {
      await telegram.sendMessage(chatId, text, asTelegramSendExtra(extra));
      sent.dms += 1;
    } catch (error) {
      sent.failures.push({ target: chatId, error: error.message });
    }
  }
  return sent;
}

export async function notifyOperationalStaffPayment(store, payment, {
  bot = null,
  evaluation = null,
  extra = {}
} = {}) {
  const reasons = extra.reasons
    || (evaluation ? staffReviewReasonLines(evaluation) : []);
  const text = paymentCardText(payment, {
    title: extra.title || '⚠️ REVIEW REQUIRED',
    reasons,
    recipient: extra.recipient,
    payer: extra.payer,
    statusLabel: extra.statusLabel || paymentStatusLabel(payment?.routing_status)
  });
  const buttons = extra.creditFailed
    ? paymentCardButtons(payment.id, { creditFailed: true })
    : paymentCardButtons(payment.id, { frozen: payment?.routing_status === 'frozen' });
  const sent = await sendPaymentReviewToStaffGroup(bot, text, buttons, {
    paymentId: payment?.id ?? null
  });
  await postKnownPlayerPaymentNote(store, bot, payment, extra.title || 'Payment needs review');
  return sent;
}

async function postKnownPlayerPaymentNote(store, bot, payment, note) {
  const contactId = Number(payment?.payer_contact_id || payment?.recipient_contact_id || payment?.contact_id);
  if (!Number.isInteger(contactId) || contactId <= 0 || typeof store.getUserProfile !== 'function') return;
  const contact = await store.getUserProfile(contactId).catch(() => null);
  if (!contact) return;
  try {
    const { deliverPlayerNotice, postPlayerTopicSystemEvent } = await import('./staffOperations.js');
    await deliverPlayerNotice({
      store,
      bot: resolveBot(bot),
      contact,
      text: '💰 We received your payment.\nOur team is reviewing it.'
    }).catch(() => null);
    await postPlayerTopicSystemEvent({
      store,
      bot: resolveBot(bot),
      contact,
      text: `${note}: ${payment?.parsed_sender_name || 'Unknown'} · ${payment?.parsed_amount != null ? `$${Number(payment.parsed_amount).toFixed(2)}` : 'a payment'}`
    });
  } catch (error) {
    console.warn('[staff-topic] payment_system_note_failed', error.message);
  }
}

export async function notifyOperationalStaffFreeplay(store, request, { bot = null } = {}) {
  const sent = await sendToStaffTargets(
    store,
    bot,
    freeplayCardText(request),
    freeplayCardButtons(request.id, request.contact_id)
  );
  const contactId = Number(request?.contact_id);
  if (Number.isInteger(contactId) && contactId > 0 && typeof store.getUserProfile === 'function') {
    const contact = await store.getUserProfile(contactId).catch(() => null);
    if (contact) {
      try {
        const { postPlayerTopicSystemEvent } = await import('./staffOperations.js');
        await postPlayerTopicSystemEvent({
          store,
          bot: resolveBot(bot),
          contact,
          text: 'Freeplay requested.'
        });
      } catch (error) {
        console.warn('[staff-topic] freeplay_system_note_failed', error.message);
      }
    }
  }
  return sent;
}

export async function notifyUnmatchedCandidates(store, {
  bot = null,
  requesterName = 'player',
  payments = []
} = {}) {
  if (!payments.length) return { skipped: true };
  const lines = [
    `💵 New deposit window opened for ${requesterName}`,
    'Possible previous unmatched payment:',
    ...payments.slice(0, 5).map((payment) => {
      const amount = payment.parsed_amount != null ? `$${Number(payment.parsed_amount).toFixed(2)}` : '—';
      const when = payment.message_date || payment.created_at || '';
      return `${payment.parsed_sender_name || 'Unknown'} — ${amount}\nReceived ${when}`;
    })
  ];
  const first = payments[0];
  return sendPaymentReviewToStaffGroup(
    bot,
    lines.join('\n'),
    {
      inline_keyboard: [[{ text: '🔎 REVIEW PAYMENT', callback_data: `${STAFF_CB.REVIEW}${first.id}` }]]
    },
    { paymentId: first?.id ?? null }
  );
}

export async function notifyStaffDeliveryFailure(store, {
  bot = null,
  context = 'player DM',
  detail = ''
} = {}) {
  return sendToStaffTargets(
    store,
    bot,
    ['⚠️ TELEGRAM DELIVERY FAILED', context, detail].filter(Boolean).join('\n'),
    {}
  );
}

export async function notifyStaffNewSupportConversation(store, {
  bot = null,
  contact = null,
  nativeHubDm = false
} = {}) {
  const telegram = resolveBot(bot)?.telegram;
  const groupId = staffGroupIdFromEnv();
  if (!telegram?.sendMessage || !groupId || isRoyalVipHubChat(groupId)) {
    return { group: false, dms: 0, reason: groupId && isRoyalVipHubChat(groupId) ? 'refused_hub_target' : 'unconfigured' };
  }
  const name = String(contact?.display_name || contact?.first_name || 'Player').trim() || 'Player';
  const text = nativeHubDm
    ? [
      '💬 New Royal Vip Hub Direct Message',
      name,
      'Open Royal Vip Hub → Direct Messages to reply. Do not post this on the public Hub.'
    ].join('\n')
    : [
      '💬 New customer message',
      name,
      'Open their staff topic to reply privately.'
    ].join('\n');
  try {
    await telegram.sendMessage(groupId, text);
    return { group: true, dms: 0 };
  } catch (error) {
    return { group: false, dms: 0, failures: [{ target: 'group', error: error.message }] };
  }
}
