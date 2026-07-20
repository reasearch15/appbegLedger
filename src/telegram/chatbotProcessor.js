import {
  decideBotReply,
  isChatbotButtonAction,
  normalizeCallbackAction
} from './chatbotEngine.js';
import { registrationCompletionStatus } from '../registration/utils.js';
import { createAppBegPlayerForContact } from '../appbeg/createPlayerService.js';
import { generateCustomerSupportReply } from './customerSupportAi.js';
import { queueBotReply } from './chatbotProcessorDelivery.js';
import { handlePaymentRegistrationQr } from './registrationQrSend.js';

export const SUPPORT_AI_FALLBACK_REPLY = "Sorry, I'm having trouble accessing support right now. Please try again shortly.";
const SUPPORT_AI_TIMEOUT_MS = Number(process.env.CUSTOMER_SUPPORT_AI_TIMEOUT_MS || 15000);

export { queueBotPhotoReply, queueBotReply } from './chatbotProcessorDelivery.js';
export { handlePaymentRegistrationQr } from './registrationQrSend.js';

export function shouldUseRegistrationBot(job, automationState = {}, contact = null) {
  if (job.job_type === 'callback_action') return true;
  if (job.force_entry_menu) return true;
  const flow = automationState.current_flow || automationState.currentFlow;
  if (flow === 'bot_registration' || flow === 'registration_info' || flow === 'registered_deposit') return true;
  const text = String(job.input_text || '').trim();
  if (/^\/(start|register|status|support|cancel|deposit)(@\w+)?(\s|$)/i.test(text)) return true;
  if (/^(staff|done|confirm|cancel|stop)$/i.test(text)) return true;
  // Empty / media updates use the shared entry menu.
  if (!text) return true;
  // Unregistered / in-progress statuses always use registration bot (welcome or step).
  const status = contact?.registration_status || 'New';
  if (!['Registered'].includes(status)) return true;
  return false;
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
  return { ok: true, reason: 'active' };
}

async function processSupportAiJob({ store, contact, job, io, bot, supportAiGenerator = generateCustomerSupportReply }) {
  console.log(`[support-ai] support_ai_inbound_received contact=${contact.id} job=${job.id} message_id=${job.message_id || 'n/a'} telegram_message_id=${job.incoming_telegram_message_id || 'n/a'}`);

  if (!isSupportInboundJob(job)) {
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Support AI skipped: no inbound text' });
    return { ok: true, skipped: true, reason: 'no_inbound_text' };
  }

  if (contact.bot_paused) {
    console.log(`[support-ai] support_ai_auto_reply_skipped contact=${contact.id} reason=manual_pause`);
    await store.completeBotJob(job.id, { status: 'completed', errorText: 'Skipped: bot manually paused' });
    return { ok: true, skipped: true, reason: 'manual_pause' };
  }

  let supportDraft;
  let generationError = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        supportDraft = await withTimeout(supportAiGenerator({
          store,
          contact,
          messageText: job.input_text || ''
        }), SUPPORT_AI_TIMEOUT_MS);
        generationError = null;
        break;
      } catch (error) {
        generationError = error;
        console.error(`[support-ai] support_ai_reply_generation_failed contact=${contact.id} job=${job.id} attempt=${attempt} error=${error.message}`);
      }
    }

    const replyText = generationError || !supportDraft?.configured
      ? SUPPORT_AI_FALLBACK_REPLY
      : String(supportDraft.reply_text || supportDraft.reply || '').trim() || SUPPORT_AI_FALLBACK_REPLY;

    await queueBotReply({
      store,
      user: contact,
      text: replyText,
      buttons: [],
      bot: bot || globalThis.telegramBot || null
    });

    await store.logAutomationDecision({
      userId: contact.id,
      messageId: job.message_id,
      incomingTelegramMessageId: job.incoming_telegram_message_id,
      actionTaken: generationError ? 'support_auto_fallback' : `support_auto_reply:${supportDraft.kind}`,
      responseSent: replyText,
      metadata: {
        jobId: job.id,
        aiMode: 'immediate',
        retryCount: generationError ? 1 : 0,
        error: generationError?.message || null,
        replySource: supportDraft?.replySource || 'fallback',
        confidence: supportDraft?.confidence ?? null,
        intent: supportDraft?.kind || null,
        recommendedAction: supportDraft?.decision?.recommended_action || null
      }
    });

    if (supportDraft?.decision?.recommended_action && supportDraft.decision.recommended_action !== 'send_support_reply') {
      console.log(`[support-ai] support_ai_action_not_auto_executed contact=${contact.id} action=${supportDraft.decision.recommended_action}`);
    }

    await store.completeBotJob(job.id, {
      status: 'completed',
      errorText: generationError ? generationError.message || String(generationError) : null
    });
    emitUpdates(io, contact);
    console.log(`[support-ai] support_ai_reply_sent contact=${contact.id} job=${job.id} fallback=${Boolean(generationError)} intent=${supportDraft?.kind || 'fallback'}`);
    return { ok: true, supportDraft: supportDraft || null, fallback: Boolean(generationError) };
  } catch (error) {
    console.error(`[support-ai] support_ai_reply_send_failed contact=${contact.id} job=${job.id} error=${error.message}`);
    await store.completeBotJob(job.id, {
      status: 'completed',
      errorText: error.message || String(error)
    });
    return { ok: false, error };
  }
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(1000, Number(timeoutMs) || SUPPORT_AI_TIMEOUT_MS);
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI provider timed out.')), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function enqueueChatbotJob(store, {
  contactId,
  telegramUserId,
  messageId = null,
  incomingTelegramMessageId = null,
  jobType = 'inbound_message',
  inputText = '',
  action = null,
  force_entry_menu = false
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

  if (job && force_entry_menu) {
    job.force_entry_menu = true;
  }

  console.log(`[chatbot] bot job created id=${job.id} contact=${contactId} type=${jobType}${action ? ` action=${action}` : ''}${incomingTelegramMessageId != null ? ` telegram_message_id=${incomingTelegramMessageId}` : ''}${force_entry_menu ? ' entry_menu=1' : ''}`);
  await store.nudgeBotQueue(job.id);
  return job;
}

export async function processBotJob(store, job, { io = null, bot = null, supportAiGenerator = generateCustomerSupportReply } = {}) {
  const contact = await store.getUserProfile(job.contact_id);
  if (!contact) {
    await store.completeBotJob(job.id, { status: 'failed', errorText: 'Contact not found' });
    console.log(`[chatbot] bot job skipped id=${job.id} reason=missing_contact`);
    return { ok: false, reason: 'missing_contact' };
  }

  try {
    const beforeState = await store.ensureAutomationState(contact.id);
    console.log(`[chatbot] processing id=${job.id} contact=${contact.id} flow=${beforeState.current_flow || 'none'} step=${beforeState.current_step || 'none'} status=${contact.registration_status}`);

    const registrationJob = shouldUseRegistrationBot(job, beforeState, contact);
    if (!registrationJob) {
      return await processSupportAiJob({ store, contact, job, io, bot, supportAiGenerator });
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

    let forceEntryMenu = Boolean(job.force_entry_menu);
    if (!forceEntryMenu && job.job_type === 'inbound_message' && !job.action) {
      const flow = beforeState.current_flow || beforeState.currentFlow;
      const step = beforeState.current_step || beforeState.currentStep || 'welcome';
      const inProgress = (flow === 'bot_registration' || flow === 'registration_info')
        && step
        && step !== 'welcome';
      if (!inProgress && store.countIncomingMessages) {
        const inboundCount = await store.countIncomingMessages(contact.id);
        forceEntryMenu = inboundCount <= 1;
      } else if (!inProgress && !String(job.input_text || '').trim()) {
        forceEntryMenu = true;
      }
    }

    const decision = await decideBotReply({
      store,
      contact,
      messageText: job.input_text || '',
      action: job.action || null,
      forceEntryMenu
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
        const created = await createAppBegPlayerForContact(store, {
          contactId: contact.id,
          actorName: 'Chatbot',
          io
        });
        await store.updateAutomationState(contact.id, {
          currentFlow: null,
          currentStep: null,
          registrationInfo: {
            ...(decision.statePatch?.registrationInfo || {}),
            create_account_in_progress: false,
            appbeg_creation_complete: true,
            appbeg_password: undefined
          }
        });
        console.log(`[chatbot] create_player_success contact=${contact.id} username=${created?.username || 'n/a'}`);
      } catch (error) {
        console.log(`[chatbot] create_player_failed contact=${contact.id} error=${error.message}`);
        const currentInfo = (await store.getAutomationState(contact.id).catch(() => null))?.registration_info || {};
        const decisionInfo = decision.statePatch?.registrationInfo || {};
        const safeErrorMessage = String(error.message || 'AppBeg player creation failed.').slice(0, 500);
        await store.updateAutomationState(contact.id, {
          currentStep: 'review',
          registrationInfo: {
            ...currentInfo,
            ...decisionInfo,
            create_account_in_progress: false,
            create_account_error: safeErrorMessage
          }
        }).catch(() => null);
        await queueBotReply({
          store,
          user: contact,
          text: 'We could not create your Royal VIP account right now. Your progress has been saved. Please try Create My Account again, or contact support.',
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
      console.log(`[chatbot] bot escalation suppressed contact=${contact.id} reason=${decision.escalateReason || 'handoff'}`);
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
  io.emit('ongoing:changed', { reason: 'contact_update', contactId: contact.id });
}
