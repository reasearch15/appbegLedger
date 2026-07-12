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
import {
  BOT_REGISTRATION_FLOW,
  buildPaymentMethodButtons,
  cancelConfirmButtons,
  canonicalizeRegistrationStep,
  clearedBotRegistrationInfo,
  guestMenuButtons,
  inProgressMenuButtons,
  menuKindButtons,
  menuKindWelcomeText,
  parseBotCommand,
  referralChoiceButtons,
  registeredMenuButtons,
  registrationNavButtons,
  resolveEffectiveRegistrationState,
  restartConfirmButtons,
  reviewScreenButtons,
  waitingPaymentMenuButtons
} from './botRegistrationState.js';
import {
  continueRoyalVipRegistration,
  startRoyalVipRegistration,
  reviewDecision as royalVipReviewDecision
} from './royalVipBotRegistration.js';

export const BOT_REGISTRATION_STEPS = [
  'welcome',
  'payment_name',
  'payment_display_name',
  'first_deposit_amount',
  'await_payment',
  'await_payment_done',
  'waiting_for_payment_confirmation',
  'username',
  'enter_appbeg_username',
  'password',
  'enter_appbeg_password',
  'review',
  'creating_account',
  'submitted',
  'complete',
  // legacy aliases kept for resume of in-flight older sessions
  'payment_app',
  'choose_payment_app',
  'payment_tag',
  'enter_payment_tag',
  'enter_payment_display_name',
  'referral_code',
  'enter_referral_code',
  'payment_app_other'
];

export const PAYMENT_APP_OPTIONS = [
  { label: 'Cash App', action: 'bot:payment_app:Cash App', value: 'Cash App' },
  { label: 'Chime', action: 'bot:payment_app:Chime', value: 'Chime' },
  { label: 'Zelle', action: 'bot:payment_app:Zelle', value: 'Zelle' },
  { label: 'Apple Pay', action: 'bot:payment_app:Apple Pay', value: 'Apple Pay' },
  { label: 'Other', action: 'bot:payment_app:Other', value: 'Other' }
];

export const WELCOME_BUTTONS = guestMenuButtons();
export const IN_PROGRESS_BUTTONS = inProgressMenuButtons();
export const PAYMENT_WAITING_BUTTONS = waitingPaymentMenuButtons();
export const REGISTERED_BUTTONS = registeredMenuButtons();
export const REVIEW_BUTTONS = reviewScreenButtons();

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
    || value.startsWith('menu:')
    || value.startsWith('register:')
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
  if (raw.length > 64) return '';
  const aliases = {
    register: 'bot:register',
    'menu:register': 'bot:register',
    'flow:registration_info': 'bot:register',
    staff: 'staff:takeover',
    'menu:support': 'staff:takeover',
    talk_to_staff: 'staff:takeover',
    'bot:talk_to_staff': 'staff:takeover',
    confirm: 'bot:confirm',
    'register:confirm': 'bot:confirm',
    edit: 'bot:edit',
    cancel: 'bot:stop',
    'menu:how_it_works': 'bot:how_it_works',
    'menu:continue_registration': 'bot:continue_registration',
    'menu:restart_request': 'bot:restart_request',
    'menu:restart_registration': 'bot:restart_request',
    'bot:restart_registration': 'bot:restart_request',
    'register:restart_request': 'bot:restart_request',
    'register:restart_confirm': 'bot:restart_confirm',
    'register:restart_abort': 'bot:continue_registration',
    'register:cancel_request': 'bot:cancel_request',
    'register:cancel_confirm': 'bot:stop',
    'register:cancel_abort': 'bot:continue_registration',
    'menu:main': 'bot:main_menu',
    'menu:registration_status': 'bot:status',
    'menu:deposit': 'bot:deposit',
    'menu:cashout': 'bot:cashout',
    'menu:my_account': 'bot:my_account',
    'register:edit_payment': 'bot:change_payment_details',
    'register:edit_username': 'bot:edit_username',
    'register:edit_password': 'bot:edit_password',
    'register:edit_referral': 'bot:edit_referral',
    'register:skip_referral': 'bot:skip_referral',
    'register:enter_referral': 'bot:enter_referral'
  };
  if (aliases[raw]) return aliases[raw];
  if (raw.startsWith('payment_app:') && !raw.startsWith('bot:')) {
    return `bot:${raw}`;
  }
  if (raw.startsWith('register:payment_app:')) {
    return `bot:payment_app:${raw.slice('register:payment_app:'.length)}`;
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
  let flow = automationState.current_flow;
  // Bot API contacts must use bot_registration only — migrate legacy registration_info.
  if (flow === 'registration_info' && (contact.telegram_sync_source === 'bot_api' || contact.active_messaging_source === 'bot_api')) {
    flow = BOT_REGISTRATION_FLOW;
  }
  const step = automationState.current_step || 'welcome';
  const normalizedStep = normalizeStep(step, flow);
  const registrationInProgress = isRegistrationInProgress(flow, normalizedStep);
  let paymentWindow = null;
  try {
    paymentWindow = await store.getActiveRegistrationPaymentWindow?.(contact.id);
  } catch {
    paymentWindow = null;
  }
  const effective = await resolveEffectiveRegistrationState({
    contact,
    automationState: { ...automationState, current_flow: flow },
    paymentWindow
  });

  const command = !action ? parseBotCommand(text) : null;
  if (command) {
    if (command.command === 'start') {
      return await mainMenuDecision(contact, info, automationState, effective, { forceFull: true });
    }
    if (command.command === 'register') {
      if (effective.is_registered) {
        return decideRegisteredSupport({ text: '', action: null, contact, effective });
      }
      if (registrationInProgress) {
        action = 'bot:continue_registration';
      } else {
        action = 'bot:register';
      }
    } else if (command.command === 'status') {
      action = 'bot:status';
    } else if (command.command === 'support') {
      action = 'staff:takeover';
    } else if (command.command === 'cancel') {
      action = registrationInProgress ? 'bot:cancel_request' : 'bot:stop';
    }
  }

  // Stop commands interrupt before any registration step handling.
  if (!action && isStopCommand(text)) {
    action = registrationInProgress ? 'bot:cancel_request' : 'bot:stop';
  } else if (!action && isStaffCommand(text)) {
    action = 'staff:takeover';
  } else if (!action && isStartRegistrationCommand(text) && shouldStartRegistration(normalizedStep, flow, contact, effective)) {
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

  if (action === 'bot:main_menu' || action === 'bot:status') {
    if (action === 'bot:status') {
      return {
        kind: 'registration_status',
        replies: [{
          text: [
            `Status: ${effective.effective_status}`,
            effective.current_step && effective.current_step !== 'welcome'
              ? `Current step: ${effective.current_step}`
              : null,
            effective.appbeg_username ? `AppBeg username: ${effective.appbeg_username}` : null
          ].filter(Boolean).join('\n'),
          buttons: menuKindButtons(effective.menu_kind)
        }],
        statePatch: null,
        escalate: false
      };
    }
    return await mainMenuDecision(contact, info, automationState, effective, { forceFull: true });
  }

  if (action === 'bot:how_it_works') {
    return {
      kind: 'how_it_works',
      replies: [{
        text: [
          'Here is how registration works:',
          '1. Choose your payment method.',
          '2. Enter your payment account details.',
          '3. Complete your first deposit when prompted.',
          '4. Choose your AppBeg username and password.',
          '5. Review and confirm — we create your account after verification.'
        ].join('\n'),
        buttons: menuKindButtons(effective.menu_kind)
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (action === 'bot:cancel_request') {
    if (!registrationInProgress) {
      return await stopRegistrationDecision({ store, contact, flow, step: normalizedStep, info });
    }
    return {
      kind: 'registration_cancel_confirm',
      replies: [{
        text: 'Are you sure?',
        buttons: cancelConfirmButtons()
      }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'registration_cancel_requested' }
    };
  }

  if (action === 'bot:restart_request') {
    if (effective.is_registered) {
      return decideRegisteredSupport({ text: '', action: null, contact, effective });
    }
    return {
      kind: 'registration_restart_confirm',
      replies: [{
        text: 'Restart registration from the beginning? Incomplete details will be cleared.',
        buttons: restartConfirmButtons()
      }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'registration_restart_requested' }
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
        automationState,
        effective
      });
    }
    return await startRegistrationDecision(contact, info, store, { resumed: true });
  }

  if (action === 'bot:restart_confirm') {
    if (effective.is_registered) {
      return decideRegisteredSupport({ text: '', action: null, contact, effective });
    }
    if (store.expireActiveRegistrationPaymentWindows) {
      await store.expireActiveRegistrationPaymentWindows(contact.id, { suppressNotification: true }).catch(() => null);
    }
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact), store);
  }

  if (action === 'bot:stop' || action === 'bot:cancel') {
    return await stopRegistrationDecision({ store, contact, flow, step: normalizedStep, info });
  }

  if (effective.is_registered || effective.effective_status === 'Registered') {
    return decideRegisteredSupport({ text, action, contact, effective });
  }

  if (effective.is_suspended || effective.effective_status === 'Suspended') {
    return {
      kind: 'suspended_menu',
      replies: [{
        text: menuKindWelcomeText(contact, effective),
        buttons: menuKindButtons('suspended')
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (action === 'flow:registration_info' || action === 'bot:register') {
    if (registrationInProgress && normalizedStep !== 'welcome') {
      return await continueRegistrationDecision({
        store,
        contact,
        text: '',
        action: null,
        step: normalizedStep,
        info,
        flow,
        automationState,
        effective
      });
    }
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact), store);
  }

  if (String(action || '').startsWith('bot:payment_app:') || String(action || '').startsWith('register:payment_app:')) {
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact), store);
  }

  if (action === 'bot:edit_username' || action === 'bot:edit_password' || action === 'bot:edit_referral' || action === 'bot:enter_referral' || action === 'bot:skip_referral') {
    return await continueRegistrationDecision({
      store,
      contact,
      text: '',
      action,
      step: normalizedStep,
      info,
      flow,
      automationState,
      effective
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
      automationState,
      effective
    });
  }

  if (isUnregisteredStatus(contact.registration_status) || effective.menu_kind === 'guest') {
    if (isGreetingMessage(text) || !text || command?.command === 'start') {
      return await mainMenuDecision(contact, info, automationState, effective);
    }
    if (isStartRegistrationCommand(text)) {
      return await startRegistrationDecision(contact, clearedRegistrationInfo(contact), store);
    }
    return await mainMenuDecision(contact, info, automationState, effective);
  }

  return await mainMenuDecision(contact, info, automationState, effective);
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
  return clearedBotRegistrationInfo(contact);
}

function registrationStoppedMessage() {
  return [
    'Registration has been cancelled.',
    'Press Register anytime to start again.'
  ].join('\n');
}

function registrationStopIdleMessage() {
  return [
    'No active registration is running.',
    'Press Register to start, or Contact Support to talk with our team.'
  ].join('\n');
}

async function stopRegistrationDecision({ store, contact, flow, step, info }) {
  const normalizedStep = normalizeStep(step, flow);
  const active = isRegistrationInProgress(flow, normalizedStep);

  if (!active) {
    return {
      kind: 'registration_stop_idle',
      replies: [{ text: registrationStopIdleMessage(), buttons: WELCOME_BUTTONS }],
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
    replies: [{ text: registrationStoppedMessage(), buttons: WELCOME_BUTTONS }],
    statePatch: {
      currentFlow: null,
      currentStep: null,
      registrationInfo: clearedRegistrationInfo(contact)
    },
    replaceRegistrationInfo: true,
    setStatus: ['Collecting Info', 'Waiting For Payment'].includes(contact.registration_status) ? 'New' : undefined,
    expirePaymentWindowId: window?.id || null,
    escalate: false,
    logEvents
  };
}

async function mainMenuDecision(contact, info, automationState = null, effective = null, { forceFull = false } = {}) {
  const state = effective || await resolveEffectiveRegistrationState({ contact, automationState });
  const throttled = !forceFull && state.menu_kind === 'guest' && isWelcomeThrottled(automationState);
  const text = throttled && state.menu_kind === 'guest'
    ? welcomeNudgeMessage()
    : menuKindWelcomeText(contact, state);

  const keepFlow = state.registration_active
    && automationState?.current_flow
    && state.menu_kind !== 'guest';

  return {
    kind: throttled ? 'welcome_nudge' : (state.menu_kind === 'guest' ? 'welcome' : `menu_${state.menu_kind}`),
    replies: [{
      text,
      buttons: menuKindButtons(state.menu_kind)
    }],
    statePatch: keepFlow
      ? null
      : {
        currentFlow: state.menu_kind === 'guest' ? BOT_REGISTRATION_FLOW : automationState?.current_flow || null,
        currentStep: state.menu_kind === 'guest' ? 'welcome' : automationState?.current_step || null,
        registrationInfo: {
          ...info,
          telegram_display_name: contact.display_name,
          telegram_username: contact.username || null,
          telegram_user_id: contact.telegram_id
        }
      },
    markWelcomeSent: state.menu_kind === 'guest',
    escalate: false,
    logEvent: {
      event: throttled ? 'welcome_nudged' : 'main_menu_shown',
      menuKind: state.menu_kind,
      effectiveStatus: state.effective_status,
      throttled
    }
  };
}

function welcomeDecision(contact, info, automationState = null, { forceFull = false } = {}) {
  return mainMenuDecision(contact, info, automationState, {
    menu_kind: 'guest',
    effective_status: 'New',
    registration_active: false
  }, { forceFull });
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

function decideRegisteredSupport({ text, action, contact = null, effective = null }) {
  if (action === 'staff:takeover' || /\b(human|agent|staff)\b/i.test(text)) {
    return talkToStaffDecision();
  }

  if (['bot:deposit', 'bot:cashout', 'bot:my_account', 'bot:my_games', 'bot:my_games'].includes(action)) {
    const label = {
      'bot:deposit': 'deposit',
      'bot:cashout': 'cash out',
      'bot:my_account': 'account',
      'bot:my_game': 'games',
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

  const name = contact?.display_name || 'there';
  return {
    kind: 'registered_support',
    replies: [{
      text: 'Welcome back!',
      buttons: REGISTERED_BUTTONS
    }],
    statePatch: null,
    escalate: false
  };
}

async function startRegistrationDecision(contact, info, store, { resumed = false } = {}) {
  return startRoyalVipRegistration(contact, info, store, { resumed });
}

async function continueRegistrationDecision({
  store,
  contact,
  text,
  action,
  step,
  info,
  flow,
  automationState = null,
  effective = null
}) {
  void flow;
  return continueRoyalVipRegistration({
    store,
    contact,
    text,
    action,
    step,
    info,
    automationState,
    effective
  });
}

function reviewDecision(info) {
  return royalVipReviewDecision(info);
}

function normalizeStep(step, flow) {
  const canonical = canonicalizeRegistrationStep(step);
  if (flow === 'registration_info') {
    if (canonical === 'username' || step === 'appbeg_username') return 'username';
    if (canonical === 'review' || step === 'confirm') return 'review';
  }
  if (BOT_REGISTRATION_STEPS.includes(canonical) || BOT_REGISTRATION_STEPS.includes(step)) {
    return canonical;
  }
  return 'welcome';
}

function welcomeMessage() {
  return menuKindWelcomeText({}, { menu_kind: 'guest' });
}

function welcomeNudgeMessage() {
  return [
    '👋 Welcome to Royal VIP!',
    '',
    'It looks like you are not registered with us yet.'
  ].join('\n');
}

function paymentAppPrompt(username = null, methods = []) {
  const intro = username ? `Nice pick: ${username}.\n\n` : '';
  return `${intro}${registrationPaymentAppPrompt(methods)}`;
}

function shouldStartRegistration(step, flow, contact, effective = null) {
  if (effective?.is_registered) return false;
  if (effective?.is_suspended) return false;
  const normalizedStep = normalizeStep(step, flow);
  if (isRegistrationInProgress(flow, normalizedStep) && normalizedStep !== 'welcome') return false;
  return isUnregisteredStatus(contact.registration_status) || effective?.menu_kind === 'guest';
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
