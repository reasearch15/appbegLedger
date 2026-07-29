import { normalizeCallbackAction } from './chatbotEngine.js';

export const EXPIRED_CALLBACK_MESSAGE = 'This button has expired. Please use the latest options.';

const READ_ONLY_CALLBACKS = new Set([
  'staff:takeover',
  'bot:main_menu',
  'bot:my_account',
  'bot:status',
  'bot:how_it_works',
  'bot:support:menu',
  'bot:support:custom_inquiry'
]);

const PERSISTENT_NAVIGATION_CALLBACKS = new Set([
  'staff:takeover',
  'bot:deposit',
  'bot:main_menu',
  'bot:my_account',
  'bot:how_it_works',
  'bot:support:menu',
  'bot:support:custom_inquiry'
]);

export function isPersistentNavigationCallbackAction(action) {
  const normalized = normalizeCallbackAction(action);
  return normalized ? PERSISTENT_NAVIGATION_CALLBACKS.has(normalized) : false;
}

export function hasCallbackButtons(buttons = []) {
  return normalizeRows(buttons).some((row) => row.some((button) => button.data));
}

export function isStateChangingCallbackAction(action) {
  const normalized = normalizeCallbackAction(action);
  if (!normalized) return false;
  if (normalized === 'bot:how_it_works' || normalized.startsWith('bot:help:') || normalized.startsWith('bot:support:')) return false;
  if (READ_ONLY_CALLBACKS.has(normalized)) return false;
  return normalized.startsWith('bot:')
    || normalized.startsWith('register:')
    || normalized.startsWith('deposit:')
    || normalized.startsWith('flow:')
    || normalized.startsWith('menu:')
    || normalized.startsWith('nav:');
}

export async function recordActiveBotMessage({ store, user, bot = null, messageId, buttons = [] }) {
  if (!store?.getAutomationState || !store?.updateAutomationState || !user?.id || !messageId) {
    return null;
  }
  const normalizedButtons = normalizeRows(buttons);
  if (!hasCallbackButtons(normalizedButtons)) return null;

  const state = await store.getAutomationState(user.id).catch(() => null);
  const info = { ...(state?.registration_info || {}) };
  const previousId = Number(info.active_bot_message_id || 0) || null;
  const nextVersion = (Number(info.active_bot_message_version || 0) || 0) + 1;

  if (previousId && previousId !== Number(messageId) && bot?.telegram?.editMessageReplyMarkup) {
    try {
      await bot.telegram.editMessageReplyMarkup(user.telegram_id, previousId, undefined, { inline_keyboard: [] });
    } catch (error) {
      console.log(`[chatbot] stale_keyboard_cleanup_skipped contact=${user.id} message_id=${previousId} reason=${error.message}`);
    }
  }

  return store.updateAutomationState(user.id, {
    registrationInfo: {
      ...info,
      active_bot_message_id: Number(messageId),
      active_bot_message_version: nextVersion,
      active_bot_message_at: new Date().toISOString()
    }
  });
}

export async function validateCallbackFreshness({ store, user, action, callbackMessageId, callbackMessageDate = null }) {
  const normalizedAction = normalizeCallbackAction(action);
  const callbackAgeSeconds = callbackMessageAgeSeconds(callbackMessageDate);
  if (!isStateChangingCallbackAction(action)) {
    return { ok: true, stateChanging: false, callbackAgeSeconds };
  }
  if (isPersistentNavigationCallbackAction(action)) {
    return {
      ok: true,
      stateChanging: true,
      persistentNavigation: true,
      callbackAgeSeconds
    };
  }
  const state = await store.ensureAutomationState(user.id);
  const info = state?.registration_info || {};
  if (normalizedAction === 'deposit:cancel' && isActiveDepositCancel(state, info)) {
    return {
      ok: true,
      stateChanging: true,
      activeDepositCancel: true,
      callbackAgeSeconds
    };
  }
  const activeMessageId = Number(info.active_bot_message_id || 0) || null;
  const pressedMessageId = Number(callbackMessageId || 0) || null;

  if (!activeMessageId || !pressedMessageId || activeMessageId !== pressedMessageId) {
    return {
      ok: false,
      stateChanging: true,
      reason: 'expired_callback',
      activeMessageId,
      pressedMessageId,
      recoverCurrentStep: !activeMessageId,
      callbackAgeSeconds
    };
  }

  return {
    ok: true,
    stateChanging: true,
    activeMessageId,
    pressedMessageId,
    version: Number(info.active_bot_message_version || 0) || null,
    callbackAgeSeconds
  };
}

function isActiveDepositCancel(state = {}, info = {}) {
  const flow = String(state?.current_flow || state?.currentFlow || '');
  const step = String(state?.current_step || state?.currentStep || '');
  return flow === 'registered_deposit'
    || flow === 'deposit'
    || ['deposit_payment_name', 'deposit_amount', 'deposit_await_payment', 'waiting_amount', 'waiting_payment_name', 'await_payment'].includes(step)
    || Boolean(info.deposit_in_progress || info.deposit_awaiting_payment);
}

function callbackMessageAgeSeconds(callbackMessageDate) {
  const seconds = Number(callbackMessageDate || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - seconds);
}

function normalizeRows(buttons = []) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((row) => (Array.isArray(row) ? row : [row])).filter((row) => row.length);
}
