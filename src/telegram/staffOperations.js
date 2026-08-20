import { OPERATIONAL_ROLES, canManageHub, canManageStaff, canOperatePayments, canToggleConfidenceMode, normalizeTelegramUserId, staffGroupIdFromEnv, isRoyalVipHubChat } from './operationalRoles.js';
import { CONFIDENCE } from '../payments/confidenceEngine.js';
import { ROUTING_STATUS } from '../payments/constants.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { isTopicClosedError } from './telegramApiErrors.js';
import { notifyStaffDeliveryFailure, notifyStaffNewSupportConversation } from './operationalAlerts.js';
import {
  extractSupportedInboundMedia,
  formatPlayerFacingStaffReply,
  formatPlayerInboundForStaff,
  newSupportNeedsStaffPing,
  staffTopicTitleForContact,
  unsupportedInboundMediaLabel
} from './playerSupportMessaging.js';
import { queueBotReply } from './chatbotProcessorDelivery.js';
import { deliverPlayerFacingHubNotice, HUB_CHANNEL_DM_SOURCE } from './hubDirectMessages.js';
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
    canManage: canManageStaff(role),
    canManageHub: canManageHub(role)
  });
}

const CREDITED_STATUSES = new Set([
  ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
  ROUTING_STATUS.REGISTERED_PLAYER_DEPOSIT,
  ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED,
  ROUTING_STATUS.APPBEG_OWNED
]);

function knownContactId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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
      payerContactId: knownContactId(window.requester_contact_id),
      recipientContactId: recipientId,
      windowId: window.id,
      classification: payment.confidence_classification || 'staff_manual',
      evidence: ['staff_confirmed'],
      confidenceModeOn: Boolean((await store.getConfidenceMode?.())?.enabled),
      decisionType: 'staff_credit',
      actorTelegramUserId: String(actorTelegramUserId),
      appbegStatus: 'credited'
    });
    const recipient = await store.getUserProfile(recipientId).catch(() => null);
    if (recipient) {
      const username = recipient.royal_vip_username
        || recipient.registration_info?.preferred_appbeg_username
        || recipient.registration_info?.appbeg_username
        || '';
      await deliverPlayerNotice({
        store,
        bot: globalThis.telegramBot || null,
        contact: recipient,
        text: `✅ $${Number(payment.parsed_amount).toFixed(2)} has been credited${username ? ` to ${username}` : ''}.`
      }).catch(() => null);
      await postPlayerTopicSystemEvent({
        store,
        bot: globalThis.telegramBot || null,
        contact: recipient,
        text: `Payment manually credited: $${Number(payment.parsed_amount).toFixed(2)}`
      }).catch(() => null);
    }
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
      payerContactId: knownContactId(window.requester_contact_id),
      recipientContactId: recipientId,
      windowId: window.id,
      classification: payment.confidence_classification || 'staff_manual',
      evidence: ['credit_failed'],
      confidenceModeOn: Boolean((await store.getConfidenceMode?.())?.enabled),
      decisionType: 'staff_credit_failed',
      actorTelegramUserId: String(actorTelegramUserId),
      appbegStatus: 'failed'
    });
    const recipient = await store.getUserProfile(recipientId).catch(() => null);
    if (recipient) {
      await deliverPlayerNotice({
        store,
        bot: globalThis.telegramBot || null,
        contact: recipient,
        text: 'Payment credit failed. Staff will retry.'
      }).catch(() => null);
      await postPlayerTopicSystemEvent({
        store,
        bot: globalThis.telegramBot || null,
        contact: recipient,
        text: 'Payment credit failed. Staff will retry.'
      }).catch(() => null);
    }
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
  const payerId = knownContactId(payerContactId) || knownContactId(payment.payer_contact_id);
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
  if (identity && payerId) {
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

export async function staffAskPlayer(store, paymentId, actorTelegramUserId, { bot = null } = {}) {
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
  const playerText = `Is this your payment?\n\nPayment Name: ${payment.parsed_sender_name || 'Unknown'}\nAmount: ${amount}`;
  const telegramBot = bot || globalThis.telegramBot || null;
  const nativeTopic = await store.getChannelDmTopicForContact?.(contact.id).catch(() => null);
  if (!nativeTopic) {
    await ensureStaffTopicForContact({ store, bot: telegramBot, contact }).catch(() => null);
    await postPlayerTopicSystemEvent({
      store,
      bot: telegramBot,
      contact,
      text: 'Staff asked the player: Is this your payment?'
    }).catch(() => null);
  }
  await deliverPlayerNotice({
    store,
    bot: telegramBot,
    contact,
    text: playerText
  });
  await store.updateConversationStatus?.(contact.id, 'Waiting', String(actorTelegramUserId)).catch(() => null);
  return { ok: true, contactId: contact.id, via: nativeTopic ? 'native_hub_dm' : 'fallback' };
}

export async function staffMessagePlayer(store, contactId, text, actorTelegramUserId, { bot = null } = {}) {
  await requireOperationalRole(store, actorTelegramUserId);
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Player not found.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Message is empty.');
  return deliverStaffReplyToPlayer({
    store,
    bot: bot || globalThis.telegramBot || null,
    contact,
    text: body,
    actorName: String(actorTelegramUserId)
  });
}

export async function staffFreezePayment(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  return store.markPaymentFrozenByStaff(paymentId, {
    staffName: String(actorTelegramUserId),
    unmatchedReason: 'staff_hold'
  });
}

export async function staffIgnorePayment(store, paymentId, actorTelegramUserId) {
  await requireOperationalRole(store, actorTelegramUserId);
  const payment = await store.getPaymentEvent(paymentId);
  if (!payment) throw new Error('Payment not found.');
  if (CREDITED_STATUSES.has(payment.routing_status)) {
    const error = new Error('Payment has already been credited.');
    error.code = 'ALREADY_CREDITED';
    throw error;
  }
  if (payment.routing_status === 'ignored' || payment.routing_status === 'duplicate_ignored') {
    return { ok: true, alreadyIgnored: true, payment };
  }
  const updated = await store.markPaymentIgnored(paymentId, {
    staffName: String(actorTelegramUserId),
    unmatchedReason: 'not_a_deposit_credit_event'
  });
  return { ok: true, alreadyIgnored: false, payment: updated };
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

async function sendIntoStaffTopic({ telegram, groupId, threadId, body, media = null, sourceChatId = null, sourceMessageId = null }) {
  await telegram.sendMessage(groupId, body, { message_thread_id: threadId });
  if (!media?.fileId) return;
  try {
    if (sourceChatId && sourceMessageId && typeof telegram.copyMessage === 'function') {
      await telegram.copyMessage(groupId, sourceChatId, sourceMessageId, { message_thread_id: threadId });
      return;
    }
    if (media.kind === 'photo' && typeof telegram.sendPhoto === 'function') {
      await telegram.sendPhoto(groupId, media.fileId, { message_thread_id: threadId });
      return;
    }
    if (media.kind === 'document' && typeof telegram.sendDocument === 'function') {
      await telegram.sendDocument(groupId, media.fileId, { message_thread_id: threadId });
    }
  } catch (error) {
    console.warn('[staff-topic] media_forward_failed', error.message);
  }
}

async function sendOrReopenStaffTopic({
  store,
  bot,
  contact,
  groupId,
  topic,
  body,
  media = null,
  sourceChatId = null,
  sourceMessageId = null,
  fallbackDetail = ''
}) {
  const telegram = bot.telegram;
  try {
    await sendIntoStaffTopic({
      telegram,
      groupId,
      threadId: topic.message_thread_id,
      body,
      media,
      sourceChatId,
      sourceMessageId
    });
    return { ok: true, reopened: false, topic };
  } catch (sendError) {
    if (!isTopicClosedError(sendError)) throw sendError;
    try {
      await telegram.reopenForumTopic(groupId, topic.message_thread_id);
    } catch (reopenError) {
      await store.markStaffTopicError?.(contact.id, reopenError.message).catch(() => null);
      await notifyStaffDeliveryFailure(store, {
        bot,
        context: `Closed staff topic could not be reopened for contact ${contact.id}`,
        detail: String(fallbackDetail || body || '').slice(0, 400)
      }).catch(() => null);
      return {
        ok: false,
        reason: 'reopen_failed',
        error: reopenError.message,
        topic
      };
    }
    await sendIntoStaffTopic({
      telegram,
      groupId,
      threadId: topic.message_thread_id,
      body,
      media,
      sourceChatId,
      sourceMessageId
    });
    return { ok: true, reopened: true, topic };
  }
}

export async function ensureStaffTopicForContact({ store, bot, contact }) {
  const groupId = staffGroupIdFromEnv();
  if (!groupId || !bot?.telegram) {
    return { ok: false, reason: 'staff_group_unconfigured', created: false };
  }
  if (isRoyalVipHubChat(groupId)) {
    console.warn('[staff-topic] refused_hub_target');
    return { ok: false, reason: 'refused_hub_target', created: false };
  }
  let enriched = contact;
  if (!contact?.registration_info && typeof store.getAutomationState === 'function') {
    const state = await store.getAutomationState(contact.id).catch(() => null);
    enriched = { ...contact, registration_info: state?.registration_info || {} };
  }
  const title = staffTopicTitleForContact(enriched);
  let topic = await store.getStaffTopicForContact(contact.id);
  let created = false;
  if (!topic) {
    const createdTopic = await bot.telegram.createForumTopic(groupId, title);
    topic = await store.upsertStaffTopic({
      contactId: contact.id,
      telegramUserId: contact.telegram_id,
      staffGroupId: groupId,
      messageThreadId: createdTopic.message_thread_id,
      topicName: createdTopic.name || title
    });
    created = true;
  } else if (topic.topic_name !== title && typeof bot.telegram.editForumTopic === 'function') {
    try {
      await bot.telegram.editForumTopic(groupId, topic.message_thread_id, title);
      topic = await store.upsertStaffTopic({
        contactId: contact.id,
        telegramUserId: contact.telegram_id,
        staffGroupId: groupId,
        messageThreadId: topic.message_thread_id,
        topicName: title
      });
    } catch (error) {
      console.warn('[staff-topic] title_update_failed', error.message);
    }
  }
  return { ok: true, topic, created, groupId, title };
}

export async function postPlayerTopicSystemEvent({ store, bot, contact, text }) {
  if (!contact?.id) return { posted: false, reason: 'no_contact' };
  const topic = await store.getStaffTopicForContact(contact.id);
  if (!topic) return { posted: false, reason: 'no_topic' };
  const groupId = staffGroupIdFromEnv();
  if (!groupId || !bot?.telegram) return { posted: false, reason: 'staff_group_unconfigured' };
  if (isRoyalVipHubChat(groupId)) return { posted: false, reason: 'refused_hub_target' };
  const body = `⚙️ System:\n${String(text || '').trim()}`.slice(0, 3500);
  try {
    const sent = await sendOrReopenStaffTopic({
      store,
      bot,
      contact,
      groupId,
      topic,
      body,
      fallbackDetail: body
    });
    return { posted: Boolean(sent.ok), reopened: sent.reopened, reason: sent.reason || null, topic };
  } catch (error) {
    await store.markStaffTopicError?.(contact.id, error.message).catch(() => null);
    return { posted: false, reason: error.message };
  }
}

export async function deliverPlayerNotice({ store, bot, contact, text }) {
  const body = String(text || '').trim();
  if (!contact?.id || !body) return { ok: false, delivered: false, reason: 'empty' };
  const native = await deliverPlayerFacingHubNotice({ store, bot, contact, text: body });
  if (native.delivered) return native;
  if (native.error && native.topic) {
    await notifyStaffDeliveryFailure(store, {
      bot,
      context: `Native Hub DM delivery failed for contact ${contact.id}`,
      detail: String(native.error.message || native.error).slice(0, 400)
    }).catch(() => null);
  }
  await queueBotReply({
    store,
    user: contact,
    text: body,
    buttons: [],
    bot
  });
  return { ok: true, delivered: true, via: 'private_bot', fallbackFrom: native.via || null };
}

export async function deliverStaffReplyToPlayer({
  store,
  bot,
  contact,
  text,
  media = null,
  actorName = 'Staff',
  staffGroupMessageId = null
}) {
  if (staffGroupMessageId && typeof store.findStaffForwardByGroupMessage === 'function') {
    const existing = await store.findStaffForwardByGroupMessage(contact.id, staffGroupMessageId);
    if (existing) {
      return { ok: true, delivered: false, duplicate: true, messageId: existing.id };
    }
  }
  const telegram = bot?.telegram;
  const playerChatId = contact.telegram_id;
  const facing = formatPlayerFacingStaffReply(text);
  let delivered = false;
  let deliveryError = null;
  let telegramMessageId = null;
  let via = 'private_bot';
  const nativeTopic = await store.getChannelDmTopicForContact?.(contact.id).catch(() => null);
  if (telegram && nativeTopic) {
    try {
      const { sendToHubDirectMessageTopic } = await import('./hubDirectMessages.js');
      const sent = await sendToHubDirectMessageTopic(telegram, {
        dmChatId: nativeTopic.direct_messages_chat_id,
        topicId: nativeTopic.direct_messages_topic_id,
        text: facing,
        media
      });
      telegramMessageId = sent?.message_id || null;
      delivered = true;
      via = 'native_hub_dm';
    } catch (error) {
      deliveryError = error;
    }
  }
  if (!delivered && telegram && playerChatId) {
    via = 'private_bot';
    try {
      if (media?.kind === 'photo' && typeof telegram.sendPhoto === 'function') {
        const sent = await telegram.sendPhoto(playerChatId, media.fileId, { caption: facing });
        telegramMessageId = sent?.message_id || null;
        delivered = true;
      } else if (media?.kind === 'document' && typeof telegram.sendDocument === 'function') {
        const sent = await telegram.sendDocument(playerChatId, media.fileId, { caption: facing });
        telegramMessageId = sent?.message_id || null;
        delivered = true;
      } else if (media?.kind === 'video' && typeof telegram.sendVideo === 'function') {
        const sent = await telegram.sendVideo(playerChatId, media.fileId, { caption: facing });
        telegramMessageId = sent?.message_id || null;
        delivered = true;
      } else {
        const sent = await telegram.sendMessage(playerChatId, facing);
        telegramMessageId = sent?.message_id || null;
        delivered = true;
      }
    } catch (error) {
      deliveryError = error;
      if (media?.fileId) {
        try {
          const sent = await telegram.sendMessage(playerChatId, facing);
          telegramMessageId = sent?.message_id || null;
          delivered = true;
          deliveryError = error;
        } catch (fallbackError) {
          deliveryError = fallbackError;
        }
      }
    }
  }
  await store.storeOutgoingMessage?.({
    telegramUserId: contact.id,
    userId: contact.id,
    text: facing,
    senderType: 'staff',
    staffName: actorName,
    telegramMessageId,
    messageType: media?.kind || 'text',
    source: via === 'native_hub_dm' ? HUB_CHANNEL_DM_SOURCE : 'bot_api',
    payload: {
      staffGroupMessageId: staffGroupMessageId || null,
      mediaKind: media?.kind || null,
      fileUniqueId: media?.fileUniqueId || null,
      delivered,
      via,
      deliveryError: deliveryError ? String(deliveryError.message || deliveryError).slice(0, 400) : null
    }
  }).catch(() => null);
  if (!delivered) {
    await notifyStaffDeliveryFailure(store, {
      bot,
      context: `Staff reply was not delivered to contact ${contact.id}`,
      detail: String(text || '').slice(0, 400)
    }).catch(() => null);
  }
  await store.updateConversationStatus?.(contact.id, 'Waiting', actorName).catch(() => null);
  return { ok: true, delivered, error: deliveryError, telegramMessageId, via };
}

export async function mirrorPlayerMessageToStaffTopic({
  store,
  bot,
  contact,
  text,
  message = null,
  notify = true
}) {
  const persisted = true;
  const nativeTopic = await store.getChannelDmTopicForContact?.(contact.id).catch(() => null);
  if (nativeTopic) {
    return { persisted, mirrored: false, reason: 'native_hub_dm_primary', topic: nativeTopic };
  }
  const media = extractSupportedInboundMedia(message);
  const unsupportedMedia = unsupportedInboundMediaLabel(message);
  const groupId = staffGroupIdFromEnv();
  if (!groupId || !bot?.telegram) {
    return { persisted, mirrored: false, reason: 'staff_group_unconfigured' };
  }
  if (isRoyalVipHubChat(groupId)) {
    console.warn('[staff-topic] refused_hub_target');
    return { persisted, mirrored: false, reason: 'refused_hub_target' };
  }
  const body = formatPlayerInboundForStaff({ contact, text, media, unsupportedMedia });
  try {
    const existingTopic = await store.getStaffTopicForContact(contact.id);
    const profile = await store.getUserProfile?.(contact.id);
    const ensured = await ensureStaffTopicForContact({ store, bot, contact });
    if (!ensured.ok) {
      return { persisted, mirrored: false, reason: ensured.reason, created: false };
    }
    const sent = await sendOrReopenStaffTopic({
      store,
      bot,
      contact,
      groupId: ensured.groupId,
      topic: ensured.topic,
      body,
      media,
      sourceChatId: message?.chat?.id || null,
      sourceMessageId: message?.message_id || null,
      fallbackDetail: String(text || '').slice(0, 400)
    });
    if (!sent.ok) {
      return {
        persisted,
        mirrored: false,
        reusedTopic: !ensured.created,
        reason: sent.reason,
        error: sent.error
      };
    }
    await store.updateConversationStatus?.(contact.id, 'Open', 'Player').catch(() => null);
    if (notify && newSupportNeedsStaffPing({
      existingTopic,
      conversationStatus: profile?.conversation_status
    })) {
      await notifyStaffNewSupportConversation(store, {
        bot,
        contact,
        threadId: ensured.topic.message_thread_id
      }).catch(() => null);
    }
    return {
      persisted,
      mirrored: true,
      created: ensured.created,
      reopened: sent.reopened,
      topic: ensured.topic
    };
  } catch (error) {
    await store.markStaffTopicError?.(contact.id, error.message).catch(() => null);
    await notifyStaffDeliveryFailure(store, {
      bot,
      context: `Staff topic mirror failed for contact ${contact.id}`,
      detail: `${error.message}\n${String(text || '').slice(0, 400)}`
    }).catch(() => null);
    return { persisted, mirrored: false, reason: error.message };
  }
}

export { OPERATIONAL_ROLES, CONFIDENCE };
