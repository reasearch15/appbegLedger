import {
  canManageHub,
  canManageStaff,
  canToggleConfidenceMode,
  isRoyalVipHubChat,
  OPERATIONAL_ROLES,
  staffGroupIdFromEnv
} from './operationalRoles.js';
import {
  controlCenterButtons,
  controlCenterText
} from './staffCards.js';
import {
  isAlreadyPinnedError,
  isMessageNotFoundError,
  isMessageNotModifiedError,
  isPermissionDeniedError,
  telegramErrorText
} from './telegramApiErrors.js';

function canonicalControlCenterMarkup() {
  return controlCenterButtons(OPERATIONAL_ROLES.ROOT_ADMIN, {
    canToggle: true,
    canManage: true,
    canManageHub: true
  });
}

export function controlCenterMarkupForRole(role) {
  return controlCenterButtons(role, {
    canToggle: canToggleConfidenceMode(role),
    canManage: canManageStaff(role),
    canManageHub: canManageHub(role)
  });
}

export async function ensureStaffControlCenter({
  store,
  bot,
  pin = true,
  env = process.env
} = {}) {
  const groupId = staffGroupIdFromEnv(env);
  if (!groupId) {
    return { ok: false, reason: 'staff_group_unconfigured', created: false };
  }
  if (isRoyalVipHubChat(groupId, env)) {
    console.warn('[control-center] refused_hub_target');
    return { ok: false, reason: 'refused_hub_target', created: false };
  }
  const telegram = bot?.telegram;
  if (!telegram?.sendMessage) {
    return { ok: false, reason: 'bot_unconfigured', created: false };
  }

  const mode = typeof store.getConfidenceMode === 'function'
    ? await store.getConfidenceMode()
    : { enabled: false };
  const text = controlCenterText(Boolean(mode.enabled), 'root_admin');
  const replyMarkup = canonicalControlCenterMarkup();
  const current = typeof store.getControlCenterState === 'function'
    ? await store.getControlCenterState()
    : {};
  let messageId = Number(current.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) messageId = null;
  let threadId = Number(current.threadId);
  if (!Number.isInteger(threadId) || threadId <= 0) threadId = null;

  let created = false;
  let edited = false;
  let reused = false;

  if (messageId) {
    try {
      await telegram.editMessageText(groupId, messageId, undefined, text, {
        reply_markup: replyMarkup
      });
      edited = true;
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        reused = true;
      } else if (isMessageNotFoundError(error)) {
        messageId = null;
      } else {
        const lastError = telegramErrorText(error).slice(0, 400);
        await store.saveControlCenterState?.({
          messageId: current.messageId || null,
          threadId: current.threadId || null,
          lastError,
          syncedAt: current.syncedAt || null,
          pinned: Boolean(current.pinned)
        }).catch(() => null);
        console.warn('[control-center] sync_failed', lastError);
        return {
          ok: false,
          reason: isPermissionDeniedError(error) ? 'permission_denied' : 'sync_failed',
          error: lastError,
          created: false
        };
      }
    }
  }

  if (!messageId) {
    try {
      const extra = { reply_markup: replyMarkup };
      if (threadId) extra.message_thread_id = threadId;
      const sent = await telegram.sendMessage(groupId, text, extra);
      messageId = Number(sent?.message_id);
      threadId = sent?.message_thread_id ? Number(sent.message_thread_id) : threadId;
      created = true;
    } catch (error) {
      const lastError = telegramErrorText(error).slice(0, 400);
      await store.saveControlCenterState?.({
        messageId: null,
        threadId: current.threadId || null,
        lastError,
        syncedAt: null,
        pinned: false
      }).catch(() => null);
      console.warn('[control-center] create_failed', lastError);
      return {
        ok: false,
        reason: isPermissionDeniedError(error) ? 'permission_denied' : 'create_failed',
        error: lastError,
        created: false
      };
    }
  }

  let pinned = Boolean(current.pinned);
  if (pin && messageId) {
    try {
      await telegram.pinChatMessage(groupId, messageId, { disable_notification: true });
      pinned = true;
    } catch (error) {
      if (isAlreadyPinnedError(error)) {
        pinned = true;
      } else {
        console.warn('[control-center] pin_failed', telegramErrorText(error));
      }
    }
  }

  const syncedAt = new Date().toISOString();
  await store.saveControlCenterState?.({
    messageId,
    threadId,
    lastError: null,
    syncedAt,
    pinned
  });

  return {
    ok: true,
    reason: created ? 'created' : (edited ? 'edited' : 'unchanged'),
    created,
    edited,
    reused,
    pinned,
    messageId
  };
}
