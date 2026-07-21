/**
 * Canonical effective registration state for BotFather onboarding.
 * Used by /start, menus, chatbot, support AI, and staff dashboard.
 */

import { isUnregisteredStatus } from '../registration/utils.js';

export const BOT_REGISTRATION_FLOW = 'bot_registration';

export const CUSTOMER_REGISTRATION_HELP_TEXT = [
  'How registration works:',
  '',
  '1. Register your Royal VIP account.',
  '2. Make your first deposit when prompted.',
  '3. Your account is created automatically after payment verification.',
  '4. Log in and start playing instantly.',
  '5. Deposit and cash out online anytime through the Royal VIP website.',
  '',
  '💎 Royal VIP is a fast online casino platform with instant game loading, secure deposits, and convenient online cash outs.'
].join('\n');

/** Phase 1 canonical steps (aliases map older names onto these). */
export const PHASE1_REGISTRATION_STEPS = [
  'choose_payment_app',
  'enter_payment_tag',
  'enter_payment_display_name',
  'enter_appbeg_username',
  'enter_appbeg_password',
  'referral_choice',
  'enter_referral_code',
  'review',
  'submitted',
  'complete'
];

/** Progress checklist for dashboard (bot_registration). */
export const BOT_REGISTRATION_PROGRESS_STEPS = [
  { key: 'payment_name', label: 'Payment name', field: 'payment_display_name', alt: 'payment_name' },
  { key: 'deposit', label: 'First deposit', field: 'first_deposit_amount', alt: 'requested_deposit_amount' },
  { key: 'payment_confirmed', label: 'Payment verified', field: 'payment_confirmed' },
  { key: 'username', label: 'Royal VIP username', field: 'preferred_appbeg_username' },
  { key: 'password', label: 'Password set', field: 'appbeg_password' },
  { key: 'submitted', label: 'Account created', statuses: ['Pending Verification', 'Registered'] }
];

const STEP_ALIASES = {
  choose_payment_app: 'payment_app',
  enter_payment_tag: 'payment_tag',
  enter_payment_display_name: 'payment_name',
  payment_display_name: 'payment_name',
  enter_appbeg_username: 'username',
  enter_appbeg_password: 'password',
  awaiting_royal_vip_username: 'username',
  awaiting_royal_vip_password: 'password',
  awaiting_referral_choice: 'referral_choice',
  enter_referral_code: 'referral_code',
  awaiting_referral_code: 'referral_code',
  appbeg_username: 'username',
  confirm: 'review',
  chime_payment_name: 'payment_name',
  await_payment_done: 'await_payment',
  waiting_for_payment_confirmation: 'await_payment'
};

export function canonicalizeRegistrationStep(step) {
  const raw = String(step || '').trim();
  if (!raw) return 'welcome';
  return STEP_ALIASES[raw] || raw;
}

export function looksLikeAppBegPlayerUid(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return text.length >= 8 && /^[A-Za-z0-9_-]+$/.test(text);
}

/**
 * Resolve effective workflow status for menus and routing.
 * Priority:
 * 1. Linked active AppBeg player → Registered
 * 2. Linked suspended AppBeg player → Suspended
 * 3. Explicit Rejected
 * 4. Active bot_registration → Collecting Info / Waiting For Payment
 * 5. Submitted / pending verification
 * 6. Otherwise New
 */
export async function resolveEffectiveRegistrationState({
  contact,
  automationState = null,
  paymentWindow = null,
  appbegPlayer = null
} = {}) {
  const info = { ...(automationState?.registration_info || {}) };
  const flow = automationState?.current_flow || null;
  const step = canonicalizeRegistrationStep(automationState?.current_step || null);
  const uid = info.appbeg_player_uid || contact?.appbeg_account_id || null;
  const hasUid = looksLikeAppBegPlayerUid(uid);
  const status = contact?.registration_status || 'New';
  const linkStatus = String(contact?.appbeg_link_status || '').trim().toLowerCase();

  let playerExists = Boolean(appbegPlayer);
  let playerStatus = appbegPlayer?.status || null;

  if (hasUid && !appbegPlayer && globalThis.appbegStore?.configured && globalThis.appbegStore.getPlayerByUid) {
    try {
      appbegPlayer = await globalThis.appbegStore.getPlayerByUid(uid);
      playerExists = Boolean(appbegPlayer);
      playerStatus = appbegPlayer?.status || null;
    } catch {
      playerExists = false;
    }
  }

  const linked = linkStatus === 'linked'
    || (hasUid && playerExists)
    || (hasUid && Boolean(info.appbeg_creation_complete));

  const isRegistered = linked && playerExists && String(playerStatus || '').toLowerCase() !== 'suspended';
  const isSuspended = (linked && String(playerStatus || '').toLowerCase() === 'suspended')
    || status === 'Suspended';

  let effectiveStatus = 'New';
  let menuKind = 'guest';
  let registrationActive = false;

  if (isRegistered) {
    effectiveStatus = 'Registered';
    menuKind = 'registered';
  } else if (isSuspended) {
    effectiveStatus = 'Suspended';
    menuKind = 'suspended';
  } else if (status === 'Rejected') {
    effectiveStatus = 'Rejected';
    menuKind = 'rejected';
  } else if (flow === BOT_REGISTRATION_FLOW || flow === 'registration_info') {
    registrationActive = true;
    const paymentSteps = new Set([
      'first_deposit_amount',
      'await_payment',
      'await_payment_done',
      'waiting_for_payment_confirmation',
      'enter_first_deposit_amount'
    ]);
    const waitingForPayment = paymentSteps.has(step)
      || status === 'Waiting For Payment'
      || (paymentWindow?.status === 'active' && step && step !== 'welcome' && step !== 'payment_name');
    if (waitingForPayment && !info.payment_confirmed) {
      effectiveStatus = 'Waiting For Payment';
      menuKind = 'waiting_payment';
    } else if (step === 'review' || info.registration_confirmed || status === 'Pending Verification') {
      effectiveStatus = status === 'Pending Verification' ? 'Pending Verification' : 'Collecting Info';
      menuKind = status === 'Pending Verification' ? 'pending' : 'in_progress';
    } else if (step && step !== 'welcome') {
      effectiveStatus = 'Collecting Info';
      menuKind = 'in_progress';
    } else {
      effectiveStatus = isUnregisteredStatus(status) ? 'New' : status;
      menuKind = 'guest';
    }
  } else if (status === 'Pending Verification' || info.registration_confirmed) {
    effectiveStatus = 'Pending Verification';
    menuKind = 'pending';
  } else if (status === 'Collecting Info') {
    effectiveStatus = 'Collecting Info';
    menuKind = 'in_progress';
  } else if (!isUnregisteredStatus(status) && status === 'Registered' && !isRegistered) {
    // Stale Ledger Registered without AppBeg proof → treat as New/Collecting
    effectiveStatus = 'New';
    menuKind = 'guest';
  } else {
    effectiveStatus = isUnregisteredStatus(status) ? 'New' : status;
    menuKind = effectiveStatus === 'New' ? 'guest' : 'guest';
  }

  return {
    effective_status: effectiveStatus,
    menu_kind: menuKind,
    is_registered: isRegistered,
    is_suspended: isSuspended,
    registration_active: registrationActive,
    current_flow: flow,
    current_step: step,
    appbeg_player_uid: hasUid ? uid : null,
    appbeg_username: info.preferred_appbeg_username || null,
    appbeg_player_exists: playerExists,
    payment_window_status: paymentWindow?.status || null,
    registration_info: info,
    ledger_status: status
  };
}

export function computeBotRegistrationProgress(contact, info = {}, automationState = null) {
  const status = contact?.registration_status || 'New';
  const step = canonicalizeRegistrationStep(automationState?.current_step);
  const steps = BOT_REGISTRATION_PROGRESS_STEPS.map((item) => {
    let done = false;
    if (item.statuses) {
      done = item.statuses.includes(status);
    } else if (item.field === 'referral_code') {
      done = Object.prototype.hasOwnProperty.call(info, 'referral_code')
        || ['review', 'complete', 'submitted'].includes(step)
        || ['Pending Verification', 'Registered'].includes(status);
    } else if (item.field === 'payment_confirmed') {
      done = Boolean(info.payment_confirmed);
    } else if (item.field === 'appbeg_password') {
      done = Boolean(info.appbeg_password) || ['review', 'complete', 'referral_code'].includes(step)
        || ['Pending Verification', 'Registered'].includes(status);
    } else if (item.alt) {
      done = Boolean(info[item.field] || info[item.alt]);
    } else {
      done = Boolean(info[item.field]);
    }
    return {
      key: item.key,
      label: item.label,
      done
    };
  });
  const completed = steps.filter((s) => s.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    percent: Math.round((completed / Math.max(steps.length, 1)) * 100),
    current_step: step || null,
    current_flow: automationState?.current_flow || null
  };
}

export function maskPaymentIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  if (text.length <= 4) return '••••';
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
}

export function redactRegistrationInfoForApi(info = {}) {
  if (!info || typeof info !== 'object') return info;
  const copy = { ...info };
  if (copy.appbeg_password) copy.appbeg_password = '[redacted]';
  if (copy.payment_tag) {
    copy.payment_tag_masked = maskPaymentIdentifier(copy.payment_tag);
    delete copy.payment_tag;
    delete copy.payment_tag_normalized;
  }
  return copy;
}

export function guestMenuButtons() {
  return [
    [{ label: '👑 Register', action: 'menu:register', text: 'Register', data: 'menu:register' }],
    [
      { label: 'Help', action: 'menu:how_it_works', text: 'Help', data: 'menu:how_it_works' },
      { label: 'Contact', action: 'menu:support', text: 'Contact', data: 'menu:support' }
    ]
  ];
}

export function inProgressMenuButtons() {
  return [
    [{ label: '▶️ Continue Registration', action: 'menu:continue_registration', text: 'Continue Registration', data: 'menu:continue_registration' }],
    [
      { label: '🔄 Restart Registration', action: 'menu:restart_request', text: 'Restart Registration', data: 'menu:restart_request' },
      { label: '❌ Cancel Registration', action: 'register:cancel_request', text: 'Cancel Registration', data: 'register:cancel_request' }
    ]
  ];
}

export function pendingMenuButtons() {
  return [
    [{ label: '🕒 Check Status', action: 'menu:registration_status', text: 'Check Status', data: 'menu:registration_status' }],
    [{ label: '💬 Contact Support', action: 'menu:support', text: 'Contact Support', data: 'menu:support' }]
  ];
}

export function waitingPaymentMenuButtons() {
  return waitingPaymentCancelButtons();
}

export function waitingPaymentCancelButtons() {
  return [
    [{ label: '❌ Cancel Registration', action: 'register:cancel_request', text: 'Cancel Registration', data: 'register:cancel_request' }]
  ];
}

export function paymentQrRetryButtons() {
  return [
    [{ label: '🔄 Try Again', action: 'register:retry_payment_qr', text: 'Try Again', data: 'register:retry_payment_qr' }],
    [{ label: '💬 Contact Support', action: 'menu:support', text: 'Contact Support', data: 'menu:support' }],
    [{ label: '❌ Cancel Registration', action: 'register:cancel_request', text: 'Cancel Registration', data: 'register:cancel_request' }]
  ];
}

export function registeredMenuButtons() {
  return [
    [
      { label: '💰 Deposit', action: 'menu:deposit', text: 'Deposit', data: 'menu:deposit' },
      { label: 'Royal VIP', text: 'Royal VIP', url: 'https://royal.youplatform.org' }
    ],
    [
      { label: '👤 My Account', action: 'menu:my_account', text: 'My Account', data: 'menu:my_account' },
      { label: '💬 Support', action: 'menu:support', text: 'Support', data: 'menu:support' }
    ]
  ];
}

export function suspendedMenuButtons() {
  return [
    [{ label: '⚠️ Account Status', action: 'menu:registration_status', text: 'Account Status', data: 'menu:registration_status' }],
    [{ label: '💬 Contact Support', action: 'menu:support', text: 'Contact Support', data: 'menu:support' }]
  ];
}

export function registrationNavButtons() {
  return [
    [{ label: '❌ Cancel Registration', action: 'register:cancel_request', text: 'Cancel Registration', data: 'register:cancel_request' }]
  ];
}

export function cancelConfirmButtons() {
  return [
    [
      { label: 'Yes', action: 'register:cancel_confirm', text: 'Yes', data: 'register:cancel_confirm' },
      { label: 'No', action: 'register:cancel_abort', text: 'No', data: 'register:cancel_abort' }
    ]
  ];
}

export function restartConfirmButtons() {
  return [
    [
      { label: 'Yes', action: 'register:restart_confirm', text: 'Yes', data: 'register:restart_confirm' },
      { label: 'No', action: 'register:restart_abort', text: 'No', data: 'register:restart_abort' }
    ]
  ];
}

export function reviewScreenButtons() {
  return [
    [{ label: 'Confirm', action: 'register:confirm', text: 'Confirm', data: 'register:confirm' }],
    [{ label: 'Back', action: 'register:edit_password', text: 'Back', data: 'register:edit_password' }],
    [{ label: '❌ Cancel Registration', action: 'register:cancel_request', text: 'Cancel Registration', data: 'register:cancel_request' }]
  ];
}

export function referralChoiceButtons() {
  return [
    [
      { label: 'Yes', action: 'register:enter_referral', text: 'Yes', data: 'register:enter_referral' },
      { label: 'No', action: 'register:skip_referral', text: 'No', data: 'register:skip_referral' }
    ]
  ];
}

export function buildPaymentMethodButtons(methods = []) {
  const rows = [];
  for (let i = 0; i < methods.length; i += 2) {
    const chunk = methods.slice(i, i + 2).map((method) => {
      const key = String(method.key || method.id || method.name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 40) || `m${method.id}`;
      const action = `register:payment_app:${key}`;
      return {
        label: method.name,
        action,
        text: method.name,
        data: action,
        paymentMethodId: method.id,
        paymentMethodKey: method.key,
        paymentMethodName: method.name
      };
    });
    rows.push(chunk);
  }
  rows.push(...registrationNavButtons());
  return rows;
}

export function menuKindButtons(menuKind) {
  switch (menuKind) {
    case 'registered':
      return registeredMenuButtons();
    case 'suspended':
      return suspendedMenuButtons();
    case 'pending':
      return pendingMenuButtons();
    case 'waiting_payment':
      return waitingPaymentMenuButtons();
    case 'in_progress':
      return inProgressMenuButtons();
    case 'rejected':
      return guestMenuButtons();
    case 'guest':
    default:
      return guestMenuButtons();
  }
}

export function menuKindWelcomeText(contact, state) {
  switch (state.menu_kind) {
    case 'registered':
      return 'Welcome back!';
    case 'suspended':
      return 'Your Royal VIP account currently requires review.';
    case 'pending':
      return 'Your registration is being reviewed.';
    case 'waiting_payment':
      return 'Welcome back. We are still waiting to verify your payment.';
    case 'in_progress':
      return 'Welcome back. Your registration is not complete.';
    case 'rejected':
      return 'Your previous registration was not approved. You can start again when ready.';
    case 'guest':
    default:
      return CUSTOMER_REGISTRATION_HELP_TEXT;
  }
}

export function parseBotCommand(text = '') {
  const value = String(text || '').trim();
  const match = value.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] || '').trim()
  };
}

export function clearedBotRegistrationInfo(contact, existingInfo = null) {
  const previous = existingInfo && typeof existingInfo === 'object' ? existingInfo : {};
  const cleared = {
    telegram_display_name: contact?.display_name || previous.telegram_display_name || null,
    telegram_username: contact?.username || previous.telegram_username || null,
    telegram_user_id: contact?.telegram_id || previous.telegram_user_id || null
  };
  // Coadmin is assigned once at BotFather contact creation — never wipe it on restart/cancel.
  for (const key of ['coadmin_name', 'coadmin_code', 'appbeg_coadmin_uid']) {
    if (previous[key] != null && previous[key] !== '') {
      cleared[key] = previous[key];
    }
  }
  return cleared;
}
