import { evaluatePaymentConfidence, staffReviewReasonLines } from './confidenceEngine.js';
import { isEligibleActivePaymentWindow } from './paymentWindowMatcher.js';
import { PAYMENT_WINDOW_FLOW, ROUTING_OWNER, ROUTING_REASON, ROUTING_STATUS, UNMATCHED_REASON, HANDLED_BY_APPBEG_BOT } from './constants.js';

async function alertStaff(store, payment, { bot, evaluation, dmEveryone, extra } = {}) {
  try {
    const { notifyOperationalStaffPayment } = await import('../telegram/operationalAlerts.js');
    await notifyOperationalStaffPayment(store, payment, { bot, evaluation, dmEveryone, extra });
  } catch (error) {
    console.warn('[confidence-router] staff_alert_failed', error.message);
  }
}

function windowRequesterId(window) {
  return Number(window?.requester_contact_id || window?.contact_id);
}

export async function routeParsedPaymentWithConfidence(store, payment, parsed, {
  bot = null,
  io = null,
  now = new Date()
} = {}) {
  if (typeof store.getConfidenceMode !== 'function' || typeof store.ensurePaymentIdentity !== 'function') {
    return { used: false };
  }

  const identity = await store.ensurePaymentIdentity(parsed.payment_sender_name);
  const evidenceRows = identity ? await store.listPaymentIdentityEvidence(identity.id) : [];
  const mode = await store.getConfidenceMode();
  const activeWindows = (await store.listActiveRegistrationPaymentWindows?.() || [])
    .filter((window) => isEligibleActivePaymentWindow(window, { now }))
    .filter((window) => (window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION) === PAYMENT_WINDOW_FLOW.DEPOSIT);

  const confirmed = [...new Set(
    evidenceRows
      .filter((row) => row.evidence_kind === 'staff_confirmed' || row.evidence_kind === 'system_confirmed')
      .map((row) => Number(row.contact_id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];
  const payerWindows = confirmed.length
    ? activeWindows.filter((window) => confirmed.includes(windowRequesterId(window)))
    : [];

  const frozen = payment.routing_status === ROUTING_STATUS.FROZEN || Boolean(payment.frozen_at);
  const ignored = payment.routing_status === ROUTING_STATUS.IGNORED;
  const alreadyAssigned = Boolean(payment.registration_payment_window_id);
  const alreadyCredited = ['deposit_window_matched', 'registered_player_deposit', 'registration_payment_matched', 'appbeg_owned']
    .includes(String(payment.routing_status || ''));

  const evaluation = evaluatePaymentConfidence({
    displayName: parsed.payment_sender_name,
    evidenceRows,
    activeWindowsForPayer: payerWindows,
    allActiveWindows: activeWindows,
    confidenceModeOn: Boolean(mode?.enabled),
    frozen,
    ignored,
    alreadyAssigned,
    alreadyCredited
  });

  if (identity && typeof store.updatePaymentRouting === 'function') {
    await store.updatePaymentRouting(payment.id, {
      payment_identity_id: identity.id,
      confidence_classification: evaluation.classification
    }).catch(() => null);
  }

  await store.recordPaymentDecision?.({
    paymentEventId: payment.id,
    paymentIdentityId: identity?.id || null,
    payerContactId: evaluation.confirmedPayerIds[0] || null,
    recipientContactId: evaluation.candidateWindow?.recipient_contact_id || null,
    windowId: evaluation.candidateWindow?.id || null,
    classification: evaluation.classification,
    evidence: evaluation.reasons,
    confidenceModeOn: Boolean(mode?.enabled),
    decisionType: evaluation.autoCreditEligible ? 'auto_credit_eligible' : 'staff_review',
    actorTelegramUserId: evaluation.autoCreditEligible ? 'system' : null
  });

  if (evaluation.autoCreditEligible && evaluation.candidateWindow) {
    const window = evaluation.candidateWindow;
    const claim = await store.claimPaymentWindowMatch(window.id, payment.id);
    if (!claim.ok && claim.reason !== 'already_matched') {
      return {
        used: true,
        result: await markNeedsReview(store, payment, evaluation, {
          routingStatus: ROUTING_STATUS.NEEDS_CONFIRMATION,
          reason: `Claim failed (${claim.reason})`,
          bot
        })
      };
    }
    await store.updatePaymentRouting(payment.id, {
      routing_status: ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
      routing_owner: ROUTING_OWNER.APPBEG,
      routing_reason: ROUTING_REASON.MATCHED_DEPOSIT_WINDOW,
      contact_id: window.recipient_contact_id || window.contact_id,
      payer_contact_id: windowRequesterId(window),
      recipient_contact_id: window.recipient_contact_id || window.contact_id,
      registration_payment_window_id: window.id,
      routed_at: new Date().toISOString(),
      matched_at: new Date().toISOString(),
      handled_by: HANDLED_BY_APPBEG_BOT,
      unmatched_reason: null
    });
    await store.recordPaymentIdentityEvidence?.({
      paymentIdentityId: identity.id,
      contactId: windowRequesterId(window),
      evidenceKind: 'system_confirmed',
      paymentEventId: payment.id,
      actorTelegramUserId: 'system'
    });
    const recipientId = Number(window.recipient_contact_id || window.contact_id);
    try {
      await continueRegisteredDepositAfterPayment(store, {
        contactId: recipientId,
        windowId: window.id,
        paymentEventId: payment.id,
        bot,
        io,
        alreadyClaimed: true
      });
    } catch (error) {
      await store.updatePaymentRouting(payment.id, {
        routing_status: ROUTING_STATUS.CREDIT_FAILED,
        routing_reason: String(error.message || error).slice(0, 400),
        credit_failed_at: new Date().toISOString(),
        credit_failed_error: String(error.message || error).slice(0, 500)
      });
      await store.recordPaymentDecision?.({
        paymentEventId: payment.id,
        paymentIdentityId: identity?.id || null,
        payerContactId: windowRequesterId(window),
        recipientContactId: recipientId,
        windowId: window.id,
        classification: evaluation.classification,
        evidence: evaluation.reasons,
        confidenceModeOn: Boolean(mode?.enabled),
        decisionType: 'auto_credit_failed',
        actorTelegramUserId: 'system',
        appbegStatus: 'failed'
      });
      const failedPayment = await store.getPaymentEvent(payment.id);
      await alertStaff(store, failedPayment, {
        bot,
        evaluation,
        dmEveryone: true,
        extra: { title: '🔴 CREDIT FAILED', creditFailed: true }
      });
      return {
        used: true,
        result: {
          ok: true,
          payment: failedPayment,
          outcome: ROUTING_STATUS.CREDIT_FAILED,
          evaluation
        }
      };
    }
    await store.recordPaymentDecision?.({
      paymentEventId: payment.id,
      paymentIdentityId: identity?.id || null,
      payerContactId: windowRequesterId(window),
      recipientContactId: recipientId,
      windowId: window.id,
      classification: evaluation.classification,
      evidence: evaluation.reasons,
      confidenceModeOn: Boolean(mode?.enabled),
      decisionType: 'auto_credit',
      actorTelegramUserId: 'system',
      appbegStatus: 'credited'
    });
    const creditedPayment = await store.getPaymentEvent(payment.id);
    await alertStaff(store, creditedPayment, {
      bot,
      evaluation,
      dmEveryone: false,
      extra: { title: '🟢 AUTO-CREDITED' }
    });
    return {
      used: true,
      result: {
        ok: true,
        payment: creditedPayment,
        outcome: ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED,
        evaluation
      }
    };
  }

  const noWindow = evaluation.reasons.includes('no_active_window');
  const routingStatus = evaluation.classification === 'AMBIGUOUS'
    ? ROUTING_STATUS.AMBIGUOUS
    : (noWindow ? ROUTING_STATUS.UNMATCHED : ROUTING_STATUS.NEEDS_CONFIRMATION);
  return {
    used: true,
    result: await markNeedsReview(store, payment, evaluation, {
      routingStatus,
      reason: staffReviewReasonLines(evaluation).join('; '),
      bot
    })
  };
}

async function markNeedsReview(store, payment, evaluation, { routingStatus, reason, bot = null }) {
  await store.updatePaymentRouting(payment.id, {
    routing_status: routingStatus,
    routing_owner: ROUTING_OWNER.APPBEG,
    routing_reason: reason || ROUTING_REASON.WAITING_MANUAL_REVIEW,
    routed_at: new Date().toISOString(),
    frozen_at: null,
    handled_by: null,
    unmatched_reason: routingStatus === ROUTING_STATUS.UNMATCHED
      ? UNMATCHED_REASON.NO_ACTIVE_WINDOW
      : UNMATCHED_REASON.STAFF_REVIEW_REQUESTED
  });
  await store.logPaymentRouting(payment.id, 'payment_staff_review', reason || 'Staff review required.', {
    classification: evaluation.classification,
    reasons: evaluation.reasons,
    status: routingStatus
  });
  const reviewed = await store.getPaymentEvent(payment.id);
  await alertStaff(store, reviewed, { bot, evaluation, dmEveryone: true });
  return {
    ok: true,
    payment: reviewed,
    outcome: routingStatus,
    evaluation
  };
}
