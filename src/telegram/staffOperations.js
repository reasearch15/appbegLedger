import { OPERATIONAL_ROLES, canManageStaff, canOperatePayments, canToggleConfidenceMode, normalizeTelegramUserId } from './operationalRoles.js';
import { CONFIDENCE } from '../payments/confidenceEngine.js';
import { ROUTING_STATUS } from '../payments/constants.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { queueBotReply } from './chatbotProcessor.js';
import { FREEPLAY_ISSUANCE_BLOCKER, FREEPLAY_DECISION, FREEPLAY_ISSUANCE_STATUS, buildFreeplayIdempotencyKey, issueAppBegFreeplay } from '../appbeg/freeplayIssuanceClient.js';
import {
  STAFF_CB,
  isStaffCallback,
  controlCenterText,
  controlCenterButtons as buildControlCenterButtons,
  paymentCardText,
  paymentCardButtons,
  freeplayCardText,
  freeplayCardButtons
} from './staffCards.js';

export {
  STAFF_CB,
  isStaffCallback,
  controlCenterText,
  paymentCardText,
  paymentCardButtons,
  freeplayCardText,
  freeplayCardButtons
};

export function controlCenterButtons(role) {
  return buildControlCenterButtons(role, {
    canToggle: canToggleConfidenceMode(role),
    canManage: canManageStaff(role)
  });
}

const CREDITED_STATUSES = new Set([
  ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
  ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT,
  ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
  ROUTING_STATUS.APPBEG_OWNED
]);

export async function requireOperationalRole(store, telegramUserId, predicate = canOperatePayments) {
  const userId = normalizeTelegramUserId(telegramUserId);
  const role = userId ? await store.getActiveOperationalRole(userId) : null;
  if (!role || !predicate(role.role)) {
    const error = new Error('Not authorized.');
    error.code = 'FORBIDDEN';
    throw error;
  }
  return role;
}

async function creditAssignedPayment(store, payment, window, actorTelegramUserId) {
  const recipientId = Number(window.recipient_contact_id || window.contact_id);
  try {
    const result = await store.creditRegisteredDeposit({
      contactId: recipientId,
      amount: payment.parsed_amount,
      paymentEventId: payment.id,
      windowId: window.id,
      actorName: String(actorTelegramUserId),
      flowType: window.flow_type === PAYMENT_WINDOW_FLOW.REGISTRATION
        ? PAYMENT_WINDOW_FLOW.REGISTRATION
        : PAYMENT_WINDOW_FLOW.DEPOSIT,
      playerUid: window.recipient_player_uid
    });
    await store.recordPaymentDecision?.({
      paymentEventId: payment.id,
      paymentIdentityId: payment.payment_identity_id || null,
      payerContactId: window.requester_contact_id || window.contact_id,
      recipientContactId: recipientId,
      windowId: window.id,
      classification: payment.confidence_classification || 'staff_manual',
      evidence: ['staff_confirmed'],
      confidenceModeOn: Boolean((await store.getConfidenceMode?.())?.enabled),
      decisionType: 'staff_credit',
      actorTelegramUserId: String(actorTelegramUserId),
      appbegStatus: 'credited'
    });
    return { ok: true, result };
  } catch (error) {
    if (/already_credited|already credited/i.test(String(error.message || error))) {
      return { ok: true, alreadyCredited: true };
    }
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.CREDIT_FAILED,
      routing_reason: String(error.message || error).slice(0, 400),
      credit_failed_at: new Date().toISOString(),
      credit_failed_error: String(error.message || error).slice(0, 500)
    });
    await store.recordPaymentDecision?.({
      paymentEventId: payment.id,
      payerContactId: window.requester_contact_id || window.contact_id,
      recipientContactId: recipientId,
      windowId: window.id,
      classification: payment.confidence_classification || 'staff_manual',
      evidence: ['credit_failed'],
      confidenceModeOn: Boolean((await store.getConfidenceMode?.())?.enabled),
      decisionType: 'staff_credit_failed',
      actorTelegramUserId: String(actorTelegramUserId),
      appbegStatus: 'failed'
    });
    return { ok: false, creditFailed: true, error };
  }
}

export async function staffAssignAndCredit(store, {
  paymentId,
  recipientContactId,
  payerContactId = null,
  actorTelegramUserId
}) {
  await requireOperationalRole(store, actorTelegramUserId);
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) throw new Error('Payment not found.');
  if (CREDITED_STATUSES.has(payment.routing_status)) {
    const error = new Error('Payment has already been credited.');
    error.code = 'ALREADY_CREDITED';
    throw error;
  }
  const recipientId = Number(recipientContactId);
  const recipient = await store.getUserProfile(recipientId);
  if (!recipient || recipient.registration_status !== 'Registered') {
    const error = new Error('Recipient must be a registered Royal VIP player.');
    error.code = 'INVALID_RECIPIENT';
    throw error;
  }
  const payerId = Number(payerContactId || payment.payer_contact_id || recipientId);
  let window = null;
  if (payment.registration_payment_window_id) {
    window = await store.getRegistrationPaymentWindow(payment.registration_payment_window_id);
  }
  if (!window || (window.status !== 'matched' && window.status_raw !== 'completed')) {
    window = await store.findActiveDepositWindowForAssignment?.({
      recipientContactId: recipientId,
      payerContactId: payerId
    });
    if (!window) {
      window = await store.createStaffAssignmentWindow({
        payerContactId: payerId,
        recipientContactId: recipientId,
        actorTelegramUserId
      });
    }
    const claim = await store.claimPaymentWindowMatch(window.id, payment.id);
    if (!claim.ok && claim.reason !== 'already_matched') {
      const error = new Error(`Could not assign payment (${claim.reason}).`);
      error.code = 'CLAIM_FAILED';
      throw error;
    }
    window = claim.window || await store.getRegistrationPaymentWindow(window.id);
  }
  const identity = payment.parsed_sender_name
    ? await store.ensurePaymentIdentity(payment.parsed_sender_name)
    : null;
  if (identity) {
    await store.recordPaymentIdentityEvidence?.({
      paymentIdentityId: identity.id,
      contactId: payerId,
      evidenceKind: 'staff_confirmed',
      paymentEventId: payment.id,
      actorTelegramUserId: String(actorTelegramUserId),
      relationship: 'payer'
    });
  }
  await store.updatePaymentRouting(payment.id, {
    payer_contact_id: payerId,
    recipient_contact_id: recipientId,
    payment_identity_id: identity?.id || payment.payment_identity_id || null
  }).catch(() => null);
  return creditAssignedPayment(store, payment, window, actorTelegramUserId);
}

export async function staffCreditSuggested(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) throw new Error('Payment not found.');
  if (CREDITED_STATUSES.has(payment.routing_status)) {
    const error = new Error('Payment has already been credited.');
    error.code = 'ALREADY_CREDITED';
    throw error;
  }
  const recipientId = Number(payment.recipient_contact_id);
  if (!Number.isInteger(recipientId) || recipientId <= 0) {
    const error = new Error('No suggested recipient. Assign a player first.');
    error.code = 'NEED_ASSIGN';
    throw error;
  }
  return staffAssignAndCredit(store, {
    paymentId,
    recipientContactId: recipientId,
    payerContactId: payment.payer_contact_id,
    actorTelegramUserId
  });
}

export async function staffAskPlayer(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) throw new Error('Payment not found.');
  const targetId = Number(payment.payer_contact_id || payment.recipient_contact_id || payment.contact_id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    const error = new Error('No player is linked to this payment yet.');
    error.code = 'NO_PLAYER';
    throw error;
  }
  const contact = await store.getUserProfile(targetId);
  if (!contact) throw new Error('Player not found.');
  const amount = payment.parsed_amount != null ? `$${Number(payment.parsed_amount).toFixed(2)}` : 'a payment';
  await queueBotReply({
    store,
    user: contact,
    text: `Is this your payment?\n\nPayment Name: ${payment.parsed_sender_name || 'Unknown'}\nAmount: ${amount}`,
    buttons: [],
    bot: globalThis.telegramBot || null
  });
  return { ok: true, contactId: contact.id };
}

export async function staffMessagePlayer(store, contactId, text, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Player not found.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Message is empty.');
  await store.storeOutgoingMessage?.({
    telegramUserId: contact.id,
    userId: contact.id,
    text: body,
    senderType: 'staff',
    staffName: String(actorTelegramUserId)
  }).catch(() => null);
  try {
    await queueBotReply({
      store,
      user: contact,
      text: body,
      buttons: [],
      bot: globalThis.telegramBot || null
    });
  } catch (error) {
    return { ok: true, delivered: false, error };
  }
  return { ok: true, delivered: true };
}

export async function staffFreezePayment(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  return store.markPaymentFrozenByStaff(paymentId, {
    staffName: String(actorTelegramUserId),
    unmatchedReason: 'staff_hold'
  });
}

export async function staffUnfreezePayment(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const now = new Date().toISOString();
  await store.updatePaymentRouting(paymentId, {
    routing_status: ROUTING_STATUS.NEEDS_CONFIRMATION,
    routing_reason: 'Unfrozen by staff',
    frozen_at: null,
    handled_by: String(actorTelegramUserId),
    unmatched_reason: 'staff_review_requested'
  });
  await store.logPaymentRouting?.(paymentId, 'payment_unfrozen_staff', 'Payment unfrozen by staff.', {
    actorTelegramUserId
  });
  return store.getPaymentEvent(paymentId);
}

export async function staffRetryCredit(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment?.registration_payment_window_id) {
    throw new Error('Payment is not assigned to a window.');
  }
  const window = await store.getRegistrationPaymentWindow(payment.registration_payment_window_id);
  const recipientId = Number(window?.recipient_contact_id || payment.recipient_contact_id || payment.contact_id);
  return store.creditRegisteredDeposit({
    contactId: recipientId,
    amount: payment.parsed_amount,
    paymentEventId: payment.id,
    windowId: window.id,
    actorName: String(actorTelegramUserId),
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    playerUid: window.recipient_player_uid
  });
}

export async function resolveFreeplayGive(store, requestId, amount, actorTelegramUserId, actorName, { issuer = issueAppBegFreeplay } = {}) {
  await requireOperationalRole(store, actorTelegramUserId);
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    const error = new Error('Enter a valid Freeplay amount.');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }
  const claimed = await store.claimFreeplayDecision({
    requestId,
    decision: FREEPLAY_DECISION.APPROVED,
    amount: parsedAmount,
    actorTelegramUserId,
    actorName
  });
  if (!claimed.ok) return claimed;
  return attemptFreeplayIssuance(store, requestId, parsedAmount, { issuer, recoverIssuing: false });
}

export async function retryFreeplayIssuance(store, requestId, actorTelegramUserId, { issuer = issueAppBegFreeplay } = {}) {
  await requireOperationalRole(store, actorTelegramUserId);
  const request = await store.db.prepare('SELECT * FROM support_requests WHERE id = ?').get(requestId);
  if (!request || request.kind !== 'freeplay') {
    return { ok: false, reason: 'not_found', request: request || null };
  }
  if (request.decision === FREEPLAY_DECISION.GIVEN) {
    return { ok: false, reason: 'already_issued', request, idempotencyKey: buildFreeplayIdempotencyKey(requestId) };
  }
  if (request.decision !== FREEPLAY_DECISION.APPROVED) {
    return { ok: false, reason: 'not_approved', request };
  }
  const parsedAmount = Number(request.decided_amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    const error = new Error('Enter a valid Freeplay amount.');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }
  return attemptFreeplayIssuance(store, requestId, parsedAmount, { issuer, recoverIssuing: true });
}

async function attemptFreeplayIssuance(store, requestId, amount, { issuer, recoverIssuing }) {
  const idempotencyKey = buildFreeplayIdempotencyKey(requestId);
  const began = await store.beginFreeplayIssuance(requestId, { recoverIssuing });
  if (!began.ok) {
    return { ...began, issuanceBlocked: began.request?.decision !== FREEPLAY_DECISION.GIVEN, issued: began.request?.decision === FREEPLAY_DECISION.GIVEN, idempotencyKey };
  }
  try {
    await issuer({
      requestId,
      amount,
      idempotencyKey
    });
  } catch (error) {
    const issuanceStatus = error.code === FREEPLAY_ISSUANCE_BLOCKER
      ? FREEPLAY_ISSUANCE_STATUS.UNAVAILABLE
      : FREEPLAY_ISSUANCE_STATUS.FAILED;
    const request = await store.updateFreeplayIssuance(requestId, {
      issuanceStatus,
      issuanceError: String(error.message || error).slice(0, 500)
    });
    return {
      ok: true,
      request,
      issued: false,
      issuanceBlocked: true,
      idempotencyKey,
      error
    };
  }
  const given = await store.markFreeplayGiven(requestId);
  return {
    ok: given.ok,
    request: given.request,
    issued: given.ok,
    issuanceBlocked: false,
    idempotencyKey,
    reason: given.ok ? undefined : given.reason
  };
}

export async function resolveFreeplayDecline(store, requestId, actorTelegramUserId, actorName) {
  await requireOperationalRole(store, actorTelegramUserId);
  return store.claimFreeplayDecision({
    requestId,
    decision: 'declined',
    actorTelegramUserId,
    actorName
  });
}

export async function mirrorPlayerMessageToStaffTopic({ store, bot, contact, text }) {
  const persisted = true;
  const groupId = process.env.STAFF_TELEGRAM_GROUP_ID;
  if (!groupId || !bot?.telegram) {
    return { persisted, mirrored: false, reason: 'staff_group_unconfigured' };
  }
  try {
    let topic = await store.getStaffTopicForContact(contact.id);
    if (!topic) {
      const created = await bot.telegram.createForumTopic(groupId, `👤 ${contact.display_name || contact.username || contact.id}`);
      topic = await store.upsertStaffTopic({
        contactId: contact.id,
        telegramUserId: contact.telegram_id,
        staffGroupId: groupId,
        messageThreadId: created.message_thread_id,
        topicName: created.name
      });
    }
    await bot.telegram.sendMessage(groupId, `${contact.display_name || 'Player'}:\n${text}`, {
      message_thread_id: topic.message_thread_id
    });
    return { persisted, mirrored: true, topic };
  } catch (error) {
    await store.markStaffTopicError?.(contact.id, error.message).catch(() => null);
    import('./operationalAlerts.js').then(({ notifyStaffDeliveryFailure }) => (
      notifyStaffDeliveryFailure(store, {
        bot,
        context: `Staff topic mirror failed for contact ${contact.id}`,
        detail: error.message
      })
    )).catch(() => null);
    return { persisted, mirrored: false, reason: error.message };
  }
}

export { OPERATIONAL_ROLES, CONFIDENCE };
