import {
  normalizeAppBegUsername,
  normalizePaymentTag,
  registrationCompletionStatus,
  isUnregisteredStatus
} from '../registration/utils.js';

export const BOT_REGISTRATION_STEPS = [
  'welcome',
  'username',
  'payment_app',
  'payment_tag',
  'review',
  'complete'
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

export async function decideBotReply({ store, contact, messageText = '', action = null }) {
  const text = String(messageText || '').trim();
  const automationState = await store.ensureAutomationState(contact.id);
  const info = { ...(automationState.registration_info || {}) };
  const flow = automationState.current_flow;
  const step = automationState.current_step || 'welcome';

  if (detectInsult(text)) {
    return {
      kind: 'insult_soft',
      replies: [{
        text: 'Haha, my digital heart is a little fragile 😅 What went wrong? I’ll try to help.'
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (detectStaffEscalation(text)) {
    return {
      kind: 'escalate',
      replies: [{
        text: 'That one might need a human pair of eyes. I’m looping in staff now so nothing risky slips through. Hang tight!'
      }],
      statePatch: null,
      escalate: true,
      escalateReason: 'risky_or_financial_request'
    };
  }

  if (action === 'staff:takeover' || /^\/staff\b/i.test(text)) {
    return {
      kind: 'escalate',
      replies: [{ text: 'Got it — transferring you to a teammate. Someone will jump in shortly.' }],
      statePatch: null,
      escalate: true,
      escalateReason: 'user_requested_staff'
    };
  }

  if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status === 'Registered') {
    return decideRegisteredSupport({ text, action });
  }

  if (action === 'flow:registration_info' || action === 'bot:register' || /^\/register\b/i.test(text)) {
    return startRegistrationDecision(contact, info);
  }

  if (flow === 'bot_registration' || flow === 'registration_info') {
    return continueRegistrationDecision({ contact, text, action, step, info, flow });
  }

  if (isUnregisteredStatus(contact.registration_status)) {
    return {
      kind: 'welcome',
      replies: [{
        text: welcomeCopy(contact),
        buttons: [[{ label: 'Register', action: 'bot:register' }], [{ label: 'Talk to staff', action: 'staff:takeover' }]]
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
      escalate: false
    };
  }

  return {
    kind: 'fallback_support',
    replies: [{
      text: 'I’m here and ready — tell me what you need, or tap below if you’d rather chat with a human.',
      buttons: [[{ label: 'Talk to staff', action: 'staff:takeover' }]]
    }],
    statePatch: null,
    escalate: false
  };
}

function decideRegisteredSupport({ text, action }) {
  if (action === 'staff:takeover' || SUPPORT_PATTERNS.test(text) || !text) {
    if (action === 'staff:takeover' || /\b(human|agent|staff)\b/i.test(text)) {
      return {
        kind: 'escalate',
        replies: [{ text: 'Absolutely — looping in staff for you. Thanks for your patience!' }],
        statePatch: null,
        escalate: true,
        escalateReason: 'registered_support_handoff'
      };
    }
  }

  return {
    kind: 'registered_support',
    replies: [{
      text: 'You’re all set on registration. Tell me what you need help with (deposit, cash out, login hiccup—whatever), or I can grab a human teammate.',
      buttons: [[{ label: 'Talk to staff', action: 'staff:takeover' }]]
    }],
    statePatch: null,
    escalate: false
  };
}

function startRegistrationDecision(contact, info) {
  return {
    kind: 'registration_ask_username',
    replies: [{
      text: `Awesome${contact.display_name ? `, ${firstName(contact)}` : ''}! Let’s get you registered.\n\nWhat AppBeg username would you like?`
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
    escalate: false
  };
}

function continueRegistrationDecision({ contact, text, action, step, info, flow }) {
  const normalizedStep = normalizeStep(step, flow);

  if (action === 'bot:confirm' || (normalizedStep === 'review' && AFFIRM_PATTERNS.test(text))) {
    return {
      kind: 'registration_complete',
      replies: [{
        text: "Perfect — I've packed up your details and sent them for a quick staff check. You're almost in the club! 🎉"
      }],
      statePatch: {
        currentFlow: null,
        currentStep: null,
        registrationInfo: { ...info, registration_method: 'chatbot' }
      },
      completeRegistration: true,
      escalate: false
    };
  }

  if (action === 'bot:edit' || (normalizedStep === 'review' && NEGATE_PATTERNS.test(text))) {
    return {
      kind: 'registration_ask_username',
      replies: [{ text: 'No problem — let’s tweak it. What AppBeg username should we use?' }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'username',
        registrationInfo: info
      },
      escalate: false
    };
  }

  if (normalizedStep === 'welcome') {
    return startRegistrationDecision(contact, info);
  }

  if (normalizedStep === 'username') {
    if (!text || text.length < 2) {
      return {
        kind: 'registration_ask_username',
        replies: [{ text: 'I need a username with at least a couple of characters. What AppBeg username would you like?' }],
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
      replies: [{ text: `Nice pick: ${text}. Which payment app do you use? (Cash App, Venmo, etc.)` }],
      statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: nextInfo },
      escalate: false
    };
  }

  if (normalizedStep === 'payment_app') {
    if (!text) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{ text: 'Which payment app should we note for you?' }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = { ...info, preferred_game: text, payment_app: text };
    return {
      kind: 'registration_ask_payment_tag',
      replies: [{ text: `Got it — ${text}. What’s your payment name/tag for deposits?` }],
      statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_tag', registrationInfo: nextInfo },
      escalate: false
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
    `• AppBeg username: ${info.preferred_appbeg_username || '—'}`,
    `• Payment app: ${info.payment_app || info.preferred_game || '—'}`,
    `• Payment tag: ${info.payment_tag || '—'}`
  ].join('\n');

  return {
    kind: 'registration_review',
    replies: [{
      text: `${summary}\n\nLooks good?`,
      buttons: [
        [{ label: 'Confirm', action: 'bot:confirm' }],
        [{ label: 'Edit', action: 'bot:edit' }]
      ]
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'review',
      registrationInfo: info
    },
    escalate: false
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

function welcomeCopy(contact) {
  const name = firstName(contact);
  return `Hey${name ? ` ${name}` : ''}! Welcome to Royal VIP 👋\n\nIt looks like you’re not registered with us yet.\nTap Register and I’ll walk you through it — one fun step at a time.`;
}

function firstName(contact) {
  return String(contact.first_name || contact.display_name || '')
    .split(/\s+/)[0]
    .replace(/[^\w.-]/g, '')
    .slice(0, 24);
}

export function registrationStatusLabel(contact) {
  if (contact?.needs_staff_review) return 'Needs staff review';
  if (contact?.bot_paused) return 'Bot paused';
  if (contact?.bot_enabled === false || contact?.bot_enabled === 0) return 'Bot off';
  return 'Bot active';
}
