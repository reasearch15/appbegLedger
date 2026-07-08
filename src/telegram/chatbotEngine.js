import {
  normalizeAppBegUsername,
  normalizePaymentTag,
  isUnregisteredStatus,
  chatbotWelcomeCooldownMs
} from '../registration/utils.js';

export const BOT_REGISTRATION_STEPS = [
  'welcome',
  'username',
  'payment_app',
  'payment_app_other',
  'payment_tag',
  'review',
  'complete'
];

export const PAYMENT_APP_OPTIONS = [
  { label: 'Cash App', action: 'bot:payment_app:Cash App', value: 'Cash App' },
  { label: 'Chime', action: 'bot:payment_app:Chime', value: 'Chime' },
  { label: 'Zelle', action: 'bot:payment_app:Zelle', value: 'Zelle' },
  { label: 'Apple Pay', action: 'bot:payment_app:Apple Pay', value: 'Apple Pay' },
  { label: 'Other', action: 'bot:payment_app:Other', value: 'Other' }
];

export const WELCOME_BUTTONS = [
  [{ label: '📝 Register', action: 'bot:register' }],
  [{ label: '💬 Talk to Staff', action: 'staff:takeover' }]
];

export const REVIEW_BUTTONS = [
  [{ label: 'Confirm', action: 'bot:confirm' }, { label: 'Edit', action: 'bot:edit' }],
  [{ label: 'Cancel', action: 'bot:cancel' }]
];

const INSULT_PATTERNS = [
  /\b(stupid|idiot|dumb|hate you|shut up|fuck|shit|asshole|bitch|bastard|moron|retard)\b/i,
  /\byou suck\b/i
];

const STAFF_ESCALATION_PATTERNS = [
  /\b(wire|crypto|bitcoin|usdt|bank transfer|account number|ssn|password|otp|pin code)\b/i,
  /\b(lawyer|police|sue|lawsuit|fraud|scam chargeback)\b/i,
  /\b(kill|die|suicide|bomb|terror)\b/i,
  /\b(give me money|send cash|loan me)\b/i
];

const SUPPORT_PATTERNS = [
  /\b(help|support|human|agent|staff|deposit|cash ?out|withdraw|balance|login)\b/i
];

const AFFIRM_PATTERNS = /^(yes|y|ok|okay|confirm|correct|looks good|sure|yea|yeah|yep|approve)\b/i;
const NEGATE_PATTERNS = /^(no|n|edit|wrong|change|fix|back)\b/i;

export function detectInsult(text = '') {
  return INSULT_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectStaffEscalation(text = '') {
  return STAFF_ESCALATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function isBotActiveForContact(contact) {
  if (!contact) return false;
  if (contact.bot_enabled === false || contact.bot_enabled === 0) return false;
  if (contact.bot_paused === true || contact.bot_paused === 1) return false;
  if (contact.needs_staff_review === true || contact.needs_staff_review === 1) return false;
  return true;
}

export function isChatbotButtonAction(action) {
  const value = String(action || '');
  return value.startsWith('bot:')
    || value.startsWith('staff:')
    || value === 'flow:registration_info';
}

export function paymentAppButtons() {
  return [
    PAYMENT_APP_OPTIONS.slice(0, 2).map((item) => ({ label: item.label, action: item.action })),
    PAYMENT_APP_OPTIONS.slice(2, 4).map((item) => ({ label: item.label, action: item.action })),
    [PAYMENT_APP_OPTIONS[4]].map((item) => ({ label: item.label, action: item.action }))
  ];
}

export async function decideBotReply({ store, contact, messageText = '', action = null }) {
  const text = String(messageText || '').trim();
  const automationState = await store.ensureAutomationState(contact.id);
  const info = { ...(automationState.registration_info || {}) };
  const flow = automationState.current_flow;
  const step = automationState.current_step || 'welcome';

  if (detectInsult(text) && !action) {
    return {
      kind: 'insult_soft',
      replies: [{
        text: 'Haha, my digital heart is a little fragile 😅 What went wrong? I’ll try to help.'
      }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'insult_soft_reply' }
    };
  }

  if (detectStaffEscalation(text) && !action) {
    return {
      kind: 'escalate',
      replies: [{
        text: 'That one might need a human pair of eyes. I’m looping in staff now so nothing risky slips through. Hang tight!'
      }],
      statePatch: null,
      escalate: true,
      escalateReason: 'risky_or_financial_request',
      logEvent: { event: 'handoff_required', reason: 'risky_or_financial_request' }
    };
  }

  if (action === 'staff:takeover' || action === 'bot:talk_to_staff' || /^\/staff\b/i.test(text)) {
    return talkToStaffDecision();
  }

  if (action === 'bot:cancel') {
    return cancelRegistrationDecision(contact, info);
  }

  if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status === 'Registered') {
    return decideRegisteredSupport({ text, action });
  }

  if (action === 'flow:registration_info' || action === 'bot:register' || /^\/register\b/i.test(text)) {
    return startRegistrationDecision(contact, info);
  }

  if (String(action || '').startsWith('bot:payment_app:')) {
    return selectPaymentAppDecision({
      contact,
      info,
      selected: String(action).slice('bot:payment_app:'.length)
    });
  }

  if (flow === 'bot_registration' || flow === 'registration_info') {
    return continueRegistrationDecision({
      contact,
      text,
      action,
      step,
      info,
      flow,
      automationState
    });
  }

  if (isUnregisteredStatus(contact.registration_status)) {
    return welcomeDecision(contact, info, automationState);
  }

  return {
    kind: 'fallback_support',
    replies: [{
      text: 'I’m here and ready — tell me what you need, or tap below if you’d rather chat with a human.',
      buttons: [[{ label: '💬 Talk to Staff', action: 'staff:takeover' }]]
    }],
    statePatch: null,
    escalate: false
  };
}

function talkToStaffDecision() {
  return {
    kind: 'talk_to_staff',
    replies: [{
      text: 'No problem. A staff member will assist you shortly.'
    }],
    statePatch: {
      currentFlow: null,
      currentStep: null
    },
    escalate: true,
    escalateReason: 'manual_support',
    logEvent: { event: 'button_clicked', action: 'staff:takeover' }
  };
}

function cancelRegistrationDecision(contact, info) {
  return {
    kind: 'registration_cancelled',
    replies: [{
      text: welcomeMessage(),
      buttons: WELCOME_BUTTONS
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'welcome',
      registrationInfo: info
    },
    setStatus: contact.registration_status === 'Collecting Info' ? 'New' : undefined,
    markWelcomeSent: true,
    escalate: false,
    logEvent: { event: 'registration_cancelled' }
  };
}

function welcomeDecision(contact, info, automationState = null, { forceFull = false } = {}) {
  const throttled = !forceFull && isWelcomeThrottled(automationState);
  const text = throttled
    ? welcomeNudgeMessage()
    : welcomeMessage();

  return {
    kind: throttled ? 'welcome_nudge' : 'welcome',
    replies: [{
      text,
      buttons: WELCOME_BUTTONS
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'welcome',
      registrationInfo: {
        ...info,
        telegram_display_name: contact.display_name,
        telegram_username: contact.username || null,
        telegram_user_id: contact.telegram_id
      }
    },
    markWelcomeSent: true,
    escalate: false,
    logEvent: {
      event: throttled ? 'welcome_nudged' : 'welcome_shown',
      throttled,
      flow: 'bot_registration',
      step: 'welcome'
    }
  };
}

function isWelcomeThrottled(automationState) {
  const cooldown = chatbotWelcomeCooldownMs();
  if (!cooldown) return false;
  const last = automationState?.last_auto_welcome_at;
  if (!last) return false;
  const elapsed = Date.now() - new Date(last).getTime();
  if (Number.isNaN(elapsed)) return false;
  return elapsed < cooldown;
}

function decideRegisteredSupport({ text, action }) {
  if (action === 'staff:takeover' || /\b(human|agent|staff)\b/i.test(text)) {
    return talkToStaffDecision();
  }

  if (SUPPORT_PATTERNS.test(text)) {
    return {
      kind: 'registered_support',
      replies: [{
        text: 'You’re all set on registration. Tell me what you need help with (deposit, cash out, login hiccup—whatever), or I can grab a human teammate.',
        buttons: [[{ label: '💬 Talk to Staff', action: 'staff:takeover' }]]
      }],
      statePatch: null,
      escalate: false
    };
  }

  return {
    kind: 'registered_support',
    replies: [{
      text: 'You’re all set on registration. Tell me what you need help with, or tap below for a human teammate.',
      buttons: [[{ label: '💬 Talk to Staff', action: 'staff:takeover' }]]
    }],
    statePatch: null,
    escalate: false
  };
}

function startRegistrationDecision(contact, info) {
  return {
    kind: 'registration_ask_username',
    replies: [{
      text: 'Great! Let’s get you registered. What username would you like?'
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'username',
      registrationInfo: {
        ...info,
        telegram_display_name: contact.display_name,
        telegram_username: contact.username || null,
        telegram_user_id: contact.telegram_id,
        registration_method: 'chatbot'
      }
    },
    setStatus: 'Collecting Info',
    escalate: false,
    logEvent: { event: 'registration_started' }
  };
}

function selectPaymentAppDecision({ info, selected }) {
  if (selected === 'Other') {
    return {
      kind: 'registration_ask_payment_app_other',
      replies: [{
        text: 'Got it — which payment app should we list as Other?'
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'payment_app_other',
        registrationInfo: info
      },
      escalate: false,
      logEvent: { event: 'payment_app_selected', paymentApp: 'Other' }
    };
  }

  const nextInfo = {
    ...info,
    preferred_game: selected,
    payment_app: selected
  };
  return {
    kind: 'registration_ask_payment_tag',
    replies: [{
      text: `Perfect — ${selected}. What’s your payment name/tag for deposits?`
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'payment_tag',
      registrationInfo: nextInfo
    },
    escalate: false,
    logEvent: { event: 'payment_app_selected', paymentApp: selected }
  };
}

function continueRegistrationDecision({ contact, text, action, step, info, flow, automationState = null }) {
  const normalizedStep = normalizeStep(step, flow);

  if (action === 'bot:confirm' || (normalizedStep === 'review' && AFFIRM_PATTERNS.test(text))) {
    return {
      kind: 'registration_complete',
      replies: [{
        text: "Perfect — I've saved your details for a quick staff check. You're almost in! 🎉"
      }],
      statePatch: {
        currentFlow: null,
        currentStep: null,
        registrationInfo: { ...info, registration_method: 'chatbot' }
      },
      completeRegistration: true,
      escalate: false,
      logEvent: { event: 'registration_completed' }
    };
  }

  if (action === 'bot:edit' || (normalizedStep === 'review' && NEGATE_PATTERNS.test(text))) {
    return {
      kind: 'registration_ask_username',
      replies: [{ text: 'No problem — let’s tweak it. What username would you like?' }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'username',
        registrationInfo: info
      },
      escalate: false,
      logEvent: { event: 'registration_edit_started' }
    };
  }

  if (normalizedStep === 'welcome') {
    // Stay on welcome until Register is clicked — never treat "hello" as starting registration,
    // and never permanently suppress follow-up replies.
    return welcomeDecision(contact, info, automationState);
  }

  if (normalizedStep === 'username') {
    if (!text || text.length < 2) {
      return {
        kind: 'registration_ask_username',
        replies: [{ text: 'I need a username with at least a couple of characters. What username would you like?' }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'username', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = {
      ...info,
      preferred_appbeg_username: text,
      preferred_appbeg_username_normalized: normalizeAppBegUsername(text)
    };
    return {
      kind: 'registration_ask_payment_app',
      replies: [{
        text: `Nice pick: ${text}.\n\nWhich payment app do you use?`,
        buttons: paymentAppButtons()
      }],
      statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: nextInfo },
      escalate: false,
      logEvent: { event: 'username_collected', username: text }
    };
  }

  if (normalizedStep === 'payment_app') {
    // Prefer buttons; typed text is accepted as a fallback.
    if (!text) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{
          text: 'Please choose a payment app below.',
          buttons: paymentAppButtons()
        }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    return selectPaymentAppDecision({ info, selected: text });
  }

  if (normalizedStep === 'payment_app_other') {
    if (!text) {
      return {
        kind: 'registration_ask_payment_app_other',
        replies: [{ text: 'Which payment app should we list as Other?' }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app_other', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = { ...info, preferred_game: text, payment_app: text };
    return {
      kind: 'registration_ask_payment_tag',
      replies: [{ text: `Got it — ${text}. What’s your payment name/tag for deposits?` }],
      statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_tag', registrationInfo: nextInfo },
      escalate: false,
      logEvent: { event: 'payment_app_selected', paymentApp: text }
    };
  }

  if (normalizedStep === 'payment_tag') {
    if (!text) {
      return {
        kind: 'registration_ask_payment_tag',
        replies: [{ text: 'I’ll need that payment tag to keep deposits tidy. What tag should we use?' }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_tag', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = {
      ...info,
      payment_tag: text,
      payment_tag_normalized: normalizePaymentTag(text)
    };
    return reviewDecision(nextInfo);
  }

  if (normalizedStep === 'review' || normalizedStep === 'complete') {
    return reviewDecision(info);
  }

  return startRegistrationDecision(contact, info);
}

function reviewDecision(info) {
  const summary = [
    'Please confirm these details:',
    `• Username: ${info.preferred_appbeg_username || '—'}`,
    `• Payment app: ${info.payment_app || info.preferred_game || '—'}`,
    `• Payment tag: ${info.payment_tag || '—'}`
  ].join('\n');

  return {
    kind: 'registration_review',
    replies: [{
      text: `${summary}\n\nLooks good?`,
      buttons: REVIEW_BUTTONS
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'review',
      registrationInfo: info
    },
    escalate: false,
    logEvent: { event: 'registration_review_shown' }
  };
}

function normalizeStep(step, flow) {
  if (flow === 'registration_info') {
    if (step === 'appbeg_username') return 'username';
    if (step === 'confirm') return 'review';
  }
  if (BOT_REGISTRATION_STEPS.includes(step)) return step;
  return 'welcome';
}

function welcomeMessage() {
  return `👋 Hey! Welcome to Royal VIP.

It looks like you're not registered with us yet.

Choose an option below.`;
}

function welcomeNudgeMessage() {
  return `You're not registered yet. Tap Register below to start.`;
}

export function registrationStatusLabel(contact) {
  if (contact?.needs_staff_review) return 'Needs staff review';
  if (contact?.bot_paused) return 'Bot paused';
  if (contact?.bot_enabled === false || contact?.bot_enabled === 0) return 'Bot off';
  return 'Bot active';
}
