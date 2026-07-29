import {
  SUPPORT_ACCOUNT_NOT_FOUND_TEXT,
  SUPPORT_DELIVERY_FAILED_TEXT,
  buildFreePlayNotificationText,
  resolveAppBegUsernameForSupport,
  sendSupportBotNotification
} from './supportNotificationBot.js';

export const ASK_FREEPLAY_ACTION = 'bot:help:ask_freeplay';
export const FREEPLAY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const FREEPLAY_INELIGIBLE_TEXT = 'You are not eligible for FreePlay at this time.';
export const FREEPLAY_REQUEST_SENT_TEXT = 'Your FreePlay request has been sent.';

export async function decideAskFreePlayRequest({ store, contact, info = {} }) {
  const resolved = resolveAppBegUsernameForSupport({ contact, info });
  if (!resolved.ok) {
    console.log(`[chatbot] appbeg_username_resolution_failed contact=${contact?.id || 'n/a'} reason=${resolved.reason} action=${ASK_FREEPLAY_ACTION}`);
    return {
      kind: 'freeplay_username_missing',
      replies: [{ text: SUPPORT_ACCOUNT_NOT_FOUND_TEXT }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'appbeg_username_resolution_failed', reason: resolved.reason, topic: 'FreePlay' }
    };
  }

  if (typeof store?.tryAcquireFreePlaySendLock !== 'function') {
    throw new Error('FreePlay request store is not configured.');
  }

  const lock = await store.tryAcquireFreePlaySendLock(contact.id, {
    cooldownMs: FREEPLAY_COOLDOWN_MS
  });

  if (!lock?.ok) {
    console.log(`[chatbot] freeplay_request_ineligible contact=${contact.id} reason=${lock?.reason || 'cooldown_active'}`);
    return {
      kind: 'freeplay_request_ineligible',
      replies: [{ text: FREEPLAY_INELIGIBLE_TEXT }],
      statePatch: null,
      escalate: false,
      logEvent: { event: 'freeplay_request_ineligible', reason: lock?.reason || 'cooldown_active' }
    };
  }

  console.log(`[chatbot] freeplay_request_lock_acquired contact=${contact.id} inflight_at=${lock.inflightAt}`);

  return {
    kind: 'freeplay_request_pending',
    replies: [],
    statePatch: null,
    escalate: false,
    supportOwnerNotify: {
      kind: 'freeplay',
      topic: 'FreePlay',
      fingerprint: 'freeplay',
      text: buildFreePlayNotificationText({ username: resolved.username }),
      playerSuccessText: FREEPLAY_REQUEST_SENT_TEXT,
      playerFailureText: SUPPORT_DELIVERY_FAILED_TEXT,
      freePlayInflightAt: lock.inflightAt
    },
    logEvent: { event: 'freeplay_notification_send', inflight_at: lock.inflightAt }
  };
}

/** @deprecated Use support notification delivery path. Kept for older imports. */
export async function deliverFreePlayOwnerNotification(options = {}) {
  const notify = options.notify || {};
  return sendSupportBotNotification({
    store: options.store,
    kind: 'freeplay',
    text: notify.text,
    meta: {
      contactId: options.contact?.id,
      topic: 'FreePlay'
    }
  });
}
