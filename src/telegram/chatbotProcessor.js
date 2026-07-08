import { createAccountReplySender } from './messageDelivery.js';
import {
  decideBotReply,
  isBotActiveForContact
} from './chatbotEngine.js';
import { registrationCompletionStatus } from '../registration/utils.js';

/**
 * Always queues replies into telegram_outbound_messages (Telethon sends).
 * Never calls Telegraf sendMessage directly.
 */
export async function queueBotReply({ store, user, text, buttons = [] }) {
  const sendReply = createAccountReplySender({ store });
  const result = await sendReply({ user, text, buttons, messageType: buttons.length ? 'buttons' : 'text' });
  console.log(`[chatbot] bot reply queued contact=${user.id} outbound=${result.outboundId || 'n/a'}`);
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
  if (!contact) return null;
  if (!isBotActiveForContact(contact)) {
    console.log(`[chatbot] skip enqueue contact=${contactId} (bot inactive)`);
    return null;
  }

  const job = await store.createBotJob({
    contactId,
    telegramUserId: telegramUserId || contact.telegram_id,
    messageId,
    incomingTelegramMessageId,
    jobType,
    inputText,
    action
  });
  console.log(`[chatbot] bot job created id=${job.id} contact=${contactId} type=${jobType}`);
  await store.nudgeBotQueue(job.id);
  return job;
}

export async function processBotJob(store, job, { io = null } = {}) {
  const contact = await store.getUserProfile(job.contact_id);
  if (!contact) {
    await store.completeBotJob(job.id, { status: 'failed', errorText: 'Contact not found' });
    return { ok: false, reason: 'missing_contact' };
  }

  if (!isBotActiveForContact(contact)) {
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Bot inactive — skipped' });
    console.log(`[chatbot] bot job skipped id=${job.id} contact=${contact.id} (inactive)`);
    return { ok: true, skipped: true };
  }

  try {
    const decision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: job.action || null
    });

    console.log(`[chatbot] bot reply generated id=${job.id} contact=${contact.id} kind=${decision.kind}`);

    if (decision.setStatus) {
      await store.updateRegistrationStatus(contact.id, decision.setStatus, 'Chatbot');
    }

    if (decision.statePatch) {
      await store.updateAutomationState(contact.id, decision.statePatch);
      if (decision.statePatch.registrationInfo) {
        await store.updateRegistrationInfo(contact.id, decision.statePatch.registrationInfo, 'Chatbot');
      }
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
    }

    for (const reply of decision.replies || []) {
      await queueBotReply({
        store,
        user: contact,
        text: reply.text,
        buttons: reply.buttons || []
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
        kind: decision.kind
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

function emitUpdates(io, contact) {
  if (!io) return;
  io.emit('message:new', { userId: contact.id, contactId: contact.id, telegramId: contact.telegram_id });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('players:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
}
