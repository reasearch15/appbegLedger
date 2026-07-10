import { isBotActiveForContact, isChatbotButtonAction } from './chatbotEngine.js';

export function normalizeAutoRegistrationBotSettings(row = {}) {
  const enabledRaw = row.auto_registration_bot_enabled;
  const enabled = enabledRaw === undefined || enabledRaw === null
    ? true
    : !(enabledRaw === false || enabledRaw === 0 || enabledRaw === '0' || enabledRaw === 'false');
  return {
    enabled,
    enabled_at: row.auto_registration_bot_enabled_at || null,
    updated_at: row.auto_registration_bot_updated_at || row.updated_at || null,
    updated_by: row.auto_registration_bot_updated_by || null
  };
}

export function isAutoRegistrationBotEnabled(settings = {}) {
  return settings.enabled !== false;
}

export function isMessageAfterBotResumeCheckpoint(messageSentAt, settings = {}) {
  if (!messageSentAt) return false;
  if (!settings.enabled_at) return true;
  const messageMs = new Date(messageSentAt).getTime();
  const resumeMs = new Date(settings.enabled_at).getTime();
  if (Number.isNaN(messageMs) || Number.isNaN(resumeMs)) return false;
  return messageMs > resumeMs;
}

export function canAutoRegistrationBotReply({ settings, messageSentAt }) {
  if (!isAutoRegistrationBotEnabled(settings)) return false;
  return isMessageAfterBotResumeCheckpoint(messageSentAt, settings);
}

function isSupportInboundEnqueue(enqueueParams = {}) {
  return enqueueParams.jobType === 'inbound_message'
    && !enqueueParams.action
    && Boolean(String(enqueueParams.inputText || '').trim());
}

export async function tryEnqueueRegistrationBotJob(store, enqueueChatbotJob, {
  CHATBOT_ENABLED = true,
  contact,
  sentAt = null,
  enqueueParams,
  requireChatbotAction = false
} = {}) {
  if (!CHATBOT_ENABLED) {
    return { enqueued: false, reason: 'env_disabled' };
  }

  if (requireChatbotAction && !isChatbotButtonAction(enqueueParams?.action)) {
    return { enqueued: false, reason: 'not_chatbot_action' };
  }

  if (isSupportInboundEnqueue(enqueueParams)) {
    if (contact.bot_enabled === false || contact.bot_enabled === 0) {
      return { enqueued: false, reason: 'bot_disabled' };
    }
    await enqueueChatbotJob(store, enqueueParams);
    return { enqueued: true, reason: 'enqueued_support' };
  }

  const autoBot = await store.getAutoRegistrationBotSettings();
  if (!autoBot.enabled) {
    console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id}`);
    return { enqueued: false, reason: 'bot_disabled' };
  }

  if (!isBotActiveForContact(contact)) {
    return { enqueued: false, reason: 'contact_inactive' };
  }

  const eligibility = await store.isIncomingMessageEligibleForAutoBot(contact.id, {
    telegramMessageId: enqueueParams?.incomingTelegramMessageId,
    sentAt,
    jobCreatedAt: enqueueParams?.jobCreatedAt || null
  });

  if (!eligibility.eligible) {
    if (eligibility.reason === 'before_resume_checkpoint') {
      console.log(`[chatbot] manual_chat_preserved contact=${contact.id} telegram_message_id=${enqueueParams?.incomingTelegramMessageId || 'n/a'}`);
    } else if (eligibility.reason === 'bot_disabled') {
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id}`);
    }
    return { enqueued: false, reason: eligibility.reason };
  }

  await enqueueChatbotJob(store, enqueueParams);
  return { enqueued: true, reason: 'enqueued' };
}
