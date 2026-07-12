import { decideBotReply } from './chatbotEngine.js';
import { isUnregisteredStatus, registrationCompletionStatus } from '../registration/utils.js';
import { createAppBegPlayerForContact } from '../appbeg/createPlayerService.js';
import { createReplySender, normalizeButtonRows } from './messageDelivery.js';
import { handlePaymentRegistrationQr } from './registrationQrSend.js';

async function sendBotReply({ store, user, text, buttons = [], bot = null, mediaPath = null, messageType = 'text' }) {
  const sendReply = await createReplySender({
    store,
    user,
    bot: bot || globalThis.telegramBot || null,
    preferButtonsViaBot: true
  });
  return sendReply({
    user,
    text,
    buttons: normalizeButtonRows(buttons),
    mediaPath,
    messageType: mediaPath ? 'image' : (normalizeButtonRows(buttons).length ? 'buttons' : 'text')
  });
}

const ALLOWED_ACTIONS = new Set([
  'start_registration_flow',
  'continue_registration_flow',
  'handoff_to_staff',
  'send_support_reply'
]);

const BLOCKED_ACTIONS = new Set([
  'create_player',
  'confirm_payment',
  'credit_balance',
  'approve_withdrawal',
  'edit_account',
  'change_payment_status'
]);

export async function executeSupportAiRecommendedAction({
  store,
  contact,
  job,
  decision,
  io,
  bot,
  executeActions = false,
  staffApproved = false
}) {
  const recommended = String(decision?.recommended_action || 'send_support_reply').trim();
  if (BLOCKED_ACTIONS.has(recommended)) {
    console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=forbidden_action`);
    return {
      executed: false,
      blocked: true,
      reason: 'forbidden_action',
      action_executed: false,
      action_blocked_reason: 'forbidden_action'
    };
  }

  if (!ALLOWED_ACTIONS.has(recommended) || recommended === 'send_support_reply') {
    return {
      executed: false,
      blocked: false,
      reason: 'reply_only',
      action_executed: false,
      action_blocked_reason: null
    };
  }

  if (!executeActions) {
    return {
      executed: false,
      blocked: false,
      reason: 'train_mode',
      action_executed: false,
      action_blocked_reason: 'train_mode'
    };
  }

  if (!staffApproved && (contact.bot_paused || contact.needs_staff_review)) {
    console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=manual_staff_takeover`);
    return {
      executed: false,
      blocked: true,
      reason: 'manual_staff_takeover',
      action_executed: false,
      action_blocked_reason: 'manual_staff_takeover'
    };
  }

  if (recommended === 'handoff_to_staff') {
    await store.markBotNeedsStaffReview(contact.id, 'support_ai_handoff', 'Support AI');
    if (staffApproved) {
      console.log(`[support-ai] support_ai_approved_action_executed contact=${contact.id} action=handoff_to_staff`);
    } else {
      console.log(`[support-ai] support_ai_registration_action_executed contact=${contact.id} action=handoff_to_staff`);
    }
    return {
      executed: true,
      blocked: false,
      reason: null,
      action_executed: true,
      action_blocked_reason: null
    };
  }

  if (recommended === 'start_registration_flow') {
    if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status === 'Registered') {
      console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=already_registered`);
      return {
        executed: false,
        blocked: true,
        reason: 'already_registered',
        action_executed: false,
        action_blocked_reason: 'already_registered'
      };
    }

    const automationState = await store.getAutomationState(contact.id);
    const flow = automationState?.current_flow;
    const step = automationState?.current_step;
    if (flow === 'bot_registration' && step && step !== 'welcome') {
      console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=registration_in_progress`);
      return {
        executed: false,
        blocked: true,
        reason: 'registration_in_progress',
        action_executed: false,
        action_blocked_reason: 'registration_in_progress'
      };
    }

    const regDecision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: 'bot:register'
    });
    await applyRegistrationDecision({ store, contact, decision: regDecision, job, io, bot });
    if (staffApproved) {
      console.log(`[support-ai] support_ai_approved_action_executed contact=${contact.id} action=start_registration_flow kind=${regDecision.kind}`);
    } else {
      console.log(`[support-ai] support_ai_registration_action_executed contact=${contact.id} action=start_registration_flow kind=${regDecision.kind}`);
    }
    return {
      executed: true,
      blocked: false,
      reason: null,
      action_executed: true,
      action_blocked_reason: null
    };
  }

  if (recommended === 'continue_registration_flow') {
    const automationState = await store.getAutomationState(contact.id);
    if (automationState?.current_flow !== 'bot_registration') {
      console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=no_active_registration_flow`);
      return {
        executed: false,
        blocked: true,
        reason: 'no_active_registration_flow',
        action_executed: false,
        action_blocked_reason: 'no_active_registration_flow'
      };
    }

    const step = automationState?.current_step;
    if (step === 'waiting_for_payment_confirmation' && /^done$/i.test(String(job.input_text || '').trim())) {
      console.log(`[support-ai] support_ai_registration_action_blocked contact=${contact.id} action=${recommended} reason=awaiting_payment_group_verification`);
      return {
        executed: false,
        blocked: true,
        reason: 'awaiting_payment_group_verification',
        action_executed: false,
        action_blocked_reason: 'awaiting_payment_group_verification'
      };
    }

    const regDecision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: job.action || null
    });
    await applyRegistrationDecision({ store, contact, decision: regDecision, job, io, bot });
    if (staffApproved) {
      console.log(`[support-ai] support_ai_approved_action_executed contact=${contact.id} action=continue_registration_flow kind=${regDecision.kind}`);
    } else {
      console.log(`[support-ai] support_ai_registration_action_executed contact=${contact.id} action=continue_registration_flow kind=${regDecision.kind}`);
    }
    console.log(`[support-ai] support_ai_existing_registration_continued contact=${contact.id}`);
    return {
      executed: true,
      blocked: false,
      reason: null,
      action_executed: true,
      action_blocked_reason: null
    };
  }

  return {
    executed: false,
    blocked: false,
    reason: 'unknown_action',
    action_executed: false,
    action_blocked_reason: null
  };
}

async function applyRegistrationDecision({ store, contact, decision, job, io, bot }) {
  if (!decision) return;

  if (decision.setStatus) {
    await store.updateRegistrationStatus(contact.id, decision.setStatus, 'Chatbot');
  }

  if (decision.statePatch) {
    await store.updateAutomationState(contact.id, decision.statePatch);
    if (decision.statePatch.registrationInfo && !decision.replaceRegistrationInfo) {
      await store.updateRegistrationInfo(contact.id, decision.statePatch.registrationInfo, 'Chatbot');
    }
  }

  if (decision.markWelcomeSent) {
    await store.markAutoWelcomeSent(contact.id);
  }

  if (decision.expirePaymentWindowId) {
    await store.expireRegistrationPaymentWindow(decision.expirePaymentWindowId, { suppressNotification: true });
  }

  if (decision.completePaymentWindowId) {
    await store.completeRegistrationPaymentWindow(decision.completePaymentWindowId);
  }

  if (decision.sendPaymentQr) {
    await applyPaymentRegistrationQr({ store, contact, sendPaymentQr: decision.sendPaymentQr, bot });
  }

  if (decision.completeRegistration) {
    const info = decision.statePatch?.registrationInfo
      || (await store.getAutomationState(contact.id))?.registration_info
      || {};
    await store.completeRegistration({
      userId: contact.id,
      registrationInfo: info,
      registrationStatus: registrationCompletionStatus(),
      registrationMethod: 'chatbot',
      actorName: 'Chatbot'
    });
  }

  if (decision.createAppBegPlayer) {
    try {
      await createAppBegPlayerForContact(store, {
        contactId: contact.id,
        actorName: 'Chatbot',
        io
      });
      await store.updateAutomationState(contact.id, {
        currentFlow: null,
        currentStep: null
      });
    } catch (error) {
      await sendBotReply({
        store,
        user: contact,
        text: `We couldn't create your AppBeg account right now: ${error.message}\n\nPlease reply Staff and our team will help you finish registration.`,
        bot: bot || globalThis.telegramBot || null
      });
    }
  }

  for (const reply of decision.replies || []) {
    await sendBotReply({
      store,
      user: contact,
      text: reply.text,
      buttons: reply.buttons || [],
      bot: bot || globalThis.telegramBot || null
    });
  }

  if (decision.escalate) {
    await store.markBotNeedsStaffReview(contact.id, decision.escalateReason || 'handoff', 'Chatbot');
  }

  await store.logAutomationDecision({
    userId: contact.id,
    messageId: job?.message_id || null,
    incomingTelegramMessageId: job?.incoming_telegram_message_id || null,
    actionTaken: `support_ai_registration:${decision.kind}`,
    responseSent: (decision.replies || []).map((item) => item.text).join('\n---\n'),
    metadata: {
      jobId: job?.id || null,
      kind: decision.kind,
      source: 'support_ai_action_executor'
    }
  });
}

async function applyPaymentRegistrationQr({ store, contact, sendPaymentQr, bot }) {
  return handlePaymentRegistrationQr({ store, contact, sendPaymentQr, bot });
}
