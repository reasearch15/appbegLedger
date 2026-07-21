import { normalizeCallbackAction } from './chatbotEngine.js';

export const EXPIRED_CALLBACK_MESSAGE = 'This button has expired. Please use the latest options.';

const READ_ONLY_CALLBACKS = new Set([
  'staff:takeover',
  'bot:my_account',
  'bot:status',
  'bot:how_it_works'
]);

export function hasCallbackButtons(buttons = []) {
  return normalizeRows(buttons).some((row) => row.some((button) => button.data));
}

export function isStateChangingCallbackAction(action) {
  const normalized = normalizeCallbackAction(action);
  if (!normalized) return false;
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

export async function validateCallbackFreshness({ store, user, action, callbackMessageId }) {
  if (!isStateChangingCallbackAction(action)) {
    return { ok: true, stateChanging: false };
  }
  const state = await store.ensureAutomationState(user.id);
  const info = state?.registration_info || {};
  const activeMessageId = Number(info.active_bot_message_id || 0) || null;
  const pressedMessageId = Number(callbackMessageId || 0) || null;

  if (!activeMessageId || !pressedMessageId || activeMessageId !== pressedMessageId) {
    return {
      ok: false,
      stateChanging: true,
      reason: 'expired_callback',
      activeMessageId,
      pressedMessageId,
      recoverCurrentStep: !activeMessageId
    };
  }

  return {
    ok: true,
    stateChanging: true,
    activeMessageId,
    pressedMessageId,
    version: Number(info.active_bot_message_version || 0) || null
  };
}

function normalizeRows(buttons = []) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((row) => (Array.isArray(row) ? row : [row])).filter((row) => row.length);
}
