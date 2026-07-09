import { createReplySender, normalizeButtonRows } from './messageDelivery.js';
import {
  decideBotReply,
  isBotActiveForContact,
  isChatbotButtonAction,
  normalizeCallbackAction
} from './chatbotEngine.js';
import { paymentQrCaption, paymentMethodUnavailableMessage } from '../payments/methodUtils.js';
import { registrationCompletionStatus } from '../registration/utils.js';
import { createAppBegPlayerForContact } from '../appbeg/createPlayerService.js';

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
    console.log(`[chatbot] bot reply sent contact=${user.id} channel=${result?.source || 'bot_api'} message_id=${result?.messageId || 'n/a'} buttons=${buttonCount}`);
  }
  if (buttonCount) {
    console.log(`[chatbot] welcome_buttons_${result?.queued ? 'queued' : 'sent'} contact=${user.id} channel=${result?.source || 'unknown'} buttons=${JSON.stringify(normalizedButtons)}`);
  }
  return result;
}

export async function queueBotPhotoReply({ store, user, text, mediaPath, bot = null }) {
  const sendReply = await createReplySender({
    store,
    user,
    bot: bot || globalThis.telegramBot || null,
    preferButtonsViaBot: true
  });
  const result = await sendReply({
    user,
    text,
    mediaPath,
    messageType: 'image'
  });
  if (result?.queued) {
    console.log(`[chatbot] bot photo queued contact=${user.id} outbound=${result.outboundId || 'n/a'} media=${mediaPath}`);
  } else {
    console.log(`[chatbot] bot photo sent contact=${user.id} channel=${result?.source || 'bot_api'} message_id=${result?.messageId || 'n/a'}`);
  }
  return result;
}

async function handlePaymentRegistrationQr({ store, contact, sendPaymentQr, bot }) {
  const qr = await store.getActiveDefaultPaymentQr(sendPaymentQr.paymentMethodId);
  if (!qr?.file_path) {
    await queueBotReply({
      store,
      user: contact,
      text: paymentMethodUnavailableMessage(sendPaymentQr.paymentMethodName || 'This payment method'),
      bot: bot || globalThis.telegramBot || null
    });
    return;
  }

  const caption = paymentQrCaption({
    paymentMethodName: sendPaymentQr.paymentMethodName,
    firstDepositAmount: sendPaymentQr.firstDepositAmount,
    paymentDisplayName: sendPaymentQr.paymentDisplayName
  });
  const paymentWindow = await store.createRegistrationPaymentWindow({
    contactId: contact.id,
    telegramUserId: contact.telegram_id,
    paymentMethodId: sendPaymentQr.paymentMethodId,
    paymentQrCodeId: qr.id,
    paymentDisplayName: sendPaymentQr.paymentDisplayName,
    firstDepositAmount: sendPaymentQr.firstDepositAmount,
    windowMinutes: 5
  });

  await queueBotPhotoReply({
    store,
    user: contact,
    text: caption,
    mediaPath: qr.file_path,
    bot: bot || globalThis.telegramBot || null
  });

  await store.updateAutomationState(contact.id, {
    currentStep: 'await_payment_done'
  });

  console.log(`[chatbot] registration_qr_sent contact=${contact.id} window=${paymentWindow.id} method=${sendPaymentQr.paymentMethodId} qr=${qr.id}`);
  console.log(`[chatbot] registration_payment_window_started contact=${contact.id} window=${paymentWindow.id} expires_at=${paymentWindow.expires_at}`);
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

    const autoBot = await store.getAutoRegistrationBotSettings();
    if (!autoBot.enabled) {
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Auto registration bot disabled' });
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id} job=${job.id}`);
      return { ok: true, skipped: true, reason: 'bot_disabled' };
    }

    const eligibility = await store.isIncomingMessageEligibleForAutoBot(contact.id, {
      telegramMessageId: job.incoming_telegram_message_id,
      jobCreatedAt: job.created_at
    });
    if (!eligibility.eligible) {
      await store.completeBotJob(job.id, {
        status: 'completed',
        errorText: `Skipped: ${eligibility.reason}`
      });
      if (eligibility.reason === 'before_resume_checkpoint') {
        console.log(`[chatbot] manual_chat_preserved contact=${contact.id} job=${job.id}`);
      } else {
        console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id} job=${job.id} reason=${eligibility.reason}`);
      }
      return { ok: true, skipped: true, reason: eligibility.reason };
    }

    const apprenticeMode = await store.getStaffAiApprenticeSettings?.();
    if (apprenticeMode && !apprenticeMode.enabled) {
      await store.logAutomationDecision({
        userId: contact.id,
        messageId: job.message_id,
        incomingTelegramMessageId: job.incoming_telegram_message_id,
        actionTaken: 'manual_mode_suppressed',
        responseSent: null,
        metadata: {
          jobId: job.id,
          apprenticeMode: false,
          autoSendSuppressed: true,
          reason: 'production_ai_mode_not_enabled',
          action: job.action || null
        }
      });
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Manual mode: AI generation and auto-send suppressed' });
      emitUpdates(io, contact);
      return { ok: true, skipped: true, reason: 'manual_mode_suppressed' };
    }

    const decision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: job.action || null
    });

    console.log(`[chatbot] bot reply generated id=${job.id} contact=${contact.id} kind=${decision.kind}`);
    const logEvents = decision.logEvents || (decision.logEvent ? [decision.logEvent] : []);
    for (const logEvent of logEvents) {
      if (logEvent?.event) {
        console.log(`[chatbot] ${logEvent.event} contact=${contact.id}${formatLogExtra(logEvent)}`);
      }
    }

    if (apprenticeMode?.enabled) {
      const draftReply = (decision.replies || [])
        .map((reply) => reply?.text)
        .filter(Boolean)
        .join('\n\n');
      if (draftReply) {
        await store.createStaffAiTrainingDraft({
          contactId: contact.id,
          telegramUserId: contact.telegram_id,
          incomingMessageId: job.message_id || null,
          customerMessage: job.input_text || '',
          detectedIntent: decision.kind || job.action || 'unknown',
          detectedEntities: {
            action: job.action || null,
            currentFlow: beforeState?.current_flow || null,
            currentStep: beforeState?.current_step || null,
            decisionKind: decision.kind || null,
            buttons: (decision.replies || []).flatMap((reply) => reply.buttons || [])
          },
          aiDraftReply: draftReply,
          language: contact.language_code || null,
          sentiment: null
        });
        console.log(`[chatbot] apprentice_draft_saved contact=${contact.id} job=${job.id} kind=${decision.kind}`);
      } else {
        console.log(`[chatbot] apprentice_no_draft contact=${contact.id} job=${job.id} kind=${decision.kind}`);
      }
      await store.logAutomationDecision({
        userId: contact.id,
        messageId: job.message_id,
        incomingTelegramMessageId: job.incoming_telegram_message_id,
        actionTaken: `apprentice_draft:${decision.kind}`,
        responseSent: draftReply,
        metadata: {
          jobId: job.id,
          apprenticeMode: true,
          autoSendSuppressed: true,
          moneyAndAccountActionsSuppressed: true,
          kind: decision.kind,
          action: job.action || null
        }
      });
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Apprentice mode: draft saved, auto-send suppressed' });
      emitUpdates(io, contact);
      return { ok: true, decision, apprenticeMode: true };
    }

    if (decision.setStatus) {
      await store.updateRegistrationStatus(contact.id, decision.setStatus, 'Chatbot');
    }

    if (decision.statePatch) {
      await store.updateAutomationState(contact.id, decision.statePatch);
      if (decision.statePatch.registrationInfo && !decision.replaceRegistrationInfo) {
        await store.updateRegistrationInfo(contact.id, decision.statePatch.registrationInfo, 'Chatbot');
      }
    }

    // Time-based welcome throttle marker only — never a permanent reply block.
    if (decision.markWelcomeSent) {
      await store.markAutoWelcomeSent(contact.id);
    }

    if (decision.expirePaymentWindowId) {
      await store.expireRegistrationPaymentWindow(decision.expirePaymentWindowId, { suppressNotification: true });
    }

    if (decision.completePaymentWindowId) {
      await store.completeRegistrationPaymentWindow(decision.completePaymentWindowId);
    }

    if (decision.sendPaymentQr) {
      await handlePaymentRegistrationQr({
        store,
        contact,
        sendPaymentQr: decision.sendPaymentQr,
        bot: bot || globalThis.telegramBot || null
      });
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

    if (decision.createAppBegPlayer) {
      try {
        await createAppBegPlayerForContact(store, {
          contactId: contact.id,
          actorName: 'Chatbot',
          io
        });
        await store.updateAutomationState(contact.id, {
          currentFlow: null,
          currentStep: null
        });
        console.log(`[chatbot] create_player_success contact=${contact.id}`);
      } catch (error) {
        console.log(`[chatbot] create_player_failed contact=${contact.id} error=${error.message}`);
        await queueBotReply({
          store,
          user: contact,
          text: `We couldn't create your AppBeg account right now: ${error.message}\n\nPlease reply Staff and our team will help you finish registration.`,
          bot: bot || globalThis.telegramBot || null
        });
      }
    }

    if (decision.readyToCreatePlayer) {
      console.log(`[chatbot] ready_to_create_player contact=${contact.id}`);
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
