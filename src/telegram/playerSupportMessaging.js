/**
 * Private Royal VIP subscriber messaging.
 *
 * Hub is storefront only. Players contact Royal VIP through the private bot.
 * Staff read/reply in the private staff CRM forum. Nothing private is posted
 * to Royal Vip Hub.
 *
 * Identity is always ctx.from.id / telegram_users.id. Deep-link payload
 * `support` only selects this flow.
 */

import { parseBotCommand } from './botRegistrationState.js';
import { isGreetingEntryText } from './botPrivateEntry.js';
import { isRegisteredDepositFlow } from './registeredDepositFlow.js';

export const PRIVATE_SUPPORT_FLOW = 'private_support';
export const PRIVATE_SUPPORT_STEP = 'awaiting_message';
export const PRIVATE_SUPPORT_PROMPT = '💬 Send us a message below and our team will reply here.';

export function isPrivateSupportFlow(flow) {
  return String(flow || '') === PRIVATE_SUPPORT_FLOW;
}

export function buildPrivateSupportStartDecision() {
  return {
    kind: 'private_support_welcome',
    replies: [{ text: PRIVATE_SUPPORT_PROMPT }],
    statePatch: {
      currentFlow: PRIVATE_SUPPORT_FLOW,
      currentStep: PRIVATE_SUPPORT_STEP
    },
    escalate: false,
    logEvent: { event: 'private_support_started' }
  };
}

export function buildPrivateSupportInboundDecision() {
  return {
    kind: 'private_support_inbound',
    replies: [],
    statePatch: {
      currentFlow: PRIVATE_SUPPORT_FLOW,
      currentStep: PRIVATE_SUPPORT_STEP
    },
    escalate: false,
    logEvent: { event: 'private_support_inbound' }
  };
}

export function isRegistrationCollectingInput(flow, step) {
  const currentFlow = String(flow || '');
  if (currentFlow !== 'bot_registration' && currentFlow !== 'registration_info') return false;
  const currentStep = String(step || '').toLowerCase();
  if (!currentStep || currentStep === 'welcome') return false;
  return true;
}

export function extractSupportedInboundMedia(message = null) {
  if (!message || typeof message !== 'object') return null;
  if (Array.isArray(message.photo) && message.photo.length) {
    const best = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: best.file_id,
      fileUniqueId: best.file_unique_id || null
    };
  }
  if (message.document?.file_id) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || null,
      fileName: message.document.file_name || 'document'
    };
  }
  return null;
}

export function unsupportedInboundMediaLabel(message = null) {
  if (!message || typeof message !== 'object') return null;
  if (message.video) return 'video';
  if (message.video_note) return 'video note';
  if (message.voice) return 'voice message';
  if (message.audio) return 'audio';
  if (message.sticker) return 'sticker';
  if (message.animation) return 'animation';
  return null;
}

export function shouldMirrorPlayerInboundToStaff({
  text = '',
  automationState = null,
  botSession = null,
  hasSupportedMedia = false,
  hasUnsupportedMedia = false
} = {}) {
  const value = String(text || '').trim();
  if (parseBotCommand(value)) return false;

  const flow = automationState?.current_flow;
  const step = automationState?.current_step;
  if (isRegistrationCollectingInput(flow, step)) return false;
  if (isRegisteredDepositFlow(flow, step)) return false;
  if (isRegisteredDepositFlow(botSession?.workflow_key, botSession?.workflow_step)) return false;
  if (String(step || '').toLowerCase().includes('password')) return false;

  if (!isPrivateSupportFlow(flow) && isGreetingEntryText(value) && !hasSupportedMedia) {
    return false;
  }

  if (hasSupportedMedia || hasUnsupportedMedia) return true;
  return Boolean(value);
}

export function appBegUsernameForContact(contact = {}) {
  const info = contact.registration_info || {};
  return String(
    info.preferred_appbeg_username
    || info.appbeg_username
    || contact.royal_vip_username
    || contact.appbeg_account_id
    || ''
  ).trim() || null;
}

export function isRegisteredRoyalVipContact(contact = {}) {
  return String(contact.registration_status || '') === 'Registered';
}

export function staffTopicTitleForContact(contact = {}) {
  const name = String(contact.display_name || contact.first_name || 'Player').trim() || 'Player';
  const username = appBegUsernameForContact(contact);
  const suffix = isRegisteredRoyalVipContact(contact) && username
    ? username
    : 'Not registered';
  return `👤 ${name} · ${suffix}`.slice(0, 128);
}

export function formatPlayerInboundForStaff({ contact = {}, text = '', media = null, unsupportedMedia = null } = {}) {
  const name = String(contact.display_name || contact.first_name || 'Unknown').trim() || 'Unknown';
  const telegramId = contact.telegram_id != null ? String(contact.telegram_id) : '—';
  const body = String(text || '').trim();
  const mediaLine = media?.kind === 'photo'
    ? '📷 Photo'
    : (media?.kind === 'document' ? `📎 ${media.fileName || 'Document'}` : null);
  const unsupportedLine = unsupportedMedia
    ? `[${unsupportedMedia} received — not forwarded. Ask the player to send a photo or document.]`
    : null;
  const message = [body, mediaLine, unsupportedLine].filter(Boolean).join('\n') || '(no text)';
  const lines = isRegisteredRoyalVipContact(contact)
    ? [
      `👤 Player: ${name}`,
      `🎮 AppBeg: ${appBegUsernameForContact(contact) || '—'}`,
      `🆔 Telegram ID: ${telegramId}`,
      '',
      'Message:',
      message
    ]
    : [
      `👤 Telegram: ${name}`,
      '⚠️ Royal VIP: Not registered',
      '',
      'Message:',
      message
    ];
  return lines.join('\n');
}

export function formatPlayerFacingStaffReply(text = '') {
  const body = String(text || '').trim();
  return body ? `Royal Vip:\n${body}` : 'Royal Vip:';
}

export function newSupportNeedsStaffPing({ existingTopic = null, conversationStatus = null } = {}) {
  if (!existingTopic) return true;
  return String(conversationStatus || '') === 'Closed';
}
