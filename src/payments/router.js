import { normalizePaymentTag } from '../registration/utils.js';
import { parsePaymentMessage } from './parser.js';
import {
  buildIdempotencyKey,
  DEPOSIT_STATUS,
  HANDLED_BY_APPBEG_BOT,
  ROUTING_OWNER,
  ROUTING_STATUS
} from './constants.js';
import { forwardPaymentToTeleledger, isTeleledgerConfigured } from './teleledgerClient.js';

function isAlreadyRouted(payment) {
  const status = payment.routing_status || ROUTING_STATUS.UNROUTED;
  return status !== ROUTING_STATUS.UNROUTED && status !== null;
}

async function findRegisteredPlayerByTag(store, normalizedTag) {
  if (!normalizedTag) return null;
  const players = await store.listPlayers({ limit: 5000 });
  return players.find((player) => normalizePaymentTag(player.payment_tag) === normalizedTag) || null;
}

async function activeDepositForTag(store, normalizedTag) {
  if (!normalizedTag) return null;
  return await store.findActiveDepositByPaymentTag(normalizedTag);
}

async function expiredDepositForTag(store, normalizedTag) {
  if (!normalizedTag) return null;
  return await store.findLatestExpiredDepositByPaymentTag(normalizedTag);
}

async function syncTeleledger(store, payment, { disposition, parsed, contact }) {
  if (!isTeleledgerConfigured()) {
    await store.logPaymentRouting(payment.id, 'teleledger_skipped', 'TeleLedger integration not configured.', { disposition });
    return { skipped: true, teleledgerPaymentId: null };
  }

  const result = await forwardPaymentToTeleledger({
    idempotencyKey: payment.idempotency_key,
    telegramChatId: payment.telegram_group_id,
    telegramMessageId: payment.telegram_message_id,
    senderId: payment.sender_id,
    senderName: payment.sender_name,
    rawText: payment.message_text,
    receivedAt: payment.message_date,
    disposition,
    parsed,
    linkedContactId: contact?.id || null,
    linkedPlayerLabel: contact?.display_name || contact?.payment_tag || null
  });

  return {
    skipped: false,
    teleledgerPaymentId: result?.payment_event_id ?? result?.paymentEventId ?? null
  };
}

export async function routePaymentEvent(store, paymentId) {
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) {
    return { ok: false, error: 'Payment event not found.' };
  }

  if (isAlreadyRouted(payment)) {
    await store.logPaymentRouting(payment.id, 'duplicate_ignored', 'Payment already routed; idempotency guard applied.', {
      routingStatus: payment.routing_status,
      idempotencyKey: payment.idempotency_key
    });
    if (payment.routing_status !== ROUTING_STATUS.DUPLICATE_IGNORED) {
      await store.updatePaymentRouting(payment.id, { routing_status: ROUTING_STATUS.DUPLICATE_IGNORED });
    }
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.DUPLICATE_IGNORED };
  }

  const idempotencyKey = payment.idempotency_key || buildIdempotencyKey(payment.telegram_group_id, payment.telegram_message_id);
  await store.ensurePaymentIdempotencyKey(payment.id, idempotencyKey);

  const parsed = parsePaymentMessage(payment.message_text);
  if (!parsed) {
    await store.applyPaymentParseResult(payment.id, null, { parseError: 'Parser did not match payment notification format.' });
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.PARSE_FAILED,
      routing_owner: ROUTING_OWNER.APPBEG,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'parse_failed', 'Payment message could not be parsed.');
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.PARSE_FAILED };
  }

  await store.applyPaymentParseResult(payment.id, parsed);
  const normalizedTag = normalizePaymentTag(parsed.recipient_tag);
  const player = await findRegisteredPlayerByTag(store, normalizedTag);
  const activeDeposit = await activeDepositForTag(store, normalizedTag);

  if (activeDeposit && player && activeDeposit.contact_id === player.id) {
    const sync = await syncTeleledger(store, payment, {
      disposition: 'appbeg_claimed',
      parsed,
      contact: player
    }).catch(async (error) => {
      await store.logPaymentRouting(payment.id, 'teleledger_error', error.message, { disposition: 'appbeg_claimed' });
      throw error;
    });

    await store.completeDepositEvent(activeDeposit.id, { reason: 'payment_received', paymentEventId: payment.id });
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.APPBEG_OWNED,
      routing_owner: ROUTING_OWNER.APPBEG,
      contact_id: player.id,
      deposit_event_id: activeDeposit.id,
      teleledger_payment_id: sync.teleledgerPaymentId,
      teleledger_sync_status: sync.skipped ? 'skipped' : 'synced',
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'appbeg_owned', 'Payment matched active AppBeg deposit and was claimed by AppBegBot.', {
      contactId: player.id,
      depositEventId: activeDeposit.id,
      teleledgerPaymentId: sync.teleledgerPaymentId
    });
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.APPBEG_OWNED };
  }

  const expiredDeposit = await expiredDepositForTag(store, normalizedTag);
  if (player && expiredDeposit && expiredDeposit.contact_id === player.id) {
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.EXPIRED_DEPOSIT,
      routing_owner: ROUTING_OWNER.APPBEG,
      contact_id: player.id,
      deposit_event_id: expiredDeposit.id,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'expired_deposit', 'Payment tag matched a player but the deposit window expired.', {
      contactId: player.id,
      depositEventId: expiredDeposit.id
    });
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.EXPIRED_DEPOSIT };
  }

  try {
    const sync = await syncTeleledger(store, payment, {
      disposition: 'staff_pending',
      parsed,
      contact: player
    });

    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.NOT_OUR_APPBEG,
      routing_owner: ROUTING_OWNER.TELELEDGER,
      contact_id: player?.id || null,
      teleledger_payment_id: sync.teleledgerPaymentId,
      teleledger_sync_status: sync.skipped ? 'skipped' : 'synced',
      routed_at: new Date().toISOString(),
      handled_by: null
    });
    await store.logPaymentRouting(payment.id, 'not_our_appbeg', 'Payment forwarded to TeleLedger staff pending queue.', {
      contactId: player?.id || null,
      teleledgerPaymentId: sync.teleledgerPaymentId
    });
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.NOT_OUR_APPBEG };
  } catch (error) {
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.ROUTE_FAILED,
      routing_owner: ROUTING_OWNER.APPBEG,
      routed_at: new Date().toISOString()
    });
    await store.logPaymentRouting(payment.id, 'route_failed', error.message, { disposition: 'staff_pending' });
    return { ok: false, payment: await store.getPaymentEvent(payment.id), error: error.message, outcome: ROUTING_STATUS.ROUTE_FAILED };
  }
}

export async function routeUnprocessedPayments(store, { limit = 50 } = {}) {
  const pending = await store.listUnroutedPaymentEvents(limit);
  const results = [];
  for (const payment of pending) {
    results.push(await routePaymentEvent(store, payment.id));
  }
  return results;
}

export async function startDepositEventForContact(store, { contactId, startedBy = 'Staff', notes = '' }) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Contact not found.');

  const info = (await store.getAutomationState(contactId))?.registration_info || {};
  const paymentTag = info.payment_tag;
  if (!paymentTag) {
    throw new Error('Contact does not have a registered payment tag.');
  }

  const normalizedTag = normalizePaymentTag(paymentTag);
  const existing = await store.findActiveDepositByPaymentTag(normalizedTag);
  if (existing) {
    throw new Error('An active deposit is already in progress for this payment tag.');
  }

  return await store.createDepositEvent({
    contactId,
    paymentTag,
    paymentTagNormalized: normalizedTag,
    startedBy,
    notes
  });
}

export { DEPOSIT_STATUS, ROUTING_STATUS };
