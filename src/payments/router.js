import { parsePaymentMessage } from './parser.js';
import {
  buildIdempotencyKey,
  DEPOSIT_STATUS,
  HANDLED_BY_APPBEG_BOT,
  ROUTING_OWNER,
  ROUTING_REASON,
  ROUTING_STATUS
} from './constants.js';
import { amountsMatch, paymentAppsMatch, paymentNamesMatch } from './matchUtils.js';
import { findRegisteredPlayerMatch } from './registeredPlayerMatcher.js';
import { continueBotRegistrationAfterPayment } from './registrationPaymentFlow.js';

function isAlreadyRouted(payment) {
  return Boolean(payment.routed_at);
}

function windowMatchesParsed(window, parsed) {
  const paymentApp = window.payment_method_name || window.payment_method_key || '';
  if (!paymentAppsMatch(paymentApp, parsed.payment_app)) return false;
  if (!paymentNamesMatch(window.payment_display_name, parsed.payment_sender_name)) return false;
  if (!amountsMatch(window.first_deposit_amount, parsed.amount)) return false;
  return true;
}

async function findActiveRegistrationMatch(store, parsed) {
  const windows = await store.listActiveRegistrationPaymentWindows();
  return windows.find((window) => windowMatchesParsed(window, parsed)) || null;
}

async function findExpiredRegistrationMatch(store, parsed) {
  const windows = await store.listExpiredRegistrationPaymentWindowsForMatch();
  return windows.find((window) => windowMatchesParsed(window, parsed)) || null;
}

export async function routePaymentEvent(store, paymentId, { force = false, bot = null, io = null } = {}) {
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) {
    return { ok: false, error: 'Payment event not found.' };
  }

  if (!force && isAlreadyRouted(payment)) {
    console.log(`[payment-router] payment_message_duplicate_skipped payment=${payment.id}`);
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
    console.log(`[payment-router] payment_parse_failed payment=${payment.id}`);
    await store.applyPaymentParseResult(payment.id, null, { parseError: 'Parser did not match payment notification format.' });
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.PARSE_FAILED,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: ROUTING_REASON.UNABLE_TO_PARSE,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'payment_parse_failed', 'Payment message could not be parsed.');
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.PARSE_FAILED };
  }

  console.log(`[payment-router] payment_parse_success payment=${payment.id} amount=${parsed.amount} app=${parsed.payment_app || 'unknown'}`);
  await store.applyPaymentParseResult(payment.id, parsed);
  await store.logPaymentRouting(payment.id, 'payment_parse_success', 'Payment message parsed successfully.', {
    amount: parsed.amount,
    paymentApp: parsed.payment_app,
    senderName: parsed.payment_sender_name
  });

  console.log(`[payment-router] registered_player_checked payment=${payment.id}`);
  await store.logPaymentRouting(payment.id, 'registered_player_checked', 'Checking registered AppBeg players before registration windows.', {
    amount: parsed.amount,
    paymentApp: parsed.payment_app,
    senderName: parsed.payment_sender_name
  });

  const registeredPlayer = await findRegisteredPlayerMatch(store, parsed);
  if (registeredPlayer) {
    console.log(`[payment-router] registered_player_matched payment=${payment.id} contact=${registeredPlayer.id}`);
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: ROUTING_REASON.MATCHED_REGISTERED_PLAYER,
      contact_id: registeredPlayer.id,
      registration_payment_window_id: null,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'registered_player_matched', 'Payment matched a registered AppBeg player deposit profile.', {
      contactId: registeredPlayer.id,
      appbegUsername: registeredPlayer.appbeg_username || null,
      status: 'pending_review'
    });
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT };
  }

  console.log(`[payment-router] registration_window_checked payment=${payment.id}`);
  await store.logPaymentRouting(payment.id, 'registration_window_checked', 'No registered player match; checking active registration payment windows.', {
    amount: parsed.amount,
    paymentApp: parsed.payment_app,
    senderName: parsed.payment_sender_name
  });

  const activeWindow = await findActiveRegistrationMatch(store, parsed);
  if (activeWindow) {
    console.log(`[payment-router] registration_window_matched payment=${payment.id} window=${activeWindow.id} contact=${activeWindow.contact_id}`);
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: ROUTING_REASON.MATCHED_REGISTRATION_WINDOW,
      contact_id: activeWindow.contact_id,
      registration_payment_window_id: activeWindow.id,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'registration_window_matched', 'Payment matched an active registration payment window.', {
      contactId: activeWindow.contact_id,
      windowId: activeWindow.id
    });

    await continueBotRegistrationAfterPayment(store, {
      contactId: activeWindow.contact_id,
      windowId: activeWindow.id,
      paymentEventId: payment.id,
      bot,
      io
    });

    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED };
  }

  const expiredWindow = await findExpiredRegistrationMatch(store, parsed);
  if (expiredWindow) {
    console.log(`[payment-router] registration_payment_expired_match payment=${payment.id} window=${expiredWindow.id}`);
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.EXPIRED_DEPOSIT,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: ROUTING_REASON.REGISTRATION_WINDOW_EXPIRED,
      contact_id: expiredWindow.contact_id,
      registration_payment_window_id: expiredWindow.id,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'registration_payment_expired_match', 'Payment matched a registration window but the window had expired.', {
      contactId: expiredWindow.contact_id,
      windowId: expiredWindow.id
    });
    return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.EXPIRED_DEPOSIT };
  }

  const freezeReason = 'No registered player match and no active registration payment window.';
  console.log(`[payment-router] payment_frozen_manual_review payment=${payment.id}`);
  await store.updatePaymentRouting(payment.id, {
    routing_status: ROUTING_STATUS.MANUAL_REVIEW,
    routing_owner: ROUTING_OWNER.APPBEG,
    routing_reason: freezeReason,
    contact_id: null,
    registration_payment_window_id: null,
    routed_at: new Date().toISOString(),
    handled_by: null
  });
  await store.logPaymentRouting(payment.id, 'payment_frozen_manual_review', freezeReason, {
    amount: parsed.amount,
    paymentApp: parsed.payment_app,
    senderName: parsed.payment_sender_name,
    status: 'frozen'
  });
  return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.MANUAL_REVIEW };
}

export async function routeUnprocessedPayments(store, { limit = 50, bot = null, io = null } = {}) {
  const pending = await store.listUnroutedPaymentEvents(limit);
  const results = [];
  for (const payment of pending) {
    results.push(await routePaymentEvent(store, payment.id, { bot, io }));
  }
  return results;
}

export async function reprocessPaymentEvent(store, paymentId, { bot = null, io = null } = {}) {
  await store.resetPaymentRoutingForReprocess(paymentId);
  await store.logPaymentRouting(paymentId, 'reprocess_requested', 'Staff requested payment reprocessing.');
  return await routePaymentEvent(store, paymentId, { force: true, bot, io });
}

export async function markPaymentAppBegOwned(store, paymentId, { contactId, registrationPaymentWindowId, staffName = 'Staff', bot = null, io = null } = {}) {
  if (!contactId || !registrationPaymentWindowId) {
    throw new Error('contactId and registrationPaymentWindowId are required.');
  }

  await store.manuallyLinkPaymentEvent(paymentId, {
    contactId,
    registrationPaymentWindowId,
    staffName,
    routingStatus: ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
    routingReason: ROUTING_REASON.MATCHED_REGISTRATION_WINDOW
  });

  await continueBotRegistrationAfterPayment(store, {
    contactId,
    windowId: registrationPaymentWindowId,
    paymentEventId: paymentId,
    actorName: staffName,
    bot,
    io
  });

  return { ok: true, payment: await store.getPaymentEvent(paymentId) };
}

export async function startDepositEventForContact(store, { contactId, startedBy = 'Staff', notes = '' }) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Contact not found.');

  const info = (await store.getAutomationState(contactId))?.registration_info || {};
  const paymentTag = info.payment_tag;
  if (!paymentTag) {
    throw new Error('Contact does not have a registered payment tag.');
  }

  const normalizedTag = String(paymentTag).trim().toLowerCase();
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
