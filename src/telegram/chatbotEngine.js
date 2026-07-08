import {
  normalizeAppBegUsername,
  normalizePaymentTag,
  isUnregisteredStatus,
  chatbotWelcomeCooldownMs,
  parseFirstDepositAmount
} from '../registration/utils.js';

export const BOT_REGISTRATION_STEPS = [
  'welcome',
  'payment_app',
  'chime_payment_name',
  'first_deposit_amount',
  'await_payment_done',
  'username',
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
  [{ label: '📝 Register', action: 'register', text: '📝 Register', data: 'register' }],
  [{ label: '💬 Talk to Staff', action: 'staff', text: '💬 Talk to Staff', data: 'staff' }]
];

export const REVIEW_BUTTONS = [
  [
    { label: 'Confirm', action: 'confirm', text: 'Confirm', data: 'confirm' },
    { label: 'Edit', action: 'edit', text: 'Edit', data: 'edit' }
  ],
  [{ label: 'Cancel', action: 'cancel', text: 'Cancel', data: 'cancel' }]
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
  const value = normalizeCallbackAction(action);
  if (!value) return false;
  return value.startsWith('bot:')
    || value.startsWith('staff')
    || value === 'register'
    || value === 'confirm'
    || value === 'edit'
    || value === 'cancel'
    || value === 'flow:registration_info'
    || value.startsWith('bot:payment_app:')
    || value.startsWith('payment_app:');
}

export function normalizeCallbackAction(action) {
  const raw = String(action || '').trim();
  if (!raw) return '';
  const aliases = {
    register: 'bot:register',
    staff: 'staff:takeover',
    'talk_to_staff': 'staff:takeover',
    'bot:talk_to_staff': 'staff:takeover',
    confirm: 'bot:confirm',
    edit: 'bot:edit',
    cancel: 'bot:cancel'
  };
  if (aliases[raw]) return aliases[raw];
  if (raw.startsWith('payment_app:') && !raw.startsWith('bot:')) {
    return `bot:${raw}`;
  }
  return raw;
}

export function paymentAppButtons() {
  return [
    PAYMENT_APP_OPTIONS.slice(0, 2).map((item) => ({
      label: item.label,
      action: item.action,
      text: item.label,
      data: item.action
    })),
    PAYMENT_APP_OPTIONS.slice(2, 4).map((item) => ({
      label: item.label,
      action: item.action,
      text: item.label,
      data: item.action
    })),
    [PAYMENT_APP_OPTIONS[4]].map((item) => ({
      label: item.label,
      action: item.action,
      text: item.label,
      data: item.action
    }))
  ];
}

export async function decideBotReply({ store, contact, messageText = '', action = null }) {
  const text = String(messageText || '').trim();
  action = normalizeCallbackAction(action) || null;
  const automationState = await store.ensureAutomationState(contact.id);
  const info = { ...(automationState.registration_info || {}) };
  const flow = automationState.current_flow;
  const step = automationState.current_step || 'welcome';

  // Exact text commands work without inline buttons (Telethon user sessions).
  if (!action && isStaffCommand(text)) {
    action = 'staff:takeover';
  } else if (!action && isStartRegistrationCommand(text) && shouldStartRegistration(step, flow, contact)) {
    action = 'bot:register';
  } else if (!action && isConfirmCommand(text) && step === 'review' && (flow === 'bot_registration' || flow === 'registration_info')) {
    action = 'bot:confirm';
  } else if (!action && isEditCommand(text) && (flow === 'bot_registration' || flow === 'registration_info')) {
    action = 'bot:edit';
  } else if (!action && isCancelCommand(text) && (flow === 'bot_registration' || flow === 'registration_info')) {
    action = 'bot:cancel';
  }

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

  if (action === 'staff:takeover' || action === 'bot:talk_to_staff') {
    return talkToStaffDecision();
  }

  if (action === 'bot:cancel') {
    return cancelRegistrationDecision(contact, info);
  }

  if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status === 'Registered') {
    return decideRegisteredSupport({ text, action });
  }

  if (action === 'flow:registration_info' || action === 'bot:register') {
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
    return await continueRegistrationDecision({
      store,
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
      text: 'I’m here and ready — tell me what you need.\n\nReply Staff if you’d rather chat with a human.'
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
      text: welcomeMessage()
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
      text
      // Text-only welcome: Telethon user/business sessions cannot render
      // Bot-style inline callback buttons reliably.
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
        text: 'You’re all set on registration. Tell me what you need help with (deposit, cash out, login hiccup—whatever).\n\nReply Staff anytime to reach a human teammate.'
      }],
      statePatch: null,
      escalate: false
    };
  }

  return {
    kind: 'registered_support',
    replies: [{
      text: 'You’re all set on registration. Tell me what you need help with.\n\nReply Staff anytime to reach a human teammate.'
    }],
    statePatch: null,
    escalate: false
  };
}

function startRegistrationDecision(contact, info) {
  return {
    kind: 'registration_ask_payment_app',
    replies: [{
      text: registrationPaymentAppPrompt()
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'payment_app',
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

function registrationPaymentAppPrompt() {
  return `To register, you need to make your first payment to our app.

Which payment app are you going to use?
1️⃣ Chime
2️⃣ Cash App
3️⃣ Venmo`;
}

function parseRegistrationPaymentApp(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return null;
  if (value === '1' || /\bchime\b/.test(value)) return 'chime';
  if (value === '2' || /\bcash\s*app\b/.test(value) || value === 'cashapp') return 'cash_app';
  if (value === '3' || /\bvenmo\b/.test(value)) return 'venmo';
  return null;
}

function chimeUnavailableReply(info = {}) {
  return {
    kind: 'registration_payment_app_unavailable',
    replies: [{
      text: 'Sorry, we only have Chime available at the moment.'
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'payment_app',
      registrationInfo: info
    },
    escalate: false
  };
}

function formatDepositAmount(amount) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function chimeQrCaption({ firstDepositAmount, chimePaymentName }) {
  return [
    `Please send ${formatDepositAmount(firstDepositAmount)} using this Chime QR.`,
    `Use the Chime name:`,
    chimePaymentName,
    'After sending, reply Done.',
    'This payment window is valid for 5 minutes.'
  ].join('\n');
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

async function continueRegistrationDecision({ store, contact, text, action, step, info, flow, automationState = null }) {
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
    if (isStartRegistrationCommand(text)) {
      return startRegistrationDecision(contact, info);
    }
    return welcomeDecision(contact, info, automationState);
  }

  if (normalizedStep === 'payment_app') {
    if (!text) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{ text: registrationPaymentAppPrompt() }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    const selected = parseRegistrationPaymentApp(text);
    if (!selected) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{ text: registrationPaymentAppPrompt() }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    if (selected === 'cash_app' || selected === 'venmo') {
      return chimeUnavailableReply(info);
    }
    return {
      kind: 'registration_ask_chime_payment_name',
      replies: [{
        text: `Please send your Chime payment name.
This should be the name shown on your Chime payment, not a $tag.`
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'chime_payment_name',
        registrationInfo: { ...info, payment_app: 'chime' }
      },
      escalate: false,
      logEvent: { event: 'payment_app_selected', paymentApp: 'chime' }
    };
  }

  if (normalizedStep === 'chime_payment_name') {
    if (!text || text.length < 2) {
      return {
        kind: 'registration_ask_chime_payment_name',
        replies: [{
          text: `Please send your Chime payment name.
This should be the name shown on your Chime payment, not a $tag.`
        }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'chime_payment_name', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = { ...info, chime_payment_name: text.trim(), payment_app: 'chime' };
    return {
      kind: 'registration_ask_first_deposit_amount',
      replies: [{
        text: 'How much are you going to deposit for your first payment?'
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'first_deposit_amount',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'chime_payment_name_collected', chimePaymentName: text.trim() }
    };
  }

  if (normalizedStep === 'first_deposit_amount') {
    const amount = parseFirstDepositAmount(text);
    if (amount == null) {
      return {
        kind: 'registration_first_deposit_invalid',
        replies: [{
          text: 'Please enter a valid deposit amount, for example 10 or 25.50.'
        }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'first_deposit_amount', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'first_deposit_amount_invalid', input: text || '' }
      };
    }
    const nextInfo = {
      ...info,
      first_deposit_amount: amount,
      payment_app: 'chime'
    };
    return {
      kind: 'registration_send_chime_qr',
      replies: [],
      sendChimeQr: {
        chimePaymentName: nextInfo.chime_payment_name,
        firstDepositAmount: amount
      },
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'first_deposit_amount',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'first_deposit_amount_collected', firstDepositAmount: amount }
    };
  }

  if (normalizedStep === 'await_payment_done') {
    if (!isDoneCommand(text)) {
      return {
        kind: 'registration_await_payment_done',
        replies: [{
          text: 'When you have sent your Chime payment, reply Done.'
        }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'await_payment_done', registrationInfo: info },
        escalate: false
      };
    }
    return await handleRegistrationPaymentDone({ store, contact, info });
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
    if (nextInfo.chime_payment_name && nextInfo.first_deposit_amount) {
      return reviewDecision(nextInfo);
    }
    return {
      kind: 'registration_ask_payment_app',
      replies: [{
        text: paymentAppPrompt(text)
      }],
      statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: nextInfo },
      escalate: false,
      logEvent: { event: 'username_collected', username: text }
    };
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

async function handleRegistrationPaymentDone({ store, contact, info }) {
  const window = await store.getActiveRegistrationPaymentWindow(contact.id);
  const expired = !window || new Date(window.expires_at).getTime() <= Date.now();
  if (expired) {
    return {
      kind: 'registration_payment_expired',
      expirePaymentWindowId: window?.id || null,
      replies: [{
        text: 'This payment window has expired. Please type Register to start again.'
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'welcome',
        registrationInfo: info
      },
      escalate: false,
      logEvent: { event: 'registration_payment_window_expired' }
    };
  }
  return {
    kind: 'registration_payment_done',
    completePaymentWindowId: window.id,
    replies: [{
      text: 'Thanks! We noted your payment. What username would you like for your account?'
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'username',
      registrationInfo: info
    },
    escalate: false,
    logEvent: { event: 'registration_payment_window_completed', windowId: window.id }
  };
}

function reviewDecision(info) {
  const paymentLines = info.chime_payment_name
    ? [
      '• Payment app: Chime',
      `• Chime payment name: ${info.chime_payment_name}`,
      `• First deposit: $${formatDepositAmount(info.first_deposit_amount)}`
    ]
    : [
      `• Payment app: ${info.payment_app || info.preferred_game || '—'}`,
      `• Payment tag: ${info.payment_tag || '—'}`
    ];
  const summary = [
    'Please confirm these details:',
    `• Username: ${info.preferred_appbeg_username || '—'}`,
    ...paymentLines,
    '',
    'Reply with one of:',
    'Confirm',
    'Edit',
    'Cancel'
  ].join('\n');

  return {
    kind: 'registration_review',
    replies: [{
      text: summary
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

I'm here to help you get started.

If you'd like to create an account, just reply:

Register

If you'd rather speak with one of our staff members, simply reply:

Staff

You can also ask me questions at any time. 😊`;
}

function welcomeNudgeMessage() {
  return `You're not registered yet.

Reply Register to create an account, or Staff to speak with our team.`;
}

function paymentAppPrompt(username = null) {
  const intro = username ? `Nice pick: ${username}.\n\n` : '';
  return `${intro}${registrationPaymentAppPrompt()}`;
}

function shouldStartRegistration(step, flow, contact) {
  if (step === 'welcome') return true;
  if (!flow && isUnregisteredStatus(contact.registration_status)) return true;
  return false;
}

function isStartRegistrationCommand(text) {
  return /^(register|ok|yes|start|signup|\/register)$/i.test(String(text || '').trim());
}

function isDoneCommand(text) {
  return /^done$/i.test(String(text || '').trim());
}

function isRegisterCommand(text) {
  return isStartRegistrationCommand(text);
}

function isStaffCommand(text) {
  return /^(staff|\/staff|talk to staff|human|agent)$/i.test(String(text || '').trim());
}

function isConfirmCommand(text) {
  return /^(confirm|yes|y|ok|okay)$/i.test(String(text || '').trim());
}

function isEditCommand(text) {
  return /^(edit|change|fix|no|n)$/i.test(String(text || '').trim());
}

function isCancelCommand(text) {
  return /^(cancel|stop|quit)$/i.test(String(text || '').trim());
}

export {
  chimeQrCaption,
  formatDepositAmount,
  parseRegistrationPaymentApp,
  registrationPaymentAppPrompt
};

export function registrationStatusLabel(contact) {
  if (contact?.needs_staff_review) return 'Needs staff review';
  if (contact?.bot_paused) return 'Bot paused';
  if (contact?.bot_enabled === false || contact?.bot_enabled === 0) return 'Bot off';
  return 'Bot active';
}
