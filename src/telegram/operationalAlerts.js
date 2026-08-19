import { staffGroupIdFromEnv } from './operationalRoles.js';
import {
  paymentCardText,
  paymentCardButtons,
  freeplayCardText,
  freeplayCardButtons,
  paymentStatusLabel,
  STAFF_CB
} from './staffCards.js';
import { staffReviewReasonLines } from '../payments/confidenceEngine.js';

function resolveBot(bot) {
  return bot || globalThis.telegramBot || null;
}

async function sendToStaffTargets(store, bot, text, extra = {}) {
  const telegram = resolveBot(bot)?.telegram;
  const sent = { group: false, dms: 0, failures: [] };
  if (!telegram?.sendMessage) {
    return { ...sent, reason: 'bot_unconfigured' };
  }
  const groupId = staffGroupIdFromEnv();
  if (groupId) {
    try {
      await telegram.sendMessage(groupId, text, extra);
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
    if (!chatId || String(chatId) === String(groupId)) continue;
    try {
      await telegram.sendMessage(chatId, text, extra);
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
  dmEveryone = true,
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
  if (!dmEveryone) {
    const telegram = resolveBot(bot)?.telegram;
    const groupId = staffGroupIdFromEnv();
    if (!telegram?.sendMessage || !groupId) return { group: false, dms: 0 };
    try {
      await telegram.sendMessage(groupId, text, buttons);
      return { group: true, dms: 0 };
    } catch (error) {
      return { group: false, dms: 0, failures: [{ target: 'group', error: error.message }] };
    }
  }
  return sendToStaffTargets(store, bot, text, buttons);
}

export async function notifyOperationalStaffFreeplay(store, request, { bot = null } = {}) {
  return sendToStaffTargets(
    store,
    bot,
    freeplayCardText(request),
    freeplayCardButtons(request.id, request.contact_id)
  );
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
  return sendToStaffTargets(store, bot, lines.join('\n'), {
    inline_keyboard: [[{ text: '🔎 REVIEW PAYMENT', callback_data: `${STAFF_CB.REVIEW}${first.id}` }]]
  });
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
