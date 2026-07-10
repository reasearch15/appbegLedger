import {
  loadSupportAiContactContext,
  buildSupportAiDecision,
  formatSupportAiContextBlock
} from './supportAiContactContext.js';
import { isCustomerSupportAiConfigured } from './customerSupportAiConfig.js';

export async function generateCustomerSupportReply({ store, contact, messageText, useTraining = false }) {
  const draft = await generateCustomerSupportDraft({ store, contact, messageText });
  if (!useTraining || !store.findStaffAiTrainingReply) {
    return { ...draft, replySource: 'template' };
  }
  const trainedReply = await store.findStaffAiTrainingReply({
    contactId: contact.id,
    intent: draft.decision?.intent || draft.kind
  });
  if (trainedReply) {
    return {
      ...draft,
      reply: trainedReply,
      reply_text: trainedReply,
      replySource: 'training'
    };
  }
  return { ...draft, replySource: 'template' };
}

export async function generateCustomerSupportDraft({ store, contact, messageText }) {
  if (!isCustomerSupportAiConfigured()) {
    return {
      kind: 'not_configured',
      confidence: 0,
      reply: '',
      reply_text: '',
      decision: {
        intent: 'not_configured',
        recommended_action: 'send_support_reply',
        confidence: 0,
        reply_text: '',
        action_blocked_reason: 'not_configured'
      },
      entities: {},
      context: '',
      contactContext: null,
      configured: false
    };
  }

  const text = String(messageText || '').trim();
  const { context: contactContext } = await loadSupportAiContactContext({ store, contact });
  const messages = await store.listMessagesForUser(contact.id);
  const recent = messages.slice(-10).map((message) => {
    const speaker = message.direction === 'incoming' ? 'Customer' : message.sender_type === 'staff' ? 'Staff' : 'Support';
    return `${speaker}: ${message.text || `[${message.message_type || 'message'}]`}`;
  }).join('\n');

  const decision = buildSupportAiDecision({ messageText: text, contactContext });
  const context = [
    `Profile: ${contact.display_name || 'Customer'}${contact.username ? ` (@${contact.username})` : ''}`,
    formatSupportAiContextBlock(contactContext, recent)
  ].filter(Boolean).join('\n');

  return {
    kind: decision.intent,
    confidence: decision.confidence,
    reply: decision.reply_text,
    reply_text: decision.reply_text,
    decision: {
      intent: decision.intent,
      recommended_action: decision.recommended_action,
      confidence: decision.confidence,
      reply_text: decision.reply_text,
      action_blocked_reason: decision.action_blocked_reason || null
    },
    entities: {
      registration_phase: contactContext.registration_phase,
      registration_status: contactContext.registration_status,
      registration_step: contactContext.current_step,
      payment_window_status: contactContext.payment_window_status,
      payment_confirmed: contactContext.payment_confirmed,
      payment_app: contactContext.payment_app,
      payment_display_name: contactContext.payment_display_name,
      deposit_amount: contactContext.deposit_amount,
      appbeg_username: contactContext.appbeg_username,
      appbeg_player_uid: contactContext.appbeg_player_uid,
      was_registered: contactContext.was_registered,
      staff_takeover: contactContext.staff_takeover,
      recommended_action: decision.recommended_action
    },
    contactContext,
    context,
    configured: true
  };
}
