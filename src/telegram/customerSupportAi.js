import {
  buildSupportAiDecision
} from './supportAiContactContext.js';
import { getCustomerSupportAiProvider, isCustomerSupportAiConfigured } from './customerSupportAiConfig.js';
import { buildSupportContext } from './supportContext.js';
import { buildSupportAiPrompt, DEFAULT_CUSTOMER_SUPPORT_PROMPT } from './supportPrompt.js';

async function callOpenAiSupportReply(prompt) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI support AI provider.');

  const model = String(process.env.CUSTOMER_SUPPORT_AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are Royal VIP customer support. Reply with only the final Telegram message to send to the customer.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI support reply failed: ${response.status} ${body.slice(0, 200)}`.trim());
  }

  const payload = await response.json();
  const reply = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!reply) throw new Error('OpenAI support reply was empty.');
  return reply;
}

export async function generateCustomerSupportReply({ store, contact, messageText }) {
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
  const verifiedContext = await buildSupportContext({ store, contact });
  const contactContext = {
    contact_id: verifiedContext.contact.id,
    registration_status: verifiedContext.registration.status,
    registration_state: verifiedContext.registration.currentStage,
    registration_phase: verifiedContext.registration.currentStage,
    underlying_registration_phase: verifiedContext.registration.currentStage,
    current_flow: verifiedContext.automation.currentFlow,
    current_step: verifiedContext.registration.currentStep,
    registration_step: verifiedContext.registration.currentStep,
    payment_window_status: verifiedContext.registration.activePaymentWindow?.status || null,
    payment_confirmed: verifiedContext.registration.paymentConfirmed,
    payment_app: verifiedContext.registration.activePaymentWindow?.paymentMethodName || null,
    payment_display_name: verifiedContext.registration.activePaymentWindow?.paymentDisplayName || null,
    deposit_amount: verifiedContext.registration.activePaymentWindow?.amount ?? verifiedContext.payments.pendingDeposit?.amount ?? null,
    appbeg_username: verifiedContext.player.username,
    appbeg_player_uid: verifiedContext.player.uidPresent ? 'present' : null,
    appbeg_link_status: verifiedContext.player.linkStatus,
    account_status: verifiedContext.player.accountStatus,
    account_creation_complete: verifiedContext.player.exists,
    appbeg_player_exists: verifiedContext.player.exists,
    staff_takeover: false,
    is_registered: verifiedContext.registration.isRegistered,
    was_registered: verifiedContext.registration.isRegistered,
    registration_status_conflict: false,
    payment_window_expires_at: verifiedContext.registration.activePaymentWindow?.expiresAt || null,
    payment_window_id: verifiedContext.registration.activePaymentWindow?.id || null
  };
  const promptSettings = await store.getCustomerSupportPrompt?.() || {
    prompt: DEFAULT_CUSTOMER_SUPPORT_PROMPT
  };
  const recentConversation = JSON.stringify(verifiedContext.conversation.recentMessages, null, 2);
  const requestPrompt = buildSupportAiPrompt({
    businessPrompt: promptSettings.prompt,
    verifiedContext,
    recentConversation,
    messageText: text
  });
  const provider = getCustomerSupportAiProvider();
  const templateDecision = buildSupportAiDecision({ messageText: text, contactContext });
  const intent = templateDecision.intent;
  let replyText = templateDecision.reply_text;
  let replySource = 'master_prompt_template';

  if (provider === 'openai') {
    replyText = await callOpenAiSupportReply(requestPrompt);
    replySource = 'openai';
  }

  console.log(`[support-ai] support_ai_reply_generated contact=${contact.id} provider=${provider} intent=${intent} message=${text.slice(0, 80)}`);

  return {
    kind: intent,
    confidence: templateDecision.confidence,
    reply: replyText,
    reply_text: replyText,
    decision: {
      intent: templateDecision.intent,
      recommended_action: templateDecision.recommended_action,
      confidence: templateDecision.confidence,
      reply_text: replyText,
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
    verifiedContext,
    context: requestPrompt,
    aiRequest: requestPrompt,
    configured: true,
    replySource
  };
}
