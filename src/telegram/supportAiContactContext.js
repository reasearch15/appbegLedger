import { isUnregisteredStatus } from '../registration/utils.js';

const WANTS_REGISTRATION_PATTERNS = [
  /\b(want|need|make|create|get)\b.*\b(account|id|username)\b/i,
  /\bhow\b.*\b(register|sign ?up|join|start)\b/i,
  /\bcan i join\b/i,
  /\bregister me\b/i,
  /\bsign ?up\b/i,
  /\bwant to play\b/i,
  /\bhow do i start\b/i,
  /\bmake me an id\b/i,
  /\bcreate account\b/i,
  /\bnew account\b/i,
  /^(register|signup)$/i
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
  const appbegPlayerUid = info.appbeg_player_uid
    || contact.appbeg_account_id
    || info.preferred_appbeg_username
    || null;
  const wasRegistered = contact.registration_status === 'Registered'
    || Boolean(appbegPlayerUid)
    || Boolean(info.appbeg_creation_complete);
  const manualStaffTakeover = Boolean(contact.bot_paused)
    || Boolean(contact.needs_staff_review);

  const registrationPhase = classifyRegistrationPhase({
    contact,
    flow,
    step,
    info,
    paymentWindow,
    wasRegistered,
    manualStaffTakeover
  });

  const context = {
    contact_id: contact.id,
    registration_status: contact.registration_status || 'New',
    registration_phase: registrationPhase,
    current_flow: flow,
    current_step: step,
    payment_window_status: paymentWindow?.status || (activePaymentWindow ? 'active' : null),
    payment_confirmed: Boolean(info.payment_confirmed),
    payment_app: info.payment_method_name || info.payment_app || null,
    payment_display_name: info.payment_display_name || info.chime_payment_name || null,
    deposit_amount: info.first_deposit_amount ?? info.deposit_amount ?? null,
    appbeg_username: info.preferred_appbeg_username || null,
    appbeg_player_uid: appbegPlayerUid,
    account_creation_complete: Boolean(info.appbeg_creation_complete) || contact.registration_status === 'Registered',
    staff_takeover: manualStaffTakeover,
    was_registered: wasRegistered,
    payment_window_expires_at: paymentWindow?.expires_at || null,
    payment_window_id: paymentWindow?.id || info.registration_payment_window_id || null
  };

  console.log(`[support-ai] support_ai_contact_state_loaded contact=${contact.id} phase=${registrationPhase} status=${context.registration_status} step=${step || 'none'} flow=${flow || 'none'} registered=${wasRegistered}`);
  if (wasRegistered) {
    console.log(`[support-ai] support_ai_registered_contact contact=${contact.id} uid=${appbegPlayerUid || 'n/a'}`);
  } else {
    console.log(`[support-ai] support_ai_unregistered_contact contact=${contact.id} phase=${registrationPhase}`);
  }
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
  wasRegistered,
  manualStaffTakeover
}) {
  if (manualStaffTakeover) return 'manual_staff_takeover';
  if (wasRegistered || contact.registration_status === 'Registered') return 'registered';

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

export function buildSupportAiDecision({ messageText, contactContext }) {
  const text = String(messageText || '').trim();
  const phase = contactContext.registration_phase;
  const wantsRegistration = detectWantsRegistrationIntent(text);

  if (phase === 'manual_staff_takeover') {
    return {
      intent: wantsRegistration ? 'wants_registration' : 'general_support',
      recommended_action: 'send_support_reply',
      confidence: 0.95,
      reply_text: 'A staff member is already helping you here. Please wait for their reply or send any extra details you want them to see.',
      action_blocked_reason: 'manual_staff_takeover'
    };
  }

  if (phase === 'registered') {
    if (wantsRegistration) {
      console.log(`[support-ai] support_ai_registered_user_not_restarted contact=${contactContext.contact_id}`);
      return {
        intent: 'registered_support',
        recommended_action: 'send_support_reply',
        confidence: 0.92,
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

  if (wantsRegistration && (phase === 'not_registered' || phase === 'registration_expired')) {
    console.log(`[support-ai] support_ai_registration_intent_detected contact=${contactContext.contact_id}`);
    console.log(`[support-ai] support_ai_registration_start_recommended contact=${contactContext.contact_id}`);
    return {
      intent: 'wants_registration',
      recommended_action: 'start_registration_flow',
      confidence: 0.98,
      reply_text: 'Sure, I can help you get registered. First, which payment app will you use?'
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
    if (wantsRegistration) {
      console.log(`[support-ai] support_ai_existing_registration_continued contact=${contactContext.contact_id}`);
    }
    return {
      intent: wantsRegistration ? 'wants_registration' : 'registration_progress',
      recommended_action: 'continue_registration_flow',
      confidence: 0.88,
      reply_text: phase === 'registration_expired'
        ? 'Your previous payment window expired. Reply Register if you want to start registration again from the beginning.'
        : 'You already have registration in progress. Please answer the current registration question so we can continue.'
    };
  }

  if (wantsRegistration) {
    return {
      intent: 'wants_registration',
      recommended_action: 'start_registration_flow',
      confidence: 0.9,
      reply_text: 'Sure, I can help you get registered. First, which payment app will you use?'
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

function buildRegisteredPlayReply(text, context) {
  if (/\b(play|game|start)\b/i.test(text)) {
    return 'You already have an AppBeg account. Open AppBeg, log in with your username and password, and you can start playing from there.';
  }
  return buildRegisteredSupportReply(text, context);
}

function buildRegisteredSupportReply(text, context) {
  const intent = detectRegisteredIntent(text);
  if (intent === 'deposit_question') {
    return 'You can use the Load Coin option in AppBeg. Make sure the payment name matches the one registered with your account.';
  }
  if (intent === 'withdrawal_question') {
    return 'For withdrawals, open AppBeg and follow the cash-out steps. If something fails, reply Staff and our team will review it.';
  }
  if (intent === 'bonus_question') {
    return 'Bonus rules depend on the offer. Tell us which bonus you mean and staff will explain the details.';
  }
  if (intent === 'login_help') {
    return 'Use your AppBeg username and password to log in. If you forgot your credentials, reply Staff and our team will help through the reset flow.';
  }
  if (intent === 'needs_staff') {
    return 'Yes, staff can help you. Tell us what happened and we will check it for you.';
  }
  return `You are already registered${context.appbeg_username ? ` as ${context.appbeg_username}` : ''}. Tell us what you need help with, or reply Staff to reach a teammate.`;
}

export function formatSupportAiContextBlock(contactContext, recentMessages = '') {
  return [
    `Registration phase: ${contactContext.registration_phase}`,
    `Registration status: ${contactContext.registration_status}`,
    `Current flow: ${contactContext.current_flow || 'none'}`,
    `Current step: ${contactContext.current_step || 'none'}`,
    `Payment window: ${contactContext.payment_window_status || 'none'}`,
    `Payment confirmed: ${contactContext.payment_confirmed ? 'yes' : 'no'}`,
    `Payment app: ${contactContext.payment_app || 'not collected'}`,
    `Payment name: ${contactContext.payment_display_name || 'not collected'}`,
    `Deposit amount: ${contactContext.deposit_amount ?? 'not collected'}`,
    `AppBeg username: ${contactContext.appbeg_username || 'not collected'}`,
    `AppBeg player UID: ${contactContext.appbeg_player_uid || 'not linked'}`,
    `Account creation complete: ${contactContext.account_creation_complete ? 'yes' : 'no'}`,
    `Staff takeover: ${contactContext.staff_takeover ? 'yes' : 'no'}`,
    recentMessages
  ].filter(Boolean).join('\n');
}
