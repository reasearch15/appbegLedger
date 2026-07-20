import { isUnregisteredStatus } from '../registration/utils.js';
import {
  resolveSupportAiRegistrationState,
  formatSupportAiRegistrationPromptRules
} from './supportAiRegistrationState.js';

const WANTS_REGISTRATION_PATTERNS = [
  /\b(want|need|make|create|get)\b.*\b(account|id|username)\b/i,
  /\bhow\b.*\b(register|sign ?up|join)\b/i,
  /\bcan i join\b/i,
  /\bregister me\b/i,
  /\bsign ?up\b/i,
  /\bhow do i start\b/i,
  /\bmake me an id\b/i,
  /\bcreate account\b/i,
  /\bnew account\b/i,
  /^(register|signup)$/i
];

const UNREGISTERED_PLAY_PATTERNS = [
  /\bhow do i play\b/i,
  /\bhow to play\b/i,
  /\bwant to play\b/i,
  /\bi want to play\b/i
];

const ACCOUNT_INFO_STEPS = new Set([
  'username',
  'password',
  'referral_code',
  'appbeg_username',
  'payment_tag'
]);

export async function loadSupportAiContactContext({ store, contact }) {
  const automationState = await store.getAutomationState(contact.id);
  const info = { ...(automationState?.registration_info || {}) };
  let activePaymentWindow = null;
  let latestPaymentWindow = null;
  try {
    activePaymentWindow = await store.getActiveRegistrationPaymentWindow(contact.id);
    if (!activePaymentWindow && store.getRegistrationPaymentWindow) {
      const windowId = info.registration_payment_window_id;
      if (windowId) latestPaymentWindow = await store.getRegistrationPaymentWindow(windowId);
    }
  } catch {
    activePaymentWindow = null;
  }

  const paymentWindow = activePaymentWindow || latestPaymentWindow;
  const flow = automationState?.current_flow || null;
  const step = automationState?.current_step || null;
  const manualStaffTakeover = Boolean(contact.bot_paused);

  const registrationState = await resolveSupportAiRegistrationState({
    contact,
    info,
    flow,
    step,
    paymentWindow,
    manualStaffTakeover
  });

  const underlyingRegistrationPhase = classifyRegistrationPhase({
    contact,
    flow,
    step,
    info,
    paymentWindow,
    registrationState,
    manualStaffTakeover: false
  });
  const registrationPhase = manualStaffTakeover
    ? 'manual_staff_takeover'
    : underlyingRegistrationPhase;

  const context = {
    contact_id: contact.id,
    registration_status: registrationState.registration_status,
    registration_state: registrationState.registration_state,
    registration_phase: registrationPhase,
    underlying_registration_phase: underlyingRegistrationPhase,
    current_flow: flow,
    current_step: step,
    registration_step: step,
    payment_window_status: paymentWindow?.status || (activePaymentWindow ? 'active' : null),
    payment_confirmed: Boolean(info.payment_confirmed),
    payment_app: info.payment_method_name || info.payment_app || null,
    payment_display_name: info.payment_display_name || info.chime_payment_name || null,
    deposit_amount: info.first_deposit_amount ?? info.deposit_amount ?? null,
    appbeg_username: registrationState.appbeg_username,
    appbeg_player_uid: registrationState.appbeg_player_uid,
    appbeg_link_status: registrationState.appbeg_link_status,
    account_status: registrationState.account_status,
    account_creation_complete: registrationState.account_creation_complete,
    appbeg_player_exists: registrationState.appbeg_player_exists,
    staff_takeover: manualStaffTakeover,
    is_registered: registrationState.is_registered,
    was_registered: registrationState.is_registered,
    registration_status_conflict: registrationState.registration_status_conflict,
    payment_window_expires_at: paymentWindow?.expires_at || null,
    payment_window_id: paymentWindow?.id || info.registration_payment_window_id || null
  };

  console.log(`[support-ai] support_ai_contact_state_loaded contact=${contact.id} phase=${registrationPhase} state=${registrationState.registration_state} status=${context.registration_status} step=${step || 'none'} flow=${flow || 'none'} registered=${registrationState.is_registered}`);
  if (manualStaffTakeover) {
    console.log(`[support-ai] support_ai_manual_takeover_respected contact=${contact.id}`);
  }

  return { context, automationState, paymentWindow, info };
}

function classifyRegistrationPhase({
  contact,
  flow,
  step,
  info,
  paymentWindow,
  registrationState,
  manualStaffTakeover
}) {
  if (manualStaffTakeover) return 'manual_staff_takeover';
  if (registrationState.is_registered) return 'registered';
  if (registrationState.registration_state === 'registration_complete_but_not_linked') {
    return 'registration_complete_but_not_linked';
  }

  const normalizedStep = String(step || '').trim();
  const inBotRegistration = flow === 'bot_registration';

  if (paymentWindow?.status === 'expired' && !info.payment_confirmed && isUnregisteredStatus(contact.registration_status)) {
    return 'registration_expired';
  }

  if (inBotRegistration) {
    if (normalizedStep === 'await_payment_done' && paymentWindow?.status === 'active') {
      return 'waiting_for_payment';
    }
    if (normalizedStep === 'waiting_for_payment_confirmation') {
      return 'waiting_for_payment_confirmation';
    }
    if (info.payment_confirmed && ACCOUNT_INFO_STEPS.has(normalizedStep)) {
      return 'payment_confirmed_collecting_account_info';
    }
    if (normalizedStep === 'review' || info.registration_confirmed || info.ready_for_coadmin_creation) {
      return 'ready_for_coadmin_creation';
    }
    if (normalizedStep && normalizedStep !== 'welcome') {
      return 'registration_in_progress';
    }
  }

  if (isUnregisteredStatus(contact.registration_status)) {
    return inBotRegistration && normalizedStep && normalizedStep !== 'welcome'
      ? 'registration_in_progress'
      : 'not_registered';
  }

  return 'registration_in_progress';
}

export function detectWantsRegistrationIntent(messageText = '') {
  const text = String(messageText || '').trim();
  return WANTS_REGISTRATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectUnregisteredPlayIntent(messageText = '') {
  const text = String(messageText || '').trim();
  return UNREGISTERED_PLAY_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildSupportAiDecision({ messageText, contactContext }) {
  const intentPhase = contactContext.underlying_registration_phase
    || contactContext.registration_phase;
  const decision = buildCoreSupportAiDecision({
    messageText,
    contactContext: { ...contactContext, registration_phase: intentPhase }
  });

  if (!contactContext.staff_takeover) {
    return {
      ...decision,
      auto_send_allowed: true,
      action_execution_allowed: true,
      action_blocked_reason: null
    };
  }

  console.log(`[support-ai] support_ai_intent_detected_during_manual_takeover contact=${contactContext.contact_id} intent=${decision.intent} action=${decision.recommended_action}`);
  if (decision.recommended_action && decision.recommended_action !== 'send_support_reply') {
    console.log(`[support-ai] support_ai_action_held_for_staff_approval contact=${contactContext.contact_id} action=${decision.recommended_action}`);
  }

  return {
    ...decision,
    auto_send_allowed: false,
    action_execution_allowed: false,
    action_blocked_reason: 'manual_staff_takeover'
  };
}

function buildCoreSupportAiDecision({ messageText, contactContext }) {
  const text = String(messageText || '').trim();
  const phase = contactContext.registration_phase;
  const wantsRegistration = detectWantsRegistrationIntent(text);
  const wantsToPlay = detectUnregisteredPlayIntent(text);
  const isRegistered = Boolean(contactContext.is_registered ?? contactContext.was_registered);

  if (phase === 'registered' || isRegistered) {
    if (wantsRegistration) {
      console.log(`[support-ai] support_ai_registered_user_not_restarted contact=${contactContext.contact_id}`);
      return {
        intent: 'registered_support',
        recommended_action: 'send_support_reply',
        confidence: 0.92,
        reply_text: buildRegisteredAlreadyAccountReply(contactContext)
      };
    }
    if (wantsToPlay || /\b(play|game|start)\b/i.test(text)) {
      return {
        intent: 'registered_support',
        recommended_action: 'send_support_reply',
        confidence: 0.9,
        reply_text: buildRegisteredPlayReply(text, contactContext)
      };
    }
    return {
      intent: detectRegisteredIntent(text),
      recommended_action: 'send_support_reply',
      confidence: 0.8,
      reply_text: buildRegisteredSupportReply(text, contactContext)
    };
  }

  if ((wantsRegistration || wantsToPlay) && (phase === 'not_registered' || phase === 'registration_expired')) {
    console.log(`[support-ai] support_ai_registration_intent_detected contact=${contactContext.contact_id}`);
    console.log(`[support-ai] support_ai_registration_start_recommended contact=${contactContext.contact_id}`);
    return {
      intent: 'wants_registration',
      recommended_action: 'start_registration_flow',
      confidence: 0.98,
      reply_text: wantsToPlay
        ? 'Sure, I can help you get registered first. Which payment app will you use?'
        : 'Sure, I can help you get registered. First, which payment app will you use?'
    };
  }

  if (phase === 'registration_complete_but_not_linked') {
    return {
      intent: 'registration_progress',
      recommended_action: 'send_support_reply',
      confidence: 0.9,
      reply_text: 'Your registration details are complete, but your AppBeg account is not fully linked yet. Please wait while staff finishes linking your account.'
    };
  }

  if (phase === 'waiting_for_payment') {
    return {
      intent: 'registration_progress',
      recommended_action: 'continue_registration_flow',
      confidence: 0.9,
      reply_text: 'Your payment window is still open. Please send the exact amount shown and then reply Done. We will continue only after the payment is verified.'
    };
  }

  if (phase === 'waiting_for_payment_confirmation') {
    return {
      intent: 'registration_progress',
      recommended_action: 'send_support_reply',
      confidence: 0.95,
      reply_text: 'Thanks. We are checking the payment group now. Please wait for confirmation before we continue.'
    };
  }

  if (phase === 'payment_confirmed_collecting_account_info') {
    const step = contactContext.current_step;
    if (step === 'username' || step === 'appbeg_username') {
      return {
        intent: 'registration_progress',
        recommended_action: 'continue_registration_flow',
        confidence: 0.9,
        reply_text: 'We are ready for your AppBeg username. It must start with a capital letter and end with a number, for example Rajex01.'
      };
    }
    if (step === 'password') {
      return {
        intent: 'registration_progress',
        recommended_action: 'continue_registration_flow',
        confidence: 0.9,
        reply_text: 'Please send the AppBeg password you want to use. Keep it private and do not share it with anyone else.'
      };
    }
    return {
      intent: 'registration_progress',
      recommended_action: 'continue_registration_flow',
      confidence: 0.85,
      reply_text: 'Your payment is confirmed. Please continue with the registration details we ask for next.'
    };
  }

  if (phase === 'ready_for_coadmin_creation') {
    return {
      intent: 'registration_progress',
      recommended_action: 'send_support_reply',
      confidence: 0.95,
      reply_text: 'Your details are complete. A coadmin now needs to create your AppBeg account. Please wait while staff finishes this step.'
    };
  }

  if (phase === 'registration_in_progress' || phase === 'registration_expired') {
    if (wantsRegistration || wantsToPlay) {
      console.log(`[support-ai] support_ai_existing_registration_continued contact=${contactContext.contact_id}`);
    }
    return {
      intent: wantsRegistration || wantsToPlay ? 'wants_registration' : 'registration_progress',
      recommended_action: 'continue_registration_flow',
      confidence: 0.88,
      reply_text: phase === 'registration_expired'
        ? 'Your previous payment window expired. Reply Register if you want to start registration again from the beginning.'
        : 'You already have registration in progress. Please answer the current registration question so we can continue.'
    };
  }

  if (wantsRegistration || wantsToPlay) {
    return {
      intent: 'wants_registration',
      recommended_action: 'start_registration_flow',
      confidence: 0.9,
      reply_text: wantsToPlay
        ? 'Sure, I can help you get registered first. Which payment app will you use?'
        : 'Sure, I can help you get registered. First, which payment app will you use?'
    };
  }

  return {
    intent: 'general_support',
    recommended_action: 'send_support_reply',
    confidence: 0.5,
    reply_text: 'Thanks for messaging us. Please share a little more detail so staff can help you quickly.'
  };
}

function detectRegisteredIntent(text) {
  if (/\b(deposit|add money|load coin|top ?up)\b/i.test(text)) return 'deposit_question';
  if (/\b(withdraw|cash ?out|payout)\b/i.test(text)) return 'withdrawal_question';
  if (/\b(bonus|promo|promotion)\b/i.test(text)) return 'bonus_question';
  if (/\b(login|log in|password|username|forgot)\b/i.test(text)) return 'login_help';
  if (/\b(help|staff|support)\b/i.test(text)) return 'needs_staff';
  return 'registered_support';
}

function buildRegisteredAlreadyAccountReply(context) {
  const username = context.appbeg_username ? ` (${context.appbeg_username})` : '';
  return `You already have a Royal VIP account${username}. You do not need to register again. Log in with your username and password, or tell us if you need login help.`;
}

function buildRegisteredPlayReply(text, context) {
  if (/\b(play|game|start|how do i play|how to play)\b/i.test(text)) {
    const username = context.appbeg_username ? ` as ${context.appbeg_username}` : '';
    return `You can log in to your Royal VIP account${username} and open the Play section. Which game do you want help with?`;
  }
  return buildRegisteredSupportReply(text, context);
}

function buildRegisteredSupportReply(text, context) {
  const intent = detectRegisteredIntent(text);
  if (intent === 'deposit_question') {
    return 'Open Load Coin in your Royal VIP account, copy your Royal VIP username, and include it with your payment.';
  }
  if (intent === 'withdrawal_question') {
    return 'For withdrawals, open your Royal VIP account and follow the cash-out steps. If something fails, reply Staff and our team will review it.';
  }
  if (intent === 'bonus_question') {
    return 'Bonus rules depend on the offer. Tell us which bonus you mean and staff will explain the details.';
  }
  if (intent === 'login_help') {
    return 'Use your Royal VIP username and password to log in. If you forgot your credentials, reply Staff and our team will help through the reset flow.';
  }
  if (intent === 'needs_staff') {
    return 'Yes, staff can help you. Tell us what happened and we will check it for you.';
  }
  return `You are already registered${context.appbeg_username ? ` as ${context.appbeg_username}` : ''}. Tell us what you need help with, or reply Staff to reach a teammate.`;
}

export function formatSupportAiContextBlock(contactContext, recentMessages = '') {
  return [
    formatSupportAiRegistrationPromptRules(contactContext),
    `Registration phase: ${contactContext.registration_phase}`,
    contactContext.staff_takeover && contactContext.underlying_registration_phase
      ? `Underlying registration phase: ${contactContext.underlying_registration_phase}`
      : null,
    `Registration status: ${contactContext.registration_status}`,
    `AppBeg link status: ${contactContext.appbeg_link_status || 'not set'}`,
    `Current flow: ${contactContext.current_flow || 'none'}`,
    `Current step: ${contactContext.current_step || 'none'}`,
    `Payment window: ${contactContext.payment_window_status || 'none'}`,
    `Payment confirmed: ${contactContext.payment_confirmed ? 'yes' : 'no'}`,
    `Payment app: ${contactContext.payment_app || 'not collected'}`,
    `Payment name: ${contactContext.payment_display_name || 'not collected'}`,
    `Deposit amount: ${contactContext.deposit_amount ?? 'not collected'}`,
    `AppBeg username: ${contactContext.appbeg_username || 'not collected'}`,
    `AppBeg player UID: ${contactContext.appbeg_player_uid || 'not linked'}`,
    `AppBeg player exists in database: ${contactContext.appbeg_player_exists ? 'yes' : 'no'}`,
    `Account creation complete: ${contactContext.account_creation_complete ? 'yes' : 'no'}`,
    `Staff takeover: ${contactContext.staff_takeover ? 'yes' : 'no'}`,
    recentMessages
  ].filter(Boolean).join('\n');
}

export { formatSupportAiRegistrationPromptRules };
