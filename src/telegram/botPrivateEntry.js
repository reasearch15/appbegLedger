/**
 * Shared BotFather private-chat entry.
 * Used by /start and any first (or menu-entry) private interaction.
 */

import {
  BOT_REGISTRATION_FLOW,
  resolveEffectiveRegistrationState,
  menuKindButtons,
  menuKindWelcomeText
} from './botRegistrationState.js';
import { chatbotWelcomeCooldownMs } from '../registration/utils.js';

/**
 * Upsert a Bot API contact from a Telegram private-chat user object.
 * Sets telegram_sync_source / active_messaging_source to bot_api via store.upsertTelegramUser.
 * Brand-new contacts receive the Settings default coadmin (via upsertTelegramUser INSERT).
 * Existing contacts are never reassigned here.
 */
export async function ensureBotApiPrivateContact(store, telegramFrom, seenAt = null) {
  if (!telegramFrom) throw new Error('Telegram from user is required.');
  const when = seenAt || new Date().toISOString();
  const telegramId = Number(telegramFrom.telegram_id ?? telegramFrom.id);
  let isNewContact = false;
  if (Number.isFinite(telegramId) && store.db?.prepare) {
    const existingRow = await store.db.prepare('SELECT id FROM telegram_users WHERE telegram_id = ?').get(telegramId);
    isNewContact = !existingRow;
  }

  const user = await store.upsertTelegramUser(telegramFrom, when);
  await store.ensureConversation(user.id, when);
  if (store.ensureBotSession) {
    await store.ensureBotSession(user.id);
  }
  if (store.ensureAutomationState) {
    await store.ensureAutomationState(user.id);
  }

  // Defense-in-depth for brand-new contacts only (upsert already assigns on INSERT).
  if (isNewContact && typeof store.assignCoadminToUser === 'function') {
    await store.assignCoadminToUser(user.id, 'System');
  }

  return store.getUserProfile(user.id);
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

/**
 * Build the same state-aware welcome/menu decision used by /start.
 */
export async function buildStateAwareEntryMenu({
  store,
  contact,
  automationState = null,
  paymentWindow = null,
  forceFull = true
} = {}) {
  const state = automationState || (store.ensureAutomationState
    ? await store.ensureAutomationState(contact.id)
    : null);
  let window = paymentWindow;
  if (window === null && store.getActiveRegistrationPaymentWindow) {
    try {
      window = await store.getActiveRegistrationPaymentWindow(contact.id);
    } catch {
      window = null;
    }
  }

  const effective = await resolveEffectiveRegistrationState({
    contact,
    automationState: state,
    paymentWindow: window
  });
  const info = { ...(state?.registration_info || {}) };
  const ledgerRegistered = contact?.registration_status === 'Registered' || effective.is_registered;
  // Never demote a Ledger-Registered contact to guest menu / bot_registration via Main Menu.
  const menuKind = ledgerRegistered && effective.menu_kind === 'guest'
    ? 'registered'
    : effective.menu_kind;
  const throttled = !forceFull && menuKind === 'guest' && isWelcomeThrottled(state);
  const text = throttled && menuKind === 'guest'
    ? menuKindWelcomeText(contact, { ...effective, menu_kind: menuKind })
    : menuKindWelcomeText(contact, { ...effective, menu_kind: menuKind });

  const keepFlow = effective.registration_active
    && state?.current_flow
    && menuKind !== 'guest';

  const depositActive = state?.current_flow === 'registered_deposit'
    || ['deposit_payment_name', 'deposit_amount', 'deposit_await_payment'].includes(String(state?.current_step || ''))
    || info.deposit_in_progress
    || info.deposit_awaiting_payment;

  let nextFlow = state?.current_flow || null;
  let nextStep = state?.current_step || null;
  if (!keepFlow) {
    if (depositActive) {
      nextFlow = state?.current_flow || 'registered_deposit';
      nextStep = state?.current_step || 'deposit_amount';
    } else if (ledgerRegistered) {
      // Clear stale registration-wizard leftovers; never re-enter bot_registration from menu.
      if (nextFlow === BOT_REGISTRATION_FLOW || nextFlow === 'registration_info') {
        nextFlow = null;
        nextStep = null;
      }
    } else if (menuKind === 'guest') {
      nextFlow = BOT_REGISTRATION_FLOW;
      nextStep = 'welcome';
    }
  }

  return {
    kind: throttled ? 'welcome_nudge' : (menuKind === 'guest' ? 'welcome' : `menu_${menuKind}`),
    replies: [{
      text,
      buttons: menuKindButtons(menuKind)
    }],
    statePatch: keepFlow
      ? null
      : {
        currentFlow: nextFlow,
        currentStep: nextStep,
        registrationInfo: {
          ...info,
          telegram_display_name: contact.display_name,
          telegram_username: contact.username || null,
          telegram_user_id: contact.telegram_id
        }
      },
    markWelcomeSent: menuKind === 'guest',
    escalate: false,
    effective: { ...effective, menu_kind: menuKind },
    logEvent: {
      event: throttled ? 'welcome_nudged' : 'main_menu_shown',
      menuKind,
      effectiveStatus: ledgerRegistered ? 'Registered' : effective.effective_status,
      throttled,
      entry: true
    }
  };
}

/**
 * Whether this inbound job should show the shared entry menu
 * (same as /start) instead of support AI or field capture.
 */
export function shouldShowEntryMenu({
  text = '',
  action = null,
  forceEntryMenu = false,
  registrationInProgress = false
} = {}) {
  if (action) return false;
  if (registrationInProgress) return false;
  if (forceEntryMenu) return true;
  const value = String(text || '').trim();
  if (!value) return true; // media / empty
  if (/^\/start(@\w+)?(\s|$)/i.test(value)) return true;
  if (isGreetingEntryText(value)) return true;
  return false;
}

export function isPlainRegisterText(text = '') {
  return /^register$/i.test(String(text || '').trim());
}

export function isGreetingEntryText(text = '') {
  const normalized = normalizeGreetingText(text);
  if (!normalized) return false;
  if (/^h+i+$/.test(normalized)) return true;
  if (/^he+l+o+( there)?$/.test(normalized)) return true;
  if (/^he+y+( there)?$/.test(normalized)) return true;
  return [
    'good morning',
    'good afternoon',
    'good evening',
    'hola',
    'namaste',
    'start',
    'menu'
  ].includes(normalized);
}

function normalizeGreetingText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
