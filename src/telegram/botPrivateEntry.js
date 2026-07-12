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
 */
export async function ensureBotApiPrivateContact(store, telegramFrom, seenAt = null) {
  if (!telegramFrom) throw new Error('Telegram from user is required.');
  const when = seenAt || new Date().toISOString();
  const user = await store.upsertTelegramUser(telegramFrom, when);
  await store.ensureConversation(user.id, when);
  if (store.ensureBotSession) {
    await store.ensureBotSession(user.id);
  }
  if (store.ensureAutomationState) {
    await store.ensureAutomationState(user.id);
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
  const throttled = !forceFull && effective.menu_kind === 'guest' && isWelcomeThrottled(state);
  const text = throttled && effective.menu_kind === 'guest'
    ? [
      '👋 Welcome to Royal VIP!',
      '',
      'It looks like you are not registered with us yet.'
    ].join('\n')
    : menuKindWelcomeText(contact, effective);

  const keepFlow = effective.registration_active
    && state?.current_flow
    && effective.menu_kind !== 'guest';

  return {
    kind: throttled ? 'welcome_nudge' : (effective.menu_kind === 'guest' ? 'welcome' : `menu_${effective.menu_kind}`),
    replies: [{
      text,
      buttons: menuKindButtons(effective.menu_kind)
    }],
    statePatch: keepFlow
      ? null
      : {
        currentFlow: effective.menu_kind === 'guest' ? BOT_REGISTRATION_FLOW : state?.current_flow || null,
        currentStep: effective.menu_kind === 'guest' ? 'welcome' : state?.current_step || null,
        registrationInfo: {
          ...info,
          telegram_display_name: contact.display_name,
          telegram_username: contact.username || null,
          telegram_user_id: contact.telegram_id
        }
      },
    markWelcomeSent: effective.menu_kind === 'guest',
    escalate: false,
    effective,
    logEvent: {
      event: throttled ? 'welcome_nudged' : 'main_menu_shown',
      menuKind: effective.menu_kind,
      effectiveStatus: effective.effective_status,
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
  return false;
}

export function isPlainRegisterText(text = '') {
  return /^register$/i.test(String(text || '').trim());
}
