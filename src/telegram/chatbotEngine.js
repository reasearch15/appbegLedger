import {
  normalizePaymentTag,
  isUnregisteredStatus,
  chatbotWelcomeCooldownMs,
  parseFirstDepositAmount,
  isReferralSkipInput
} from '../registration/utils.js';
import {
  APPBEG_PASSWORD_HELP,
  APPBEG_USERNAME_HELP,
  validateAppBegPassword,
  validateAppBegUsername
} from '../registration/appbegValidation.js';
import {
  formatDepositAmount,
  parsePaymentMethodSelection,
  paymentDisplayNamePrompt,
  paymentMethodUnavailableMessage,
  paymentQrCaption,
  registrationPaymentAppPrompt
} from '../payments/methodUtils.js';

export const BOT_REGISTRATION_STEPS = [
  'welcome',
  'payment_app',
  'payment_display_name',
  'first_deposit_amount',
  'await_payment_done',
  'waiting_for_payment_confirmation',
  'username',
  'password',
  'referral_code',
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
  [{ label: 'Register', action: 'bot:register', text: 'Register', data: 'bot:register' }],
  [
    { label: 'How It Works', action: 'bot:how_it_works', text: 'How It Works', data: 'bot:how_it_works' },
    { label: 'Contact Support', action: 'staff:takeover', text: 'Contact Support', data: 'staff:takeover' }
  ]
];

export const IN_PROGRESS_BUTTONS = [
  [{ label: 'Continue Registration', action: 'bot:continue_registration', text: 'Continue Registration', data: 'bot:continue_registration' }],
  [
    { label: 'Restart Registration', action: 'bot:restart_registration', text: 'Restart Registration', data: 'bot:restart_registration' },
    { label: 'Contact Support', action: 'staff:takeover', text: 'Contact Support', data: 'staff:takeover' }
  ]
];

export const PAYMENT_WAITING_BUTTONS = [
  [{ label: 'Payment Instructions', action: 'bot:payment_instructions', text: 'Payment Instructions', data: 'bot:payment_instructions' }],
  [
    { label: 'I Have Paid', action: 'bot:i_have_paid', text: 'I Have Paid', data: 'bot:i_have_paid' },
    { label: 'Change Payment Details', action: 'bot:change_payment_details', text: 'Change Payment Details', data: 'bot:change_payment_details' }
  ],
  [{ label: 'Contact Support', action: 'staff:takeover', text: 'Contact Support', data: 'staff:takeover' }]
];

export const REGISTERED_BUTTONS = [
  [
    { label: 'Deposit', action: 'bot:deposit', text: 'Deposit', data: 'bot:deposit' },
    { label: 'Cash Out', action: 'bot:cashout', text: 'Cash Out', data: 'bot:cashout' }
  ],
  [
    { label: 'My Account', action: 'bot:my_account', text: 'My Account', data: 'bot:my_account' },
    { label: 'My Games', action: 'bot:my_games', text: 'My Games', data: 'bot:my_games' }
  ],
  [{ label: 'Support', action: 'staff:takeover', text: 'Support', data: 'staff:takeover' }]
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
const GREETING_PATTERNS = /^(hi|hello|hey|yo|hola|howdy|sup|what'?s up|good morning|good afternoon|good evening)\b/i;
const CASUAL_OFF_TOPIC_PATTERNS = /^(thanks|thank you|thx|haha|lol|hehe|hihi|ok|okay|cool|nice|great|awesome)\b[!.?\s]*$/i;

export function isGreetingMessage(text = '') {
  return GREETING_PATTERNS.test(String(text || '').trim());
}

export function isCasualOffTopicMessage(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isGreetingMessage(value)) return true;
  return CASUAL_OFF_TOPIC_PATTERNS.test(value);
}

export function isRegistrationFlow(flow) {
  return flow === 'bot_registration' || flow === 'registration_info';
}

export function isRegistrationInProgress(flow, step) {
  if (!isRegistrationFlow(flow)) return false;
  return normalizeStep(step, flow) !== 'welcome';
}

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
    'flow:registration_info': 'bot:register',
    staff: 'staff:takeover',
    'talk_to_staff': 'staff:takeover',
    'bot:talk_to_staff': 'staff:takeover',
    confirm: 'bot:confirm',
    edit: 'bot:edit',
    cancel: 'bot:stop'
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
  const normalizedStep = normalizeStep(step, flow);
  const registrationInProgress = isRegistrationInProgress(flow, normalizedStep);

  // Stop commands interrupt before any registration step handling.
  if (!action && isStopCommand(text)) {
    action = 'bot:stop';
  } else if (!action && isStaffCommand(text)) {
    action = 'staff:takeover';
  } else if (!action && isStartRegistrationCommand(text) && shouldStartRegistration(normalizedStep, flow, contact)) {
    action = 'bot:register';
  } else if (!action && isConfirmCommand(text) && normalizedStep === 'review' && isRegistrationFlow(flow)) {
    action = 'bot:confirm';
  } else if (!action && isEditCommand(text) && isRegistrationFlow(flow)) {
    action = 'bot:edit';
  }

  if (!registrationInProgress && detectInsult(text) && !action) {
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

  if (!registrationInProgress && detectStaffEscalation(text) && !action) {
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

  if (action === 'bot:how_it_works') {
    return {
      kind: 'how_it_works',
      replies: [{
        text: [
          'Here is how registration works:',
          '1. Choose your payment method.',
          '2. Send your first deposit.',
          '3. We match the payment.',
          '4. You choose your AppBeg username and password.',
          '5. Your account is created after verification.'
        ].join('\n'),
        buttons: WELCOME_BUTTONS
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (action === 'bot:continue_registration') {
    if (isRegistrationFlow(flow)) {
      return await continueRegistrationDecision({
        store,
        contact,
        text: '',
        action: null,
        step: normalizedStep,
        info,
        flow,
        automationState
      });
    }
    return await startRegistrationDecision(contact, info, store, { resumed: true });
  }

  if (action === 'bot:restart_registration') {
    if (store.expireActiveRegistrationPaymentWindows) {
      await store.expireActiveRegistrationPaymentWindows(contact.id, { suppressNotification: true }).catch(() => null);
    }
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact), store);
  }

  if (action === 'bot:stop' || action === 'bot:cancel') {
    return await stopRegistrationDecision({ store, contact, flow, step: normalizedStep, info });
  }

  if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status === 'Registered') {
    return decideRegisteredSupport({ text, action });
  }

  if (action === 'flow:registration_info' || action === 'bot:register') {
    return await startRegistrationDecision(contact, info, store);
  }

  if (String(action || '').startsWith('bot:payment_app:')) {
    return selectPaymentAppDecision({
      contact,
      info,
      selected: String(action).slice('bot:payment_app:'.length)
    });
  }

  // Active registration flow always takes priority over greeting/welcome detection.
  if (isRegistrationFlow(flow)) {
    return await continueRegistrationDecision({
      store,
      contact,
      text,
      action,
      step: normalizedStep,
      info,
      flow,
      automationState
    });
  }

  if (isUnregisteredStatus(contact.registration_status)) {
    if (isGreetingMessage(text) || !text) {
      return welcomeDecision(contact, info, automationState);
    }
    if (isStartRegistrationCommand(text)) {
      return await startRegistrationDecision(contact, info, store);
    }
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

function clearedRegistrationInfo(contact) {
  return {
    telegram_display_name: contact.display_name,
    telegram_username: contact.username || null,
    telegram_user_id: contact.telegram_id
  };
}

function registrationStoppedMessage() {
  return [
    'Registration has been stopped.',
    'You can type Register anytime to start again, or Staff to talk with our team.'
  ].join('\n');
}

function registrationStopIdleMessage() {
  return [
    'No active registration is running.',
    'Type Register to start, or Staff to talk with our team.'
  ].join('\n');
}

async function stopRegistrationDecision({ store, contact, flow, step, info }) {
  const normalizedStep = normalizeStep(step, flow);
  const active = isRegistrationInProgress(flow, normalizedStep);

  if (!active) {
    return {
      kind: 'registration_stop_idle',
      replies: [{ text: registrationStopIdleMessage() }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'registration_stop_idle' }
    };
  }

  const window = await store.getActiveRegistrationPaymentWindow(contact.id);
  const logEvents = [
    { event: 'registration_flow_stopped', step: normalizedStep }
  ];
  if (window?.id) {
    logEvents.push({ event: 'active_payment_window_cancelled', windowId: window.id });
  }
  logEvents.push({ event: 'flow_reset_to_idle' });

  return {
    kind: 'registration_stopped',
    replies: [{ text: registrationStoppedMessage() }],
    statePatch: {
      currentFlow: null,
      currentStep: null,
      registrationInfo: clearedRegistrationInfo(contact)
    },
    replaceRegistrationInfo: true,
    setStatus: contact.registration_status === 'Collecting Info' ? 'New' : undefined,
    expirePaymentWindowId: window?.id || null,
    escalate: false,
    logEvents
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

  if (['bot:deposit', 'bot:cashout', 'bot:my_account', 'bot:my_games'].includes(action)) {
    const label = {
      'bot:deposit': 'deposit',
      'bot:cashout': 'cash out',
      'bot:my_account': 'account',
      'bot:my_games': 'games'
    }[action];
    return {
      kind: `registered_${label.replaceAll(' ', '_')}`,
      replies: [{
        text: `Staff can help with ${label}. Tell us what you need and we will take it from here.`,
        buttons: REGISTERED_BUTTONS
      }],
      statePatch: null,
      escalate: false
    };
  }

  return {
    kind: 'registered_support',
    replies: [{
      text: 'You are all set on registration. Tell me what you need help with.',
      buttons: REGISTERED_BUTTONS
    }],
    statePatch: null,
    escalate: false
  };
}

async function startRegistrationDecision(contact, info, store, { resumed = false } = {}) {
  const methods = await store.listActivePaymentMethodsForRegistration();
  const prompt = methods.length
    ? registrationPaymentAppPrompt(methods)
    : 'Registration payments are not available right now. Please contact staff.';
  return {
    kind: 'registration_ask_payment_app',
    replies: [{ text: prompt }],
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
    logEvent: {
      event: resumed ? 'flow_resumed' : 'flow_started',
      step: 'payment_app',
      paymentMethodCount: methods.length
    }
  };
}

function flowInterruptedReminder(promptText, info, step, extra = {}) {
  return {
    kind: 'registration_flow_reminder',
    replies: [{
      text: [
        "We're currently registering your account.",
        '',
        'Please complete the current step first.',
        '',
        promptText
      ].join('\n')
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: step,
      registrationInfo: info
    },
    escalate: false,
    logEvent: {
      event: 'flow_ignored_greeting',
      step,
      ...extra
    }
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

function registrationOffTopicGuard(text, promptText, info, step) {
  if (!isCasualOffTopicMessage(text)) return null;
  return flowInterruptedReminder(promptText, info, step);
}

async function continueRegistrationDecision({ store, contact, text, action, step, info, flow, automationState = null }) {
  const normalizedStep = normalizeStep(step, flow);
  const activePaymentMethods = await store.listActivePaymentMethodsForRegistration();
  const paymentPrompt = registrationPaymentAppPrompt(activePaymentMethods);

  if (action === 'bot:confirm' || (normalizedStep === 'review' && AFFIRM_PATTERNS.test(text))) {
    if (!info.payment_confirmed) {
      return waitingForPaymentConfirmationDecision(info);
    }
    return {
      kind: 'registration_create_appbeg_player',
      replies: [],
      createAppBegPlayer: true,
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'complete',
        registrationInfo: {
          ...info,
          registration_method: 'chatbot',
          registration_confirmed: true
        }
      },
      setStatus: 'Pending Verification',
      escalate: false,
      logEvent: { event: 'create_player_requested' }
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
      logEvent: { event: 'flow_step', step: 'username', reason: 'edit' }
    };
  }

  if (normalizedStep === 'welcome') {
    if (isStartRegistrationCommand(text)) {
      return await startRegistrationDecision(contact, info, store);
    }
    return welcomeDecision(contact, info, automationState);
  }

  if (normalizedStep === 'payment_app') {
    const offTopic = registrationOffTopicGuard(text, paymentPrompt, info, 'payment_app');
    if (offTopic) return offTopic;

    if (!activePaymentMethods.length) {
      return {
        kind: 'registration_no_payment_methods',
        replies: [{
          text: 'Registration payments are not available right now. Please contact staff.'
        }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    if (!text) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{ text: paymentPrompt }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'flow_step', step: 'payment_app' }
      };
    }
    const method = parsePaymentMethodSelection(text, activePaymentMethods);
    if (!method) {
      return {
        kind: 'registration_ask_payment_app',
        replies: [{ text: paymentPrompt }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false
      };
    }
    const defaultQr = await store.getActiveDefaultPaymentQr(method.id);
    if (!defaultQr) {
      return {
        kind: 'registration_payment_method_unavailable',
        replies: [{ text: paymentMethodUnavailableMessage(method.name) }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'payment_method_unavailable', paymentMethod: method.key }
      };
    }
    return {
      kind: 'registration_ask_payment_display_name',
      replies: [{ text: paymentDisplayNamePrompt(method.name) }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'payment_display_name',
        registrationInfo: {
          ...info,
          payment_method_id: method.id,
          payment_method_name: method.name,
          payment_method_key: method.key,
          payment_app: method.name
        }
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'payment_display_name', paymentMethod: method.key }
    };
  }

  if (normalizedStep === 'payment_display_name') {
    const methodName = info.payment_method_name || 'payment app';
    const namePrompt = paymentDisplayNamePrompt(methodName);
    const offTopic = registrationOffTopicGuard(text, namePrompt, info, 'payment_display_name');
    if (offTopic) return offTopic;

    if (!text || text.length < 2) {
      return {
        kind: 'registration_ask_payment_display_name',
        replies: [{ text: namePrompt }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_display_name', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'flow_step', step: 'payment_display_name' }
      };
    }
    const nextInfo = { ...info, payment_display_name: text.trim() };
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
      logEvent: { event: 'flow_step', step: 'first_deposit_amount', paymentDisplayName: text.trim() }
    };
  }

  if (normalizedStep === 'first_deposit_amount') {
    const depositPrompt = 'How much are you going to deposit for your first payment?';
    const offTopic = registrationOffTopicGuard(text, depositPrompt, info, 'first_deposit_amount');
    if (offTopic) return offTopic;

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
      first_deposit_amount: amount
    };
    return {
      kind: 'registration_send_payment_qr',
      replies: [],
      sendPaymentQr: {
        paymentMethodId: nextInfo.payment_method_id,
        paymentMethodName: nextInfo.payment_method_name,
        paymentDisplayName: nextInfo.payment_display_name,
        firstDepositAmount: amount
      },
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'first_deposit_amount',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'send_qr', firstDepositAmount: amount }
    };
  }

  if (normalizedStep === 'await_payment_done') {
    const awaitPrompt = `When you have sent your ${info.payment_method_name || 'payment'}, reply Done.`;
    const offTopic = registrationOffTopicGuard(text, awaitPrompt, info, 'await_payment_done');
    if (offTopic) return offTopic;

    if (action === 'bot:payment_instructions') {
      return {
        kind: 'registration_payment_instructions',
        replies: [{ text: awaitPrompt, buttons: PAYMENT_WAITING_BUTTONS }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'await_payment_done', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'payment_instructions_reshown' }
      };
    }

    if (action === 'bot:change_payment_details') {
      return {
        kind: 'registration_change_payment_details',
        replies: [{ text: paymentPrompt }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_app', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'payment_details_change_requested' }
      };
    }

    if (!isDoneCommand(text) && action !== 'bot:i_have_paid') {
      return {
        kind: 'registration_await_payment_done',
        replies: [{ text: awaitPrompt, buttons: PAYMENT_WAITING_BUTTONS }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'await_payment_done', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'flow_step', step: 'await_payment_done' }
      };
    }
    return handleRegistrationPaymentDone(info);
  }

  if (normalizedStep === 'waiting_for_payment_confirmation') {
    if (info.payment_confirmed) {
      return {
        kind: 'registration_ask_username',
        replies: [{
          text: [
            'Thanks! We confirmed your payment.',
            'What AppBeg username would you like?',
            '',
            APPBEG_USERNAME_HELP
          ].join('\n')
        }],
        statePatch: {
          currentFlow: 'bot_registration',
          currentStep: 'username',
          registrationInfo: info
        },
        escalate: false,
        logEvent: { event: 'registration_continued_after_payment_match' }
      };
    }
    return waitingForPaymentConfirmationDecision(info);
  }

  if (normalizedStep === 'username') {
    if (!info.payment_confirmed) {
      return waitingForPaymentConfirmationDecision(info);
    }

    const usernamePrompt = [
      'What AppBeg username would you like?',
      '',
      APPBEG_USERNAME_HELP
    ].join('\n');
    const offTopic = registrationOffTopicGuard(text, usernamePrompt, info, 'username');
    if (offTopic) return offTopic;

    const usernameResult = validateAppBegUsername(text);
    if (!usernameResult.ok) {
      return {
        kind: 'registration_ask_username',
        replies: [{ text: `${usernameResult.error}\n\n${usernameResult.help}` }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'username', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'username_validation_failed', input: text || '' }
      };
    }
    const nextInfo = {
      ...info,
      preferred_appbeg_username: usernameResult.username
    };
    return {
      kind: 'registration_ask_password',
      replies: [{
        text: `Choose a password for your AppBeg account.\n\n${APPBEG_PASSWORD_HELP}`
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'password',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'password', username: usernameResult.username }
    };
  }

  if (normalizedStep === 'password') {
    if (!info.payment_confirmed) {
      return waitingForPaymentConfirmationDecision(info);
    }

    const passwordPrompt = `Choose a password for your AppBeg account.\n\n${APPBEG_PASSWORD_HELP}`;
    const offTopic = registrationOffTopicGuard(text, passwordPrompt, info, 'password');
    if (offTopic) return offTopic;

    const passwordResult = validateAppBegPassword(text);
    if (!passwordResult.ok) {
      return {
        kind: 'registration_ask_password',
        replies: [{ text: `${passwordResult.error}\n\n${passwordResult.help}` }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'password', registrationInfo: info },
        escalate: false,
        logEvent: { event: 'flow_step', step: 'password', reason: 'validation_failed' }
      };
    }
    const nextInfo = { ...info, appbeg_password: passwordResult.password };
    return {
      kind: 'registration_ask_referral',
      replies: [{
        text: 'Do you have a referral code? Reply with the code, or type Skip if you do not have one.'
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'referral_code',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'referral_code' }
    };
  }

  if (normalizedStep === 'referral_code') {
    if (!info.payment_confirmed) {
      return waitingForPaymentConfirmationDecision(info);
    }

    const referralPrompt = 'Do you have a referral code? Reply with the code, or type Skip if you do not have one.';
    const offTopic = registrationOffTopicGuard(text, referralPrompt, info, 'referral_code');
    if (offTopic) return offTopic;

    const nextInfo = {
      ...info,
      referral_code: isReferralSkipInput(text) ? null : String(text || '').trim()
    };
    return reviewDecision(nextInfo);
  }

  if (normalizedStep === 'payment_app_other') {
    const otherPrompt = 'Which payment app should we list as Other?';
    const offTopic = registrationOffTopicGuard(text, otherPrompt, info, 'payment_app_other');
    if (offTopic) return offTopic;

    if (!text) {
      return {
        kind: 'registration_ask_payment_app_other',
        replies: [{ text: otherPrompt }],
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
      logEvent: { event: 'flow_step', step: 'payment_tag', paymentApp: text }
    };
  }

  if (normalizedStep === 'payment_tag') {
    const tagPrompt = 'I’ll need that payment tag to keep deposits tidy. What tag should we use?';
    const offTopic = registrationOffTopicGuard(text, tagPrompt, info, 'payment_tag');
    if (offTopic) return offTopic;

    if (!text) {
      return {
        kind: 'registration_ask_payment_tag',
        replies: [{ text: tagPrompt }],
        statePatch: { currentFlow: 'bot_registration', currentStep: 'payment_tag', registrationInfo: info },
        escalate: false
      };
    }
    const nextInfo = {
      ...info,
      payment_tag: text,
      payment_tag_normalized: normalizePaymentTag(text)
    };
    return {
      kind: 'registration_ask_password',
      replies: [{
        text: 'Choose a password for your AppBeg account (at least 6 characters).'
      }],
      statePatch: {
        currentFlow: 'bot_registration',
        currentStep: 'password',
        registrationInfo: nextInfo
      },
      escalate: false,
      logEvent: { event: 'flow_step', step: 'password' }
    };
  }

  if (normalizedStep === 'review' || normalizedStep === 'complete') {
    const review = reviewDecision(info);
    if (isCasualOffTopicMessage(text)) {
      return flowInterruptedReminder(review.replies[0].text, info, 'review');
    }
    return review;
  }

  return {
    kind: 'registration_flow_stuck',
    replies: [{
      text: "We're still working on your registration. Please reply Cancel to start over or Staff for help."
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: normalizedStep,
      registrationInfo: info
    },
    escalate: false
  };
}

function waitingForPaymentConfirmationDecision(info) {
  return {
    kind: 'registration_waiting_payment_confirmation',
    replies: [{
      text: "Thanks! We're checking your payment now.\nPlease wait while we verify it."
    }],
    statePatch: {
      currentFlow: 'bot_registration',
      currentStep: 'waiting_for_payment_confirmation',
      registrationInfo: info
    },
    escalate: false,
    logEvent: { event: 'done_received_waiting_for_confirmation' }
  };
}

function handleRegistrationPaymentDone(info) {
  return waitingForPaymentConfirmationDecision(info);
}

function reviewDecision(info) {
  const paymentLines = info.payment_display_name
    ? [
      `• Payment app: ${info.payment_method_name || info.payment_app || '—'}`,
      `• Payment name: ${info.payment_display_name}`,
      `• First deposit: $${formatDepositAmount(info.first_deposit_amount)}`
    ]
    : [
      `• Payment app: ${info.payment_app || info.preferred_game || '—'}`,
      `• Payment tag: ${info.payment_tag || '—'}`
    ];
  const summary = [
    'Please confirm these details:',
    `• Username: ${info.preferred_appbeg_username || '—'}`,
    `• Password: ${info.appbeg_password ? '••••••••' : '—'}`,
    `• Referral code: ${info.referral_code || 'None'}`,
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
    logEvent: { event: 'flow_step', step: 'review' }
  };
}

function normalizeStep(step, flow) {
  if (flow === 'registration_info') {
    if (step === 'appbeg_username') return 'username';
    if (step === 'confirm') return 'review';
  }
  if (step === 'chime_payment_name') return 'payment_display_name';
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

function paymentAppPrompt(username = null, methods = []) {
  const intro = username ? `Nice pick: ${username}.\n\n` : '';
  return `${intro}${registrationPaymentAppPrompt(methods)}`;
}

function shouldStartRegistration(step, flow, contact) {
  const normalizedStep = normalizeStep(step, flow);
  if (normalizedStep !== 'welcome') return false;
  if (flow && flow !== 'idle' && !isRegistrationFlow(flow)) return false;
  return isUnregisteredStatus(contact.registration_status);
}

export function isStopCommand(text = '') {
  return /^(stop|cancel|quit|restart|reset|start over)$/i.test(String(text || '').trim());
}

function isRestartCommand(text) {
  return isStopCommand(text);
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

export {
  paymentQrCaption,
  formatDepositAmount,
  parsePaymentMethodSelection,
  registrationPaymentAppPrompt
};

export function registrationStatusLabel(contact) {
  if (contact?.needs_staff_review) return 'Needs staff review';
  if (contact?.bot_paused) return 'Bot paused';
  if (contact?.bot_enabled === false || contact?.bot_enabled === 0) return 'Bot off';
  return 'Bot active';
}
