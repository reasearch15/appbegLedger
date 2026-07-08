import { createReplySender, normalizeButtonRows } from './messageDelivery.js';
import {
  decideBotReply,
  isBotActiveForContact,
  isChatbotButtonAction,
  normalizeCallbackAction
} from './chatbotEngine.js';
import { registrationCompletionStatus } from '../registration/utils.js';

/**
 * Prefer Bot API for messages that include inline buttons (Telegram user
 * accounts often cannot render callback buttons). Text-only replies still go
 * through the existing outbound queue when that is the preferred channel.
 */
export async function queueBotReply({ store, user, text, buttons = [], bot = null }) {
  const normalizedButtons = normalizeButtonRows(buttons);
  const sendReply = await createReplySender({
    store,
    user,
    bot: bot || globalThis.telegramBot || null,
    preferButtonsViaBot: true
  });
  const result = await sendReply({
    user,
    text,
    buttons: normalizedButtons,
    messageType: normalizedButtons.length ? 'buttons' : 'text'
  });
  const buttonCount = normalizedButtons.flat().length;
  if (result?.queued) {
    console.log(`[chatbot] bot reply queued contact=${user.id} outbound=${result.outboundId || 'n/a'} buttons=${buttonCount}`);
  } else {
    console.log(`[chatbot] bot reply sent contact=${user.id} channel=bot_api buttons=${buttonCount}`);
  }
  if (buttonCount) {
    console.log(`[chatbot] welcome_buttons_${result?.queued ? 'queued' : 'sent'} contact=${user.id} buttons=${buttonCount}`);
  }
  return result;
}

export async function enqueueChatbotJob(store, {
  contactId,
  telegramUserId,
  messageId = null,
  incomingTelegramMessageId = null,
  jobType = 'inbound_message',
  inputText = '',
  action = null
}) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) {
    console.log(`[chatbot] bot job skipped reason=missing_contact contact=${contactId}`);
    return null;
  }

  if (!isBotActiveForContact(contact)) {
    const reason = contact.needs_staff_review
      ? 'needs_staff_review'
      : contact.bot_paused
        ? 'bot_paused'
        : contact.bot_enabled === false || contact.bot_enabled === 0
          ? 'bot_disabled'
          : 'bot_inactive';
    console.log(`[chatbot] bot job skipped reason=${reason} contact=${contactId}`);
    return null;
  }

  if (action && !isChatbotButtonAction(action) && jobType === 'callback_action') {
    console.log(`[chatbot] bot job skipped reason=unknown_callback action=${action} contact=${contactId}`);
    return null;
  }

  if (action) {
    const normalized = normalizeCallbackAction(action);
    console.log(`[chatbot] callback_received contact=${contactId} action=${action} normalized=${normalized}`);
    if (normalized === 'bot:register' || action === 'register') {
      console.log(`[chatbot] register_clicked contact=${contactId}`);
    }
    if (normalized === 'staff:takeover' || action === 'staff') {
      console.log(`[chatbot] staff_clicked contact=${contactId}`);
    }
  }

  const job = await store.createBotJob({
    contactId,
    telegramUserId: telegramUserId || contact.telegram_id,
    messageId,
    incomingTelegramMessageId,
    jobType,
    inputText,
    action: action ? normalizeCallbackAction(action) : null
  });

  if (job?.duplicate) {
    console.log(`[chatbot] bot job skipped reason=duplicate_message_id contact=${contactId} telegram_message_id=${incomingTelegramMessageId} existing_job=${job.id}`);
    return job;
  }

  console.log(`[chatbot] bot job created id=${job.id} contact=${contactId} type=${jobType}${action ? ` action=${action}` : ''}${incomingTelegramMessageId != null ? ` telegram_message_id=${incomingTelegramMessageId}` : ''}`);
  await store.nudgeBotQueue(job.id);
  return job;
}

export async function processBotJob(store, job, { io = null, bot = null } = {}) {
  const contact = await store.getUserProfile(job.contact_id);
  if (!contact) {
    await store.completeBotJob(job.id, { status: 'failed', errorText: 'Contact not found' });
    console.log(`[chatbot] bot job skipped id=${job.id} reason=missing_contact`);
    return { ok: false, reason: 'missing_contact' };
  }

  if (!isBotActiveForContact(contact)) {
    const reason = contact.needs_staff_review
      ? 'needs_staff_review'
      : contact.bot_paused
        ? 'bot_paused'
        : 'bot_inactive';
    await store.completeBotJob(job.id, { status: 'completed', errorText: `Bot inactive — ${reason}` });
    console.log(`[chatbot] bot job skipped id=${job.id} contact=${contact.id} reason=${reason}`);
    return { ok: true, skipped: true, reason };
  }

  try {
    const beforeState = await store.ensureAutomationState(contact.id);
    console.log(`[chatbot] processing id=${job.id} contact=${contact.id} flow=${beforeState.current_flow || 'none'} step=${beforeState.current_step || 'none'} status=${contact.registration_status}`);

    const decision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: job.action || null
    });

    console.log(`[chatbot] bot reply generated id=${job.id} contact=${contact.id} kind=${decision.kind}`);
    if (decision.logEvent?.event) {
      console.log(`[chatbot] ${decision.logEvent.event} contact=${contact.id}${formatLogExtra(decision.logEvent)}`);
    }

    if (decision.setStatus) {
      await store.updateRegistrationStatus(contact.id, decision.setStatus, 'Chatbot');
    }

    if (decision.statePatch) {
      await store.updateAutomationState(contact.id, decision.statePatch);
      if (decision.statePatch.registrationInfo) {
        await store.updateRegistrationInfo(contact.id, decision.statePatch.registrationInfo, 'Chatbot');
      }
    }

    // Time-based welcome throttle marker only — never a permanent reply block.
    if (decision.markWelcomeSent) {
      await store.markAutoWelcomeSent(contact.id);
    }

    if (decision.completeRegistration) {
      const info = decision.statePatch?.registrationInfo
        || (await store.getAutomationState(contact.id))?.registration_info
        || {};
      await store.completeRegistration({
        userId: contact.id,
        registrationInfo: info,
        registrationStatus: registrationCompletionStatus(),
        registrationMethod: 'chatbot',
        actorName: 'Chatbot'
      });
      console.log(`[chatbot] registration completed contact=${contact.id}`);
    }

    const afterState = await store.getAutomationState(contact.id);
    console.log(`[chatbot] state contact=${contact.id} current_flow=${afterState?.current_flow || 'none'} current_step=${afterState?.current_step || 'none'}`);

    for (const reply of decision.replies || []) {
      await queueBotReply({
        store,
        user: contact,
        text: reply.text,
        buttons: reply.buttons || [],
        bot: bot || globalThis.telegramBot || null
      });
    }

    if (decision.escalate) {
      await store.markBotNeedsStaffReview(contact.id, decision.escalateReason || 'handoff', 'Chatbot');
      console.log(`[chatbot] bot handoff required contact=${contact.id} reason=${decision.escalateReason || 'handoff'}`);
    }

    await store.logAutomationDecision({
      userId: contact.id,
      messageId: job.message_id,
      incomingTelegramMessageId: job.incoming_telegram_message_id,
      actionTaken: `chatbot:${decision.kind}`,
      responseSent: (decision.replies || []).map((item) => item.text).join('\n---\n'),
      metadata: {
        jobId: job.id,
        escalate: Boolean(decision.escalate),
        kind: decision.kind,
        action: job.action || null,
        logEvent: decision.logEvent || null,
        currentFlow: afterState?.current_flow || null,
        currentStep: afterState?.current_step || null,
        buttons: (decision.replies || []).flatMap((reply) => reply.buttons || [])
      }
    });

    await store.completeBotJob(job.id, { status: 'completed' });
    emitUpdates(io, contact);
    return { ok: true, decision };
  } catch (error) {
    console.error(`[chatbot] bot job failed id=${job.id}:`, error);
    await store.completeBotJob(job.id, {
      status: 'failed',
      errorText: error.message || String(error)
    });
    return { ok: false, error };
  }
}

function formatLogExtra(logEvent = {}) {
  return Object.entries(logEvent)
    .filter(([key]) => key !== 'event')
    .map(([key, value]) => ` ${key}=${value}`)
    .join('');
}

function emitUpdates(io, contact) {
  if (!io) return;
  io.emit('message:new', { userId: contact.id, contactId: contact.id, telegramId: contact.telegram_id });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('players:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
}
