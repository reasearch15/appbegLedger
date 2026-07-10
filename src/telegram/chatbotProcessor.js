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
import { generateCustomerSupportReply } from './customerSupportAi.js';
import { isCustomerSupportAiConfigured } from './customerSupportAiConfig.js';

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

export function shouldUseRegistrationBot(job, automationState = {}) {
  if (job.job_type === 'callback_action') return true;
  const flow = automationState.current_flow || automationState.currentFlow;
  if (flow === 'bot_registration') return true;
  const text = String(job.input_text || '').trim();
  if (/^(register|staff|done|confirm)$/i.test(text)) return true;
  return false;
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

export function isSupportInboundJob(job = {}) {
  return job.job_type === 'inbound_message' && Boolean(String(job.input_text || '').trim());
}

function canEnqueueBotJob(contact, { jobType = 'inbound_message', action = null } = {}) {
  if (!contact) return { ok: false, reason: 'missing_contact' };
  if (contact.bot_enabled === false || contact.bot_enabled === 0) {
    return { ok: false, reason: 'bot_disabled' };
  }
  if (jobType === 'inbound_message' && !action) {
    return { ok: true, reason: 'support_inbound' };
  }
  if (!isBotActiveForContact(contact)) {
    const reason = contact.needs_staff_review
      ? 'needs_staff_review'
      : contact.bot_paused
        ? 'bot_paused'
        : 'bot_inactive';
    return { ok: false, reason };
  }
  return { ok: true, reason: 'active' };
}

async function processSupportAiJob({ store, contact, job, io, bot }) {
  console.log(`[support-ai] support_ai_inbound_received contact=${contact.id} job=${job.id} message_id=${job.message_id || 'n/a'} telegram_message_id=${job.incoming_telegram_message_id || 'n/a'}`);

  if (!isSupportInboundJob(job)) {
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Support AI skipped: no inbound text' });
    return { ok: true, skipped: true, reason: 'no_inbound_text' };
  }

  const globalAi = await store.getCustomerSupportAiSettings?.()
    || { mode: 'train', configured: isCustomerSupportAiConfigured() };
  const contactAi = {
    mode: globalAi.mode === 'auto' ? 'auto' : 'train',
    auto_paused: contact.ai_auto_paused === true
      || contact.ai_auto_paused === 1
      || contact.ai_auto_paused === '1'
      || contact.ai_auto_paused === 'true'
  };

  console.log(`[support-ai] support_ai_mode_loaded contact=${contact.id} mode=${contactAi.mode} ai_auto_paused=${contactAi.auto_paused} configured=${globalAi.configured !== false}`);

  if (globalAi.configured === false || !isCustomerSupportAiConfigured()) {
    console.log(`[support-ai] support_ai_draft_failed contact=${contact.id} job=${job.id} reason=not_configured`);
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Support AI not configured' });
    emitSupportAiDraftUpdate(io, contact, { configured: false, draft: null });
    return { ok: true, skipped: true, reason: 'not_configured' };
  }

  if (contactAi.mode === 'auto' && contactAi.auto_paused) {
    console.log(`[support-ai] support_ai_skipped_paused contact=${contact.id} job=${job.id}`);
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Support AI auto paused for contact' });
    return { ok: true, skipped: true, reason: 'auto_paused' };
  }

  console.log(`[support-ai] support_ai_draft_started contact=${contact.id} job=${job.id}`);

  let supportDraft;
  let savedDraft;
  try {
    supportDraft = await generateCustomerSupportReply({
      store,
      contact,
      messageText: job.input_text || '',
      useTraining: contactAi.mode === 'auto'
    });

    if (!supportDraft.configured) {
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Support AI not configured' });
      emitSupportAiDraftUpdate(io, contact, { configured: false, draft: null });
      return { ok: true, skipped: true, reason: 'not_configured' };
    }

    const draftOutcome = contactAi.mode === 'auto' && !contactAi.auto_paused ? 'auto_sent' : 'drafted';

    savedDraft = await store.createStaffAiTrainingDraft({
      contactId: contact.id,
      telegramUserId: contact.telegram_id,
      incomingMessageId: job.message_id || null,
      customerMessage: job.input_text || '',
      conversationContext: supportDraft.context,
      detectedIntent: supportDraft.decision?.intent || supportDraft.kind,
      detectedEntities: supportDraft.entities,
      aiDraftReply: supportDraft.reply_text || supportDraft.reply,
      language: contact.language_code || null,
      sentiment: null,
      confidence: supportDraft.confidence,
      outcome: draftOutcome,
      wasRegistered: supportDraft.contactContext?.was_registered ?? null,
      registrationStatus: supportDraft.contactContext?.registration_status ?? null,
      registrationStep: supportDraft.contactContext?.current_step ?? null,
      paymentWindowStatus: supportDraft.contactContext?.payment_window_status ?? null,
      appbegPlayerUid: supportDraft.contactContext?.appbeg_player_uid ?? null,
      recommendedAction: supportDraft.decision?.recommended_action ?? null,
      actionExecuted: false,
      actionBlockedReason: supportDraft.decision?.action_blocked_reason ?? null
    });
    console.log(`[support-ai] support_ai_draft_created contact=${contact.id} job=${job.id} draft_id=${savedDraft?.id || 'n/a'} intent=${supportDraft.kind}`);
  } catch (error) {
    console.error(`[support-ai] support_ai_draft_failed contact=${contact.id} job=${job.id} error=${error.message}`);
    await store.completeBotJob(job.id, {
      status: 'failed',
      errorText: error.message || String(error)
    });
    emitSupportAiDraftUpdate(io, contact, { configured: true, draft: null, error: error.message });
    return { ok: false, error };
  }

  const shouldAutoSend = contactAi.mode === 'auto' && !contactAi.auto_paused;

  if (shouldAutoSend) {
    await queueBotReply({
      store,
      user: contact,
      text: supportDraft.reply_text || supportDraft.reply,
      buttons: [],
      bot: bot || globalThis.telegramBot || null
    });

    const { executeSupportAiRecommendedAction } = await import('./supportAiActionExecutor.js');
    const actionResult = await executeSupportAiRecommendedAction({
      store,
      contact,
      job,
      decision: supportDraft.decision,
      io,
      bot,
      executeActions: true
    });

    if (savedDraft?.id && store.updateStaffAiTrainingActionResult) {
      await store.updateStaffAiTrainingActionResult(savedDraft.id, actionResult);
    } else if (savedDraft?.id) {
      await store.db.prepare(`
        UPDATE staff_ai_training_examples
        SET action_executed = ?,
            action_blocked_reason = ?
        WHERE id = ?
      `).run(
        Boolean(actionResult.action_executed),
        actionResult.action_blocked_reason || actionResult.reason || null,
        savedDraft.id
      );
    }

    await store.logAutomationDecision({
      userId: contact.id,
      messageId: job.message_id,
      incomingTelegramMessageId: job.incoming_telegram_message_id,
      actionTaken: `support_auto_reply:${supportDraft.kind}`,
      responseSent: supportDraft.reply_text || supportDraft.reply,
      metadata: {
        jobId: job.id,
        aiMode: 'auto',
        replySource: supportDraft.replySource || 'template',
        recommendedAction: supportDraft.decision?.recommended_action || null,
        actionExecuted: actionResult.action_executed,
        actionBlockedReason: actionResult.action_blocked_reason || actionResult.reason || null,
        backendActionsSuppressed: true,
        confidence: supportDraft.confidence,
        intent: supportDraft.kind
      }
    });
    console.log(`[support-ai] auto_reply_sent contact=${contact.id} job=${job.id} intent=${supportDraft.kind} source=${supportDraft.replySource || 'template'}`);
    await store.completeBotJob(job.id, { status: 'completed' });
    emitUpdates(io, contact);
    return { ok: true, supportDraft, autoMode: true };
  }

  await store.logAutomationDecision({
    userId: contact.id,
    messageId: job.message_id,
    incomingTelegramMessageId: job.incoming_telegram_message_id,
    actionTaken: `support_train_draft:${supportDraft.kind}`,
    responseSent: supportDraft.reply_text || supportDraft.reply,
    metadata: {
      jobId: job.id,
      aiMode: contactAi.mode,
      trainMode: contactAi.mode === 'train',
      autoSendSuppressed: true,
      autoPaused: contactAi.auto_paused,
      backendActionsSuppressed: true,
      confidence: supportDraft.confidence,
      intent: supportDraft.kind,
      registrationPhase: supportDraft.contactContext?.registration_phase || null,
      recommendedAction: supportDraft.decision?.recommended_action || null
    }
  });
  await store.completeBotJob(job.id, { status: 'completed', errorText: 'Train Mode: support draft saved, auto-send suppressed' });
  emitSupportAiDraftUpdate(io, contact, { configured: true, draft: savedDraft });
  console.log(`[support-ai] support_ai_draft_visible contact=${contact.id} job=${job.id} draft_id=${savedDraft?.id || 'n/a'}`);
  return { ok: true, supportDraft, trainMode: true, draft: savedDraft };
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

  const enqueueGate = canEnqueueBotJob(contact, { jobType, action });
  if (!enqueueGate.ok) {
    console.log(`[chatbot] bot job skipped reason=${enqueueGate.reason} contact=${contactId}`);
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

  try {
    const beforeState = await store.ensureAutomationState(contact.id);
    console.log(`[chatbot] processing id=${job.id} contact=${contact.id} flow=${beforeState.current_flow || 'none'} step=${beforeState.current_step || 'none'} status=${contact.registration_status}`);

    const registrationJob = shouldUseRegistrationBot(job, beforeState);
    if (!registrationJob) {
      return await processSupportAiJob({ store, contact, job, io, bot });
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
        console.log(`[chatbot] auto_reply_skipped contact=${contact.id} job=${job.id} reason=${eligibility.reason}`);
      }
      return { ok: true, skipped: true, reason: eligibility.reason };
    }

    const autoBot = await store.getAutoRegistrationBotSettings();
    if (!autoBot.enabled) {
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Auto registration bot disabled' });
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id} job=${job.id}`);
      return { ok: true, skipped: true, reason: 'bot_disabled' };
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

function emitSupportAiDraftUpdate(io, contact, { configured = true, draft = null, error = null } = {}) {
  if (!io || !contact) return;
  io.emit('staff-ai-draft:changed', {
    contactId: contact.id,
    userId: contact.id,
    configured,
    draft,
    error
  });
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
  io.emit('contacts:changed');
}

function emitUpdates(io, contact) {
  if (!io) return;
  io.emit('message:new', { userId: contact.id, contactId: contact.id, telegramId: contact.telegram_id });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('players:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
}
