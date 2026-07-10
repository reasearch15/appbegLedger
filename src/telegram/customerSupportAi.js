import {
  loadSupportAiContactContext,
  buildSupportAiDecision,
  formatSupportAiContextBlock
} from './supportAiContactContext.js';
import { isCustomerSupportAiConfigured } from './customerSupportAiConfig.js';
import { formatTrainingExamplesForContext } from './supportAiTrainingRetrieval.js';

export async function generateCustomerSupportReply({ store, contact, messageText }) {
  return generateCustomerSupportDraft({ store, contact, messageText });
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

  const templateDecision = buildSupportAiDecision({ messageText: text, contactContext });
  const intent = templateDecision.intent;

  let trainingResult = null;
  if (store.searchApprovedSupportAiTraining) {
    trainingResult = await store.searchApprovedSupportAiTraining({
      customerMessage: text,
      contactId: contact.id,
      intent,
      contactContext,
      language: contact.language_code || null,
      limit: 5
    });
  }

  if (trainingResult?.reply) {
    const replySource = trainingResult.matchType === 'exact' ? 'training_exact' : 'training_similar';
    const trainingContext = formatTrainingExamplesForContext(trainingResult.examples);
    const context = [
      `Profile: ${contact.display_name || 'Customer'}${contact.username ? ` (@${contact.username})` : ''}`,
      formatSupportAiContextBlock(contactContext, recent),
      trainingContext
    ].filter(Boolean).join('\n');

    return {
      kind: intent,
      confidence: trainingResult.matchType === 'exact' ? 0.99 : 0.9,
      reply: trainingResult.reply,
      reply_text: trainingResult.reply,
      decision: {
        intent,
        recommended_action: templateDecision.recommended_action,
        confidence: trainingResult.matchType === 'exact' ? 0.99 : 0.9,
        reply_text: trainingResult.reply,
        action_blocked_reason: templateDecision.action_blocked_reason || null,
        auto_send_allowed: templateDecision.auto_send_allowed !== false,
        action_execution_allowed: templateDecision.action_execution_allowed !== false
      },
      entities: {
        registration_phase: contactContext.registration_phase,
        registration_state: contactContext.registration_state,
        registration_status: contactContext.registration_status,
        registration_step: contactContext.current_step,
        payment_window_status: contactContext.payment_window_status,
        payment_confirmed: contactContext.payment_confirmed,
        payment_app: contactContext.payment_app,
        payment_display_name: contactContext.payment_display_name,
        deposit_amount: contactContext.deposit_amount,
        appbeg_username: contactContext.appbeg_username,
        appbeg_player_uid: contactContext.appbeg_player_uid,
        appbeg_link_status: contactContext.appbeg_link_status,
        account_status: contactContext.account_status,
        is_registered: contactContext.is_registered,
        was_registered: contactContext.is_registered,
        staff_takeover: contactContext.staff_takeover,
        recommended_action: templateDecision.recommended_action,
        training_match: trainingResult.matchType,
        training_example_id: trainingResult.best?.id || null
      },
      contactContext,
      context,
      configured: true,
      replySource,
      trainingMatch: trainingResult.matchType,
      trainingExampleId: trainingResult.best?.id || null
    };
  }

  console.log(`[support-ai] support_ai_fallback_template_used contact=${contact.id} intent=${intent} message=${text.slice(0, 80)}`);

  const context = [
    `Profile: ${contact.display_name || 'Customer'}${contact.username ? ` (@${contact.username})` : ''}`,
    formatSupportAiContextBlock(contactContext, recent)
  ].filter(Boolean).join('\n');

  return {
    kind: intent,
    confidence: templateDecision.confidence,
    reply: templateDecision.reply_text,
    reply_text: templateDecision.reply_text,
    decision: {
      intent: templateDecision.intent,
      recommended_action: templateDecision.recommended_action,
      confidence: templateDecision.confidence,
      reply_text: templateDecision.reply_text,
      action_blocked_reason: templateDecision.action_blocked_reason || null,
      auto_send_allowed: templateDecision.auto_send_allowed !== false,
      action_execution_allowed: templateDecision.action_execution_allowed !== false
    },
    entities: {
      registration_phase: contactContext.registration_phase,
      registration_state: contactContext.registration_state,
      registration_status: contactContext.registration_status,
      registration_step: contactContext.current_step,
      payment_window_status: contactContext.payment_window_status,
      payment_confirmed: contactContext.payment_confirmed,
      payment_app: contactContext.payment_app,
      payment_display_name: contactContext.payment_display_name,
      deposit_amount: contactContext.deposit_amount,
      appbeg_username: contactContext.appbeg_username,
      appbeg_player_uid: contactContext.appbeg_player_uid,
      appbeg_link_status: contactContext.appbeg_link_status,
      account_status: contactContext.account_status,
      is_registered: contactContext.is_registered,
      was_registered: contactContext.is_registered,
      staff_takeover: contactContext.staff_takeover,
      recommended_action: templateDecision.recommended_action
    },
    contactContext,
    context,
    configured: true,
    replySource: 'template'
  };
}
