import { parsePaymentMessage } from './parser.js';
import {
  buildIdempotencyKey,
  DEPOSIT_STATUS,
  HANDLED_BY_APPBEG_BOT,
  PAYMENT_WINDOW_FLOW,
  ROUTING_OWNER,
  ROUTING_REASON,
  ROUTING_STATUS,
  UNMATCHED_REASON
} from './constants.js';
import {
  classifyUnmatchedReason,
  findMatchingActivePaymentWindow,
  isDepositWindow,
  isRegistrationWindow
} from './paymentWindowMatcher.js';
import { continueBotRegistrationAfterPayment } from './registrationPaymentFlow.js';
import { continueRegisteredDepositAfterPayment } from './depositPaymentFlow.js';

function isAlreadyRouted(payment) {
  return Boolean(payment.routed_at);
}

async function freezePayment(store, payment, {
  reason,
  unmatchedReason,
  contactId = null,
  windowId = null,
  metadata = {}
}) {
  console.log(`[payment-router] payment_frozen_manual_review payment=${payment.id} reason=${unmatchedReason || 'manual_review'}`);
  await store.updatePaymentRouting(payment.id, {
    routing_status: ROUTING_STATUS.MANUAL_REVIEW,
    routing_owner: ROUTING_OWNER.APPBEG,
    routing_reason: reason,
    contact_id: contactId,
    registration_payment_window_id: windowId,
    routed_at: new Date().toISOString(),
    handled_by: null
  });
  await store.logPaymentRouting(payment.id, 'payment_frozen_manual_review', reason, {
    unmatchedReason,
    status: 'frozen',
    ...metadata
  });
  return { ok: true, payment: await store.getPaymentEvent(payment.id), outcome: ROUTING_STATUS.MANUAL_REVIEW, unmatchedReason };
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

  console.log(`[payment-router] payment_window_checked payment=${payment.id}`);
  await store.logPaymentRouting(payment.id, 'payment_window_checked', 'Checking active payment windows (registration + deposit).', {
    amount: parsed.amount,
    paymentApp: parsed.payment_app,
    senderName: parsed.payment_sender_name
  });

  const activeWindows = await store.listActiveRegistrationPaymentWindows();
  const match = findMatchingActivePaymentWindow(activeWindows, parsed);

  if (match.result === 'ambiguous_match') {
    return freezePayment(store, payment, {
      reason: ROUTING_REASON.AMBIGUOUS_MATCH,
      unmatchedReason: UNMATCHED_REASON.AMBIGUOUS_MATCH,
      metadata: {
        amount: parsed.amount,
        paymentApp: parsed.payment_app,
        senderName: parsed.payment_sender_name,
        matchCount: match.windows.length,
        windowIds: match.windows.map((item) => item.id),
        flowTypes: match.windows.map((item) => item.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION)
      }
    });
  }

  if (match.result === 'exact_match') {
    const activeWindow = match.window;
    const claim = typeof store.claimPaymentWindowMatch === 'function'
      ? await store.claimPaymentWindowMatch(activeWindow.id, payment.id)
      : { ok: true, reason: 'matched', window: activeWindow };

    if (!claim.ok) {
      return freezePayment(store, payment, {
        reason: `Payment window claim failed (${claim.reason}).`,
        unmatchedReason: UNMATCHED_REASON.AMBIGUOUS_MATCH,
        metadata: {
          windowId: activeWindow.id,
          claimReason: claim.reason
        }
      });
    }

    const flowType = activeWindow.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION;
    const isDeposit = isDepositWindow(activeWindow);
    const routingStatus = isDeposit
      ? ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED
      : ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED;
    const routingReason = isDeposit
      ? ROUTING_REASON.MATCHED_DEPOSIT_WINDOW
      : ROUTING_REASON.MATCHED_REGISTRATION_WINDOW;

    console.log(
      `[payment-router] payment_window_matched payment=${payment.id} window=${activeWindow.id} ` +
      `flow=${flowType} contact=${activeWindow.contact_id}`
    );

    await store.updatePaymentRouting(payment.id, {
      routing_status: routingStatus,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: routingReason,
      contact_id: activeWindow.contact_id,
      registration_payment_window_id: activeWindow.id,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'payment_window_matched', `Payment matched an active ${flowType} payment window.`, {
      contactId: activeWindow.contact_id,
      windowId: activeWindow.id,
      flowType,
      claimReason: claim.reason
    });

    if (isDeposit) {
      await continueRegisteredDepositAfterPayment(store, {
        contactId: activeWindow.contact_id,
        windowId: activeWindow.id,
        paymentEventId: payment.id,
        bot,
        io
      });
      return {
        ok: true,
        payment: await store.getPaymentEvent(payment.id),
        outcome: routingStatus,
        flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
      };
    }

    await continueBotRegistrationAfterPayment(store, {
      contactId: activeWindow.contact_id,
      windowId: activeWindow.id,
      paymentEventId: payment.id,
      bot,
      io,
      alreadyClaimed: true
    });

    return {
      ok: true,
      payment: await store.getPaymentEvent(payment.id),
      outcome: routingStatus,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION
    };
  }

  const expiredWindows = await store.listExpiredRegistrationPaymentWindowsForMatch();
  const expiredMatch = findMatchingActivePaymentWindow(expiredWindows, parsed);
  if (expiredMatch.result === 'exact_match' || expiredMatch.result === 'ambiguous_match') {
    const expiredWindow = expiredMatch.window || expiredMatch.windows?.[0] || null;
    const unmatchedReason = UNMATCHED_REASON.WINDOW_EXPIRED;
    console.log(`[payment-router] payment_window_expired_match payment=${payment.id} window=${expiredWindow?.id || 'n/a'}`);
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.EXPIRED_DEPOSIT,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: isDepositWindow(expiredWindow)
        ? ROUTING_REASON.DEPOSIT_WINDOW_EXPIRED
        : ROUTING_REASON.REGISTRATION_WINDOW_EXPIRED,
      contact_id: expiredWindow?.contact_id || null,
      registration_payment_window_id: expiredWindow?.id || null,
      routed_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT
    });
    await store.logPaymentRouting(payment.id, 'payment_window_expired_match', 'Payment matched a window but the window had expired.', {
      contactId: expiredWindow?.contact_id || null,
      windowId: expiredWindow?.id || null,
      unmatchedReason,
      flowType: expiredWindow?.flow_type || null,
      status: 'frozen'
    });
    return {
      ok: true,
      payment: await store.getPaymentEvent(payment.id),
      outcome: ROUTING_STATUS.EXPIRED_DEPOSIT,
      unmatchedReason
    };
  }

  const unmatchedReason = classifyUnmatchedReason({
    activeWindows,
    expiredWindows,
    parsed
  });

  return freezePayment(store, payment, {
    reason: ROUTING_REASON.NO_ACTIVE_WINDOW,
    unmatchedReason,
    metadata: {
      amount: parsed.amount,
      paymentApp: parsed.payment_app,
      senderName: parsed.payment_sender_name
    }
  });
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

  const window = await store.getRegistrationPaymentWindow(registrationPaymentWindowId);
  await store.manuallyLinkPaymentEvent(paymentId, {
    contactId,
    registrationPaymentWindowId,
    staffName,
    routingStatus: isDepositWindow(window)
      ? ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED
      : ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
    routingReason: isDepositWindow(window)
      ? ROUTING_REASON.MATCHED_DEPOSIT_WINDOW
      : ROUTING_REASON.MATCHED_REGISTRATION_WINDOW
  });

  if (isDepositWindow(window)) {
    await continueRegisteredDepositAfterPayment(store, {
      contactId,
      windowId: registrationPaymentWindowId,
      paymentEventId: paymentId,
      actorName: staffName,
      bot,
      io
    });
  } else {
    await continueBotRegistrationAfterPayment(store, {
      contactId,
      windowId: registrationPaymentWindowId,
      paymentEventId: paymentId,
      actorName: staffName,
      bot,
      io
    });
  }

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

export { DEPOSIT_STATUS, ROUTING_STATUS, isRegistrationWindow, isDepositWindow };
