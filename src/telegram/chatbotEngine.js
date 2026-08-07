import {
  normalizePaymentTag,
  isUnregisteredStatus,
  chatbotWelcomeCooldownMs,
  parseFirstDepositAmount,
  parseMoneyToCents,
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
  CUSTOMER_REGISTRATION_HELP_TEXT,
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
import {
  beginRegisteredDeposit,
  continueRegisteredDeposit,
  depositStepFromBotSession,
  isDepositBotSessionActive,
  isRegisteredDepositFlow,
  resolveRegisteredDepositStep
} from './registeredDepositFlow.js';
import {
  buildStateAwareEntryMenu,
  isGreetingEntryText,
  isPlainRegisterText,
  shouldShowEntryMenu
} from './botPrivateEntry.js';
import {
  buildHelpCenterDecision,
  HELP_TOPIC_PREFIX,
  isHelpCenterAction
} from './royalVipHelpCenter.js';
import {
  ASK_FREEPLAY_ACTION,
  decideAskFreePlayRequest
} from './freePlayRequest.js';
import {
  CONTACT_SUPPORT_FLOW,
  SUPPORT_INQUIRY_STEP,
  SUPPORT_MENU_ACTION,
  SUPPORT_CUSTOM_INQUIRY_ACTION,
  SUPPORT_TOPIC_PREFIX,
  decideContactSupportAction,
  decideSupportInquiryMessage,
  isContactSupportAction,
  isSupportInquiryStep
} from './contactSupportFlow.js';
import {
  ACCOUNT_DETAILS_HIDDEN_TEXT,
  ACCOUNT_PASSWORD_MASK,
  buildGameAccountDetailText,
  buildGameDetailButtons,
  buildMissingAccountButtons,
  buildMyAccountButtons,
  buildMyAccountMainText,
  createAccountViewToken,
  findGameAccount,
  GAME_PASSWORD_UNAVAILABLE,
  isFreshAccountAction,
  parseAccountAction,
  resolveRoyalVipCredentials
} from './accountView.js';

async function loadLiveGameAccounts(playerUid) {
  const uid = String(playerUid || '').trim();
  if (!uid) return [];
  const store = globalThis.appbegStore;
  if (!store?.configured || typeof store.listGameAccountsForPlayer !== 'function') {
    return [];
  }
  try {
    const accounts = await store.listGameAccountsForPlayer(uid);
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    console.log(`[chatbot] game_accounts_load_failed reason=${error.message}`);
    return [];
  }
}

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
  'referral_choice',
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
const CASUAL_OFF_TOPIC_PATTERNS = /^(thanks|thank you|thx|haha|lol|hehe|hihi|ok|okay|cool|nice|great|awesome)\b[!.?\s]*$/i;

export function isGreetingMessage(text = '') {
  return isGreetingEntryText(text);
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
  return true;
}

export function isChatbotButtonAction(action) {
  const value = normalizeCallbackAction(action);
  if (!value) return false;
  return value.startsWith('bot:')
    || value.startsWith('menu:')
    || value.startsWith('register:')
    || value.startsWith('deposit:')
    || value.startsWith('account:')
    || value.startsWith('staff')
    || value === 'register'
    || value === 'confirm'
    || value === 'edit'
    || value === 'cancel'
    || value === 'flow:registration_info'
    || value.startsWith('bot:payment_app:')
    || value.startsWith(HELP_TOPIC_PREFIX)
    || value.startsWith(SUPPORT_TOPIC_PREFIX)
    || value === SUPPORT_MENU_ACTION
    || value === SUPPORT_CUSTOM_INQUIRY_ACTION
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
    'register:retry_payment_qr': 'bot:retry_payment_qr',
    'deposit:cancel': 'deposit:cancel',
    'deposit:retry_qr': 'deposit:retry_qr',
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

export async function decideBotReply({ store, contact, messageText = '', action = null, forceEntryMenu = false, callbackMessageId = null }) {
  const text = String(messageText || '').trim();
  action = normalizeCallbackAction(action) || null;
  let automationState = await store.ensureAutomationState(contact.id);
  const botSession = typeof store.getBotSession === 'function'
    ? await store.getBotSession(contact.id).catch(() => null)
    : null;
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
      if (command.args && typeof store.captureVendorReferralForContact === 'function') {
        await store.captureVendorReferralForContact(contact.id, command.args, 'TelegramStart').catch((error) => {
          console.warn('[vendor] referral capture skipped:', error.message);
        });
        automationState = await store.ensureAutomationState(contact.id);
      }
      return await buildStateAwareEntryMenu({
        store,
        contact,
        automationState,
        paymentWindow,
        forceFull: true
      });
    }
    if (command.command === 'register') {
      if (effective.is_registered || contact.registration_status === 'Registered') {
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
    } else if (command.command === 'deposit') {
      action = 'bot:deposit';
    }
  }

  const ledgerRegistered = contact.registration_status === 'Registered'
    || effective.is_registered
    || effective.effective_status === 'Registered';

  // Deposit from ANY surface (Help, Account, main menu, stale flows) always wins:
  // reset prior session and start a clean deposit amount wizard.
  if (action === 'bot:deposit' && ledgerRegistered) {
    return await beginRegisteredDeposit(store, contact, info);
  }

  const depositSessionActive = Boolean(
    isRegisteredDepositFlow(flow, normalizedStep)
    || info.deposit_in_progress
    || info.deposit_awaiting_payment
    || isDepositBotSessionActive(botSession)
  );
  const depositContinueStep = resolveRegisteredDepositStep(
    depositStepFromBotSession(botSession) || normalizedStep,
    info
  );

  // Amount replies must stay on deposit even if Help/Account/Main Menu corrupted flow/step.
  // While waiting for deposit_amount, every normal text update belongs to this handler:
  // valid money starts the payment window, invalid text gets the amount validation reply.
  if (!action && depositSessionActive && depositContinueStep === 'deposit_amount') {
    console.log(
      `[chatbot] deposit_amount_route_selected contact=${contact.id} ` +
      `automation_flow=${flow || 'none'} automation_step=${normalizedStep || 'none'} ` +
      `bot_session_flow=${botSession?.workflow_key || 'none'} ` +
      `bot_session_step=${botSession?.workflow_step || 'none'} ` +
      `resolved_step=${depositContinueStep} parsed_cents=${parseMoneyToCents(text) ?? 'invalid'}`
    );
    return await continueRegisteredDeposit({
      store,
      contact,
      text,
      action: null,
      step: depositContinueStep,
      info,
      callbackMessageId
    });
  }

  const pendingDepositStartOwnsAmount = Boolean(
    !action
    && ledgerRegistered
    && !depositSessionActive
    && parseMoneyToCents(text) != null
    && String(info.payment_display_name || info.payment_name || '').trim()
    && typeof store.hasPendingDepositStartJob === 'function'
    && await store.hasPendingDepositStartJob(contact.id).catch(() => false)
  );
  if (pendingDepositStartOwnsAmount) {
    const paymentName = String(info.payment_display_name || info.payment_name || '').trim();
    console.log(
      `[chatbot] deposit_amount_route_selected contact=${contact.id} ` +
      `reason=pending_deposit_callback automation_flow=${flow || 'none'} ` +
      `automation_step=${normalizedStep || 'none'} parsed_cents=${parseMoneyToCents(text) ?? 'invalid'}`
    );
    return await continueRegisteredDeposit({
      store,
      contact,
      text,
      action: null,
      step: 'deposit_amount',
      info: {
        ...info,
        payment_display_name: paymentName,
        payment_name: paymentName,
        deposit_in_progress: true,
        deposit_awaiting_payment: false
      },
      callbackMessageId
    });
  }

  // Use raw step — normalizeStep is registration-oriented and maps unknown steps to "welcome".
  if (!action && isSupportInquiryStep(flow, step)) {
    return decideSupportInquiryMessage({ contact, info, text });
  }

  if (!action && !registrationInProgress && !depositSessionActive && isGreetingEntryText(text)) {
    return await buildStateAwareEntryMenu({
      store,
      contact,
      automationState,
      paymentWindow,
      forceFull: true
    });
  }

  // Shared entry menu for first interaction / empty media / forced entry (same as /start).
  // Never auto-start registration from plain text like "hello" or "register".
  // Active deposit amount entry must not be stolen by the entry menu.
  if (shouldShowEntryMenu({
    text,
    action,
    forceEntryMenu: forceEntryMenu || isPlainRegisterText(text),
    registrationInProgress: registrationInProgress || depositSessionActive
  })) {
    return await buildStateAwareEntryMenu({
      store,
      contact,
      automationState,
      paymentWindow,
      forceFull: true
    });
  }

  // Stop commands interrupt before any registration step handling.
  if (!action && isStopCommand(text)) {
    action = registrationInProgress ? 'bot:cancel_request' : 'bot:stop';
  } else if (!action && isStaffCommand(text)) {
    action = 'staff:takeover';
  } else if (!action && isConfirmCommand(text) && normalizedStep === 'review' && isRegistrationFlow(flow)) {
    action = 'bot:confirm';
  } else if (!action && isEditCommand(text) && isRegistrationFlow(flow) && normalizedStep === 'review') {
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
      kind: 'support_sensitive',
      replies: [{
        text: 'That one might need a human pair of eyes. I’m looping in staff now so nothing risky slips through. Hang tight!'
      }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'support_sensitive_reply', reason: 'risky_or_financial_request' }
    };
  }

  if (action === 'staff:takeover' || action === 'bot:talk_to_staff') {
    return decideContactSupportAction({ action, contact, info });
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
            effective.appbeg_username ? `Royal VIP username: ${effective.appbeg_username}` : null
          ].filter(Boolean).join('\n'),
          buttons: menuKindButtons(effective.menu_kind)
        }],
        statePatch: null,
        escalate: false
      };
    }
    return await mainMenuDecision(contact, info, automationState, effective, { forceFull: true });
  }

  if (action === ASK_FREEPLAY_ACTION) {
    return await decideAskFreePlayRequest({ store, contact, info });
  }

  if (isContactSupportAction(action) || String(action || '').startsWith(SUPPORT_TOPIC_PREFIX)) {
    return decideContactSupportAction({ action, contact, info });
  }

  if (isHelpCenterAction(action)) {
    return buildHelpCenterDecision(action);
  }

  if (action === 'bot:my_account' || String(action || '').startsWith('account:')) {
    return await accountViewDecision({
      store,
      contact,
      info,
      flow,
      step: normalizedStep,
      action,
      callbackMessageId
    });
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
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact, info), store);
  }

  if (action === 'bot:stop' || action === 'bot:cancel') {
    return await stopRegistrationDecision({ store, contact, flow, step: normalizedStep, info });
  }

  if (effective.is_registered || effective.effective_status === 'Registered' || ledgerRegistered) {
    if (
      action === 'bot:deposit'
      || action === 'deposit:cancel'
      || action === 'deposit:retry_qr'
      || depositSessionActive
      || isRegisteredDepositFlow(flow, normalizedStep)
      || info.deposit_in_progress
      || info.deposit_awaiting_payment
    ) {
      // bot:deposit is handled early above; keep cancel/retry/continue here.
      if (action === 'bot:deposit') {
        return await beginRegisteredDeposit(store, contact, info);
      }
      return await continueRegisteredDeposit({
        store,
        contact,
        text,
        action,
        step: depositContinueStep,
        info,
        callbackMessageId
      });
    }
    return decideRegisteredSupport({ text, action, contact, effective });
  }

  // Active deposit must never fall into guest/registration catch-alls.
  if (depositSessionActive) {
    console.log(
      `[chatbot] deposit_session_guard contact=${contact.id} ` +
      `prevented_guest_intercept automation_flow=${flow || 'none'} ` +
      `bot_session_flow=${botSession?.workflow_key || 'none'} step=${depositContinueStep}`
    );
    return await continueRegisteredDeposit({
      store,
      contact,
      text,
      action,
      step: depositContinueStep,
      info,
      callbackMessageId
    });
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
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact, info), store);
  }

  if (String(action || '').startsWith('bot:payment_app:') || String(action || '').startsWith('register:payment_app:')) {
    return await startRegistrationDecision(contact, clearedRegistrationInfo(contact, info), store);
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
  // Stale bot_registration leftovers on Ledger-Registered contacts must not block deposit.
  if (isRegistrationFlow(flow) && !(ledgerRegistered && flow === BOT_REGISTRATION_FLOW && normalizedStep === 'welcome')) {
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
      return await startRegistrationDecision(contact, clearedRegistrationInfo(contact, info), store);
    }
    return await mainMenuDecision(contact, info, automationState, effective);
  }

  return await mainMenuDecision(contact, info, automationState, effective);
}

function talkToStaffDecision(contact = null, info = {}) {
  return decideContactSupportAction({ action: SUPPORT_MENU_ACTION, contact, info });
}

function clearedRegistrationInfo(contact, existingInfo = null) {
  return clearedBotRegistrationInfo(contact, existingInfo);
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
      registrationInfo: clearedRegistrationInfo(contact, info)
    },
    replaceRegistrationInfo: true,
    setStatus: ['Collecting Info', 'Waiting For Payment'].includes(contact.registration_status) ? 'New' : undefined,
    expirePaymentWindowId: window?.id || null,
    escalate: false,
    logEvents
  };
}

async function mainMenuDecision(contact, info, automationState = null, effective = null, { forceFull = false, store = null } = {}) {
  if (store) {
    return buildStateAwareEntryMenu({
      store,
      contact,
      automationState,
      forceFull
    });
  }
  return buildStateAwareEntryMenu({
    store: {
      async ensureAutomationState() {
        return automationState;
      },
      async getActiveRegistrationPaymentWindow() {
        return null;
      }
    },
    contact,
    automationState,
    forceFull
  });
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
    return talkToStaffDecision(contact);
  }

  if (!action && isRegisteredDepositDiscoveryText(text)) {
    return {
      kind: 'registered_deposit_discovery',
      replies: [{
        text: 'To make a deposit, tap Deposit below and follow the payment instructions.',
        buttons: [[registeredMenuButtons()[0][0]]]
      }],
      statePatch: null,
      escalate: false
    };
  }

  if (['bot:cashout', 'bot:my_games', 'bot:my_game'].includes(action)) {
    const label = {
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

  void contact;
  void effective;
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

async function accountViewDecision({ store, contact, info = {}, flow = null, step = null, action = null, callbackMessageId = null }) {
  const parsedAccountAction = parseAccountAction(action);
  if (parsedAccountAction) {
    const fresh = isFreshAccountAction({ info, action: parsedAccountAction, messageId: callbackMessageId });
    if (!fresh) {
      return {
        kind: 'account_stale_button',
        replies: [{
          text: 'This account view has expired. Please open My Account again.',
          buttons: menuKindButtons('registered')
        }],
        statePatch: null,
        escalate: false,
        logEvent: { event: 'account_view_stale_button', action: parsedAccountAction.type }
      };
    }

    if (parsedAccountAction.type === 'support') {
      return decideContactSupportAction({
        action: SUPPORT_MENU_ACTION,
        contact,
        info
      });
    }

    if (parsedAccountAction.type === 'back') {
      if (isRegisteredDepositFlow(flow, step)) {
        return continueRegisteredDeposit({ store, contact, text: '', action: null, step, info });
      }
      if (isRegistrationFlow(flow)) {
        return continueRegistrationDecision({ store, contact, text: '', action: null, step, info, flow });
      }
      return {
        kind: 'account_back_registered_menu',
        replies: [{ text: 'Welcome back!', buttons: menuKindButtons('registered') }],
        statePatch: null,
        escalate: false
      };
    }

    const credentials = resolveRoyalVipCredentials({ contact, info });
    if (!credentials.ok) {
      const missingText = buildMyAccountMainText(credentials);
      const missingButtons = buildMissingAccountButtons(parsedAccountAction.token);
      return {
        kind: 'account_credentials_missing',
        replies: [{ text: missingText, buttons: missingButtons }],
        statePatch: null,
        accountView: {
          action: 'show',
          token: parsedAccountAction.token,
          previousMessageId: Number(info.account_view_message_id || 0) || null,
          text: missingText,
          buttons: missingButtons,
          missing: true
        },
        sensitive: false,
        escalate: false,
        logEvent: { event: 'account_credentials_missing', reason: credentials.reason }
      };
    }

    const gameAccounts = await loadLiveGameAccounts(credentials.linkedUid);
    const token = parsedAccountAction.token;

    if (parsedAccountAction.type === 'game') {
      const account = findGameAccount(gameAccounts, parsedAccountAction.platformKey);
      if (!account) {
        const mainText = buildMyAccountMainText(credentials);
        const mainButtons = buildMyAccountButtons(token, { gameAccounts, includeHide: true, mode: 'main' });
        return {
          kind: 'account_game_missing',
          replies: [],
          statePatch: null,
          accountView: {
            action: 'edit',
            messageId: callbackMessageId,
            token,
            text: mainText,
            buttons: mainButtons,
            mode: 'main',
            platformKey: null,
            fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
          },
          sensitive: true,
          escalate: false,
          logEvent: {
            event: 'account_game_missing',
            platform: parsedAccountAction.platformKey
          }
        };
      }

      const text = buildGameAccountDetailText(account, { hidePassword: false });
      const buttons = buildGameDetailButtons(token, {
        includeHide: true,
        mode: 'game',
        username: account.username,
        password: account.password || GAME_PASSWORD_UNAVAILABLE
      });
      return {
        kind: 'account_game_detail',
        replies: [],
        statePatch: null,
        accountView: {
          action: 'edit',
          messageId: callbackMessageId,
          token,
          text,
          buttons,
          mode: 'game',
          platformKey: account.key,
          fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
        },
        sensitive: true,
        escalate: false,
        logEvent: {
          event: 'account_game_opened',
          platform: account.key
        }
      };
    }

    if (parsedAccountAction.type === 'game_list') {
      const text = buildMyAccountMainText(credentials, { hidePassword: false });
      const buttons = buildMyAccountButtons(token, { gameAccounts, includeHide: true, mode: 'main' });
      return {
        kind: 'account_game_list',
        replies: [],
        statePatch: null,
        accountView: {
          action: 'edit',
          messageId: callbackMessageId,
          token,
          text,
          buttons,
          mode: 'main',
          platformKey: null,
          fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
        },
        sensitive: true,
        escalate: false,
        logEvent: {
          event: 'account_game_list_restored',
          game_account_count: gameAccounts.length
        }
      };
    }

    if (parsedAccountAction.type === 'hide') {
      const currentMode = String(info.account_view_mode || 'main');
      const platformKey = String(info.account_view_platform_key || '').trim() || null;
      const onGameDetail = (currentMode === 'game' || currentMode === 'game_hidden') && platformKey;
      if (onGameDetail) {
        const account = findGameAccount(gameAccounts, platformKey);
        if (!account) {
          const text = buildMyAccountMainText(credentials, { hidePassword: true });
          const buttons = buildMyAccountButtons(token, {
            gameAccounts,
            includeHide: false,
            mode: 'main_hidden'
          });
          return {
            kind: 'account_hide_details',
            replies: [],
            statePatch: null,
            accountView: {
              action: 'edit',
              messageId: callbackMessageId,
              token,
              text,
              buttons,
              mode: 'main_hidden',
              platformKey: null,
              fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
            },
            sensitive: true,
            escalate: false,
            logEvent: { event: 'account_view_hidden', scope: 'main' }
          };
        }
        const text = buildGameAccountDetailText(account, { hidePassword: true });
        const buttons = buildGameDetailButtons(token, {
          includeHide: false,
          mode: 'game_hidden',
          username: account.username,
          password: ACCOUNT_PASSWORD_MASK
        });
        return {
          kind: 'account_hide_details',
          replies: [],
          statePatch: null,
          accountView: {
            action: 'edit',
            messageId: callbackMessageId,
            token,
            text,
            buttons,
            mode: 'game_hidden',
            platformKey: account.key,
            fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
          },
          sensitive: true,
          escalate: false,
          logEvent: { event: 'account_view_hidden', scope: 'game', platform: account.key }
        };
      }

      const text = buildMyAccountMainText(credentials, { hidePassword: true });
      const buttons = buildMyAccountButtons(token, {
        gameAccounts,
        includeHide: false,
        mode: 'main_hidden'
      });
      return {
        kind: 'account_hide_details',
        replies: [],
        statePatch: null,
        accountView: {
          action: 'edit',
          messageId: callbackMessageId,
          token,
          text,
          buttons,
          mode: 'main_hidden',
          platformKey: null,
          fallbackText: ACCOUNT_DETAILS_HIDDEN_TEXT
        },
        sensitive: true,
        escalate: false,
        logEvent: { event: 'account_view_hidden', scope: 'main' }
      };
    }
  }

  const credentials = resolveRoyalVipCredentials({ contact, info });
  const token = createAccountViewToken();
  const missing = !credentials.ok;
  if (missing) {
    console.log(`[chatbot] account_credentials_missing contact=${contact.id} reason=${credentials.reason}`);
  }
  const gameAccounts = missing ? [] : await loadLiveGameAccounts(credentials.linkedUid);
  const text = buildMyAccountMainText(credentials, { hidePassword: false });
  const buttons = missing
    ? buildMissingAccountButtons(token)
    : buildMyAccountButtons(token, {
      gameAccounts,
      includeHide: true,
      mode: 'main'
    });

  return {
    kind: missing ? 'account_credentials_missing' : 'account_credentials',
    replies: [{ text, buttons }],
    statePatch: null,
    accountView: {
      action: 'show',
      token,
      previousMessageId: Number(info.account_view_message_id || 0) || null,
      text,
      buttons,
      mode: 'main',
      platformKey: null,
      missing,
      gameAccountCount: gameAccounts.length
    },
    sensitive: !missing,
    escalate: false,
    logEvent: {
      event: missing ? 'account_credentials_missing' : 'account_view_opened',
      reason: missing ? credentials.reason : undefined,
      game_account_count: missing ? 0 : gameAccounts.length
    }
  };
}

function isRegisteredDepositDiscoveryText(text = '') {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return /^(deposit|add money|recharge|load|payment|make deposit|i want to deposit|i need to deposit|load money|load coin|top up|topup)$/i.test(value);
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
  if (flow === 'registered_deposit' || ['deposit_payment_name', 'deposit_amount', 'deposit_await_payment'].includes(String(step || ''))) {
    const raw = String(step || '').trim();
    if (['deposit_payment_name', 'deposit_amount', 'deposit_await_payment'].includes(raw)) {
      return raw;
    }
    // Missing/stale step under an active deposit flow should resume amount entry,
    // not collapse to registration "welcome".
    return 'deposit_amount';
  }
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
  return CUSTOMER_REGISTRATION_HELP_TEXT;
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
  // Explicit slash command only. Plain "register" shows the entry menu instead.
  return /^\/register(@\w+)?(\s|$)/i.test(String(text || '').trim());
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
  if (contact?.bot_paused) return 'Bot paused';
  if (contact?.bot_enabled === false || contact?.bot_enabled === 0) return 'Bot off';
  return 'Bot active';
}
