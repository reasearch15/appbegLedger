import {
  decideBotReply,
  isChatbotButtonAction,
  normalizeCallbackAction
} from './chatbotEngine.js';
import { parseMoneyToCents, registrationCompletionStatus } from '../registration/utils.js';
import { createAppBegPlayerForContact } from '../appbeg/createPlayerService.js';
import { generateCustomerSupportReply } from './customerSupportAi.js';
import { queueBotReply } from './chatbotProcessorDelivery.js';
import { handlePaymentRegistrationQr } from './registrationQrSend.js';
import { isGreetingEntryText } from './botPrivateEntry.js';
import { normalizeButtonRows, toTelegramInlineButton } from './messageDelivery.js';
import { accountViewSnapshotPatch } from './accountView.js';
import {
  DEPOSIT_BOT_SESSION_FLOW,
  DEPOSIT_BOT_SESSION_STEP_AMOUNT,
  DEPOSIT_BOT_SESSION_STEP_NAME,
  isActiveDepositSession,
  REGISTERED_DEPOSIT_FLOW
} from './registeredDepositFlow.js';

export const SUPPORT_AI_FALLBACK_REPLY = "Sorry, I'm having trouble accessing support right now. Please try again shortly.";
const SUPPORT_AI_TIMEOUT_MS = Number(process.env.CUSTOMER_SUPPORT_AI_TIMEOUT_MS || 15000);
const contactJobLocks = new Map();

export { queueBotPhotoReply, queueBotReply } from './chatbotProcessorDelivery.js';
export { handlePaymentRegistrationQr } from './registrationQrSend.js';

export function shouldUseRegistrationBot(job, automationState = {}, contact = null, botSession = null) {
  if (job.job_type === 'callback_action') return true;
  if (job.force_entry_menu) return true;
  if (isActiveDepositSession(automationState, botSession)) return true;
  const flow = automationState.current_flow || automationState.currentFlow;
  if (flow === 'bot_registration' || flow === 'registration_info' || flow === 'registered_deposit') return true;
  const step = String(automationState.current_step || automationState.currentStep || '');
  if (['deposit_payment_name', 'deposit_amount', 'deposit_await_payment', 'waiting_amount', 'waiting_payment_name'].includes(step)) return true;
  const info = automationState.registration_info || automationState.registrationInfo || {};
  // Keep amount entry on the deposit bot even if flow was wiped while the prompt was shown.
  if (info.deposit_in_progress || info.deposit_awaiting_payment) return true;
  const text = String(job.input_text || '').trim();
  if (/^\/(start|register|status|support|cancel|deposit)(@\w+)?(\s|$)/i.test(text)) return true;
  if (isGreetingEntryText(text)) return true;
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
  updateId = null,
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
    updateId,
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
  if (job && updateId != null) {
    job.update_id = updateId;
  }

  console.log(`[chatbot] bot job created id=${job.id} contact=${contactId} type=${jobType}${action ? ` action=${action}` : ''}${updateId != null ? ` update_id=${updateId}` : ''}${incomingTelegramMessageId != null ? ` telegram_message_id=${incomingTelegramMessageId}` : ''}${force_entry_menu ? ' entry_menu=1' : ''}`);
  await store.nudgeBotQueue(job.id);
  return job;
}

export async function processBotJob(store, job, options = {}) {
  const contactId = job?.contact_id || job?.contactId || 'unknown';
  const previous = contactJobLocks.get(contactId) || Promise.resolve();
  let releaseLock;
  const current = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const chain = previous.catch(() => null).then(() => current);
  contactJobLocks.set(contactId, chain);
  await previous.catch(() => null);
  try {
    return await processBotJobUnlocked(store, job, options);
  } finally {
    releaseLock();
    if (contactJobLocks.get(contactId) === chain) {
      contactJobLocks.delete(contactId);
    }
  }
}

async function processBotJobUnlocked(store, job, { io = null, bot = null, supportAiGenerator = generateCustomerSupportReply } = {}) {
  const contact = await store.getUserProfile(job.contact_id);
  if (!contact) {
    await store.completeBotJob(job.id, { status: 'failed', errorText: 'Contact not found' });
    console.log(`[chatbot] bot job skipped id=${job.id} reason=missing_contact`);
    return { ok: false, reason: 'missing_contact' };
  }

  try {
    const beforeState = await store.ensureAutomationState(contact.id);
    const botSession = typeof store.getBotSession === 'function'
      ? await store.getBotSession(contact.id).catch(() => null)
      : null;
    const depositActive = isActiveDepositSession(beforeState, botSession);
    console.log(
      `[chatbot] inbound_lifecycle contact=${contact.id} telegram_id=${contact.telegram_id} ` +
      `update_id=${job.update_id || 'n/a'} telegram_message_id=${job.incoming_telegram_message_id || 'n/a'} ` +
      `text=${JSON.stringify(safeRegistrationLogText(job.input_text, { beforeState }))} ` +
      `action=${job.action || 'none'} job_type=${job.job_type || 'none'} ` +
      `automation_flow=${beforeState.current_flow || 'none'} automation_step=${beforeState.current_step || 'none'} ` +
      `bot_session=${botSession?.workflow_key || 'none'}/${botSession?.workflow_step || 'none'} ` +
      `deposit_active=${depositActive} parsed_amount_cents=${parseMoneyToCents(job.input_text || '') ?? 'invalid'} ` +
      `status=${contact.registration_status}`
    );

    const registrationJob = shouldUseRegistrationBot(job, beforeState, contact, botSession);
    console.log(
      `[chatbot] inbound_router contact=${contact.id} handler=${registrationJob ? 'deposit_or_registration_bot' : 'support_ai'} ` +
      `deposit_active=${depositActive}`
    );
    if (!registrationJob) {
      return await processSupportAiJob({ store, contact, job, io, bot, supportAiGenerator });
    }

    const eligibility = await store.isIncomingMessageEligibleForAutoBot(contact.id, {
      telegramMessageId: job.incoming_telegram_message_id,
      jobCreatedAt: job.created_at
    });
    if (!eligibility.eligible) {
      // Active deposit amount entry must never be silently dropped by eligibility gates.
      // (Support inbound is enqueued without eligibility; registration path would otherwise
      // complete the job with no user-visible reply — the "send 10, nothing happens" bug.)
      if (depositActive) {
        console.log(
          `[chatbot] deposit_session_eligibility_bypass contact=${contact.id} job=${job.id} ` +
          `reason=${eligibility.reason} bot_session=${botSession?.workflow_key || 'none'}/${botSession?.workflow_step || 'none'}`
        );
      } else {
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
    }

    const autoBot = await store.getAutoRegistrationBotSettings();
    if (!autoBot.enabled && !depositActive) {
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Auto registration bot disabled' });
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id} job=${job.id}`);
      return { ok: true, skipped: true, reason: 'bot_disabled' };
    }
    if (!autoBot.enabled && depositActive) {
      console.log(
        `[chatbot] deposit_session_bot_disabled_bypass contact=${contact.id} job=${job.id}`
      );
    }

    let forceEntryMenu = Boolean(job.force_entry_menu);
    if (!forceEntryMenu && job.job_type === 'inbound_message' && !job.action) {
      const flow = beforeState.current_flow || beforeState.currentFlow;
      const step = beforeState.current_step || beforeState.currentStep || 'welcome';
      const info = beforeState.registration_info || beforeState.registrationInfo || {};
      const inProgress = depositActive || (
        ((flow === 'bot_registration' || flow === 'registration_info') && step && step !== 'welcome')
        || flow === 'registered_deposit'
        || ['deposit_payment_name', 'deposit_amount', 'deposit_await_payment', 'waiting_amount'].includes(String(step || ''))
        || info.deposit_in_progress
        || info.deposit_awaiting_payment
      );
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
      forceEntryMenu,
      callbackMessageId: job.job_type === 'callback_action' ? job.incoming_telegram_message_id : null
    });

    console.log(`[chatbot] bot reply generated id=${job.id} contact=${contact.id} kind=${decision.kind}`);
    logRegistrationTrace('handler_selected', { job, contact, decision, beforeState, botSession });
    const logEvents = decision.logEvents || (decision.logEvent ? [decision.logEvent] : []);
    for (const logEvent of logEvents) {
      if (logEvent?.event) {
        console.log(`[chatbot] ${logEvent.event} contact=${contact.id}${formatLogExtra(logEvent)}`);
      }
    }

    const beforeStateSnapshot = cloneRegistrationState(beforeState);
    let stateWriteAttempted = false;
    let stateWriteResult = null;
    try {
      if (decision.setStatus) {
        await store.updateRegistrationStatus(contact.id, decision.setStatus, 'Chatbot');
      }

      if (decision.statePatch) {
        stateWriteAttempted = true;
        logRegistrationTrace('state_transition_attempted', {
          job,
          contact,
          decision,
          beforeState: beforeStateSnapshot,
          nextFlow: decision.statePatch.currentFlow,
          nextStep: decision.statePatch.currentStep
        });
        stateWriteResult = await store.updateAutomationState(contact.id, decision.statePatch);
        if (decision.statePatch.registrationInfo && !decision.replaceRegistrationInfo) {
          stateWriteResult = await store.updateRegistrationInfo(contact.id, decision.statePatch.registrationInfo, 'Chatbot');
        }
        logRegistrationTrace('state_transition_persisted', {
          job,
          contact,
          decision,
          beforeState: beforeStateSnapshot,
          afterState: stateWriteResult
        });
      }
    } catch (error) {
      console.error('[chatbot] registration_state_write_failed', {
        contact_id: contact.id,
        job_id: job.id,
        update_id: job.update_id || null,
        telegram_message_id: job.incoming_telegram_message_id || null,
        handler: decision.kind,
        stack: error?.stack || String(error)
      });
      await sendRegistrationRecoveryReply({ store, contact, bot: bot || globalThis.telegramBot || null });
      throw error;
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

    if (decision.removeDepositPaymentMessage) {
      const cleanup = {
        ...decision.removeDepositPaymentMessage,
        callbackMessageId: decision.removeDepositPaymentMessage.callbackMessageId
          || (job.job_type === 'callback_action' ? Number(job.incoming_telegram_message_id || 0) || null : null)
      };
      await handleDepositCancelCleanup({
        contact,
        cleanup,
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

    let repliesSentBeforeCreate = false;
    let accountViewHandled = false;
    if (decision.createAppBegPlayer && decision.replies?.length) {
      await sendDecisionReplies({ store, contact, decision, job, bot: bot || globalThis.telegramBot || null, beforeStateSnapshot, stateWriteAttempted });
      repliesSentBeforeCreate = true;
    }

    if (decision.accountView) {
      await handleAccountViewDecision({
        store,
        contact,
        decision,
        bot: bot || globalThis.telegramBot || null
      });
      accountViewHandled = true;
    }

    if (decision.createAppBegPlayer) {
      try {
        const created = await createAppBegPlayerForContact(store, {
          contactId: contact.id,
          actorName: 'Chatbot',
          io
        });
        const currentInfo = (await store.getAutomationState(contact.id).catch(() => null))?.registration_info || {};
        await store.updateAutomationState(contact.id, {
          currentFlow: null,
          currentStep: null,
          registrationInfo: {
            ...currentInfo,
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
    console.log(
      `[chatbot] state_after_processing contact=${contact.id} job=${job.id} ` +
      `update_id=${job.update_id || 'n/a'} telegram_message_id=${job.incoming_telegram_message_id || 'n/a'} ` +
      `handler=${decision.kind} current_flow=${afterState?.current_flow || 'none'} ` +
      `current_step=${afterState?.current_step || 'none'} ` +
      `deposit_in_progress=${Boolean(afterState?.registration_info?.deposit_in_progress)} ` +
      `deposit_awaiting_payment=${Boolean(afterState?.registration_info?.deposit_awaiting_payment)}`
    );

    if (!repliesSentBeforeCreate && !accountViewHandled) {
      await sendDecisionReplies({ store, contact, decision, job, bot: bot || globalThis.telegramBot || null, beforeStateSnapshot, stateWriteAttempted });
    }

    // Re-assert deposit session AFTER outbound delivery. recordActiveBotMessage only patches
    // registration_info; reinforce so Help/Account leftovers cannot leave amount entry orphaned.
    if (decision.kind === 'deposit_ask_amount' || decision.kind === 'deposit_ask_payment_name') {
      await reinforceDepositAmountSession(store, contact, decision);
    }

    if (decision.escalate) {
      console.log(`[chatbot] bot escalation suppressed contact=${contact.id} reason=${decision.escalateReason || 'handoff'}`);
    }

    await store.logAutomationDecision({
      userId: contact.id,
      messageId: job.message_id,
      incomingTelegramMessageId: job.incoming_telegram_message_id,
      actionTaken: `chatbot:${decision.kind}`,
      responseSent: decision.sensitive
        ? '[sensitive account details omitted]'
        : (decision.replies || []).map((item) => item.text).join('\n---\n'),
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
    console.error('[chatbot] bot_job_failed', {
      job_id: job.id,
      contact_id: job.contact_id,
      update_id: job.update_id || null,
      telegram_message_id: job.incoming_telegram_message_id || null,
      stack: error?.stack || String(error)
    });
    await store.completeBotJob(job.id, {
      status: 'failed',
      errorText: error.message || String(error)
    });
    return { ok: false, error };
  }
}

async function sendDecisionReplies({ store, contact, decision, job, bot, beforeStateSnapshot, stateWriteAttempted }) {
  for (const reply of decision.replies || []) {
    try {
      logRegistrationTrace('outgoing_send_attempted', {
        job,
        contact,
        decision,
        beforeState: beforeStateSnapshot,
        buttonCount: (reply.buttons || []).flat?.().length || 0
      });
      const result = await queueBotReply({
        store,
        user: contact,
        text: reply.text,
        buttons: reply.buttons || [],
        bot
      });
      logRegistrationTrace('outgoing_send_succeeded', {
        job,
        contact,
        decision,
        beforeState: beforeStateSnapshot,
        outgoing: result
      });
    } catch (error) {
      console.error('[chatbot] outgoing_send_failed', {
        contact_id: contact.id,
        job_id: job.id,
        update_id: job.update_id || null,
        telegram_message_id: job.incoming_telegram_message_id || null,
        handler: decision.kind,
        stack: error?.stack || String(error)
      });
      if (stateWriteAttempted && isRegistrationDecision(decision)) {
        await restoreRegistrationState(store, contact.id, beforeStateSnapshot);
        logRegistrationTrace('state_transition_rolled_back', {
          job,
          contact,
          decision,
          beforeState: beforeStateSnapshot,
          afterState: beforeStateSnapshot
        });
      }
      await sendRegistrationRecoveryReply({ store, contact, bot });
      throw error;
    }
  }
}

async function sendRegistrationRecoveryReply({ store, contact, bot }) {
  try {
    const result = await queueBotReply({
      store,
      user: contact,
      text: 'Something went wrong while saving that. Please try again.',
      buttons: [],
      bot
    });
    console.log('[chatbot] registration_recovery_reply_sent', {
      contact_id: contact.id,
      message_id: result?.messageId || null
    });
  } catch (error) {
    console.error('[chatbot] registration_recovery_reply_failed', {
      contact_id: contact.id,
      stack: error?.stack || String(error)
    });
  }
}

async function restoreRegistrationState(store, contactId, snapshot) {
  await store.updateAutomationState(contactId, {
    currentFlow: snapshot.current_flow ?? null,
    currentStep: snapshot.current_step ?? null,
    registrationInfo: snapshot.registration_info || {}
  });
}

function cloneRegistrationState(state = {}) {
  return {
    current_flow: state?.current_flow ?? null,
    current_step: state?.current_step ?? null,
    registration_info: { ...(state?.registration_info || {}) }
  };
}

function isRegistrationDecision(decision = {}) {
  return String(decision.kind || '').startsWith('registration_')
    || decision.statePatch?.currentFlow === 'bot_registration';
}

function logRegistrationTrace(event, data = {}) {
  const { job, contact, decision, beforeState, afterState, botSession, outgoing, buttonCount, nextFlow, nextStep } = data;
  console.log('[registration-trace]', JSON.stringify({
    event,
    update_id: job?.update_id ?? null,
    job_id: job?.id ?? null,
    message_id: job?.incoming_telegram_message_id ?? null,
    telegram_user_id: contact?.telegram_id ?? job?.telegram_user_id ?? null,
    chat_id: contact?.telegram_id ?? null,
    contact_id: contact?.id ?? job?.contact_id ?? null,
    normalized_text: safeRegistrationLogText(job?.input_text, { beforeState, decision, nextStep }),
    handler: decision?.kind || null,
    session_flow: botSession?.workflow_key || null,
    session_step: botSession?.workflow_step || null,
    before_flow: beforeState?.current_flow || null,
    before_step: beforeState?.current_step || null,
    attempted_flow: nextFlow ?? decision?.statePatch?.currentFlow ?? null,
    attempted_step: nextStep ?? decision?.statePatch?.currentStep ?? null,
    after_flow: afterState?.current_flow || null,
    after_step: afterState?.current_step || null,
    outgoing_message_id: outgoing?.messageId || null,
    outgoing_source: outgoing?.source || null,
    button_count: buttonCount ?? outgoing?.buttons?.flat?.().length ?? null
  }));
}

function safeRegistrationLogText(value = '', { beforeState = null, decision = null, nextStep = null } = {}) {
  if (shouldRedactRegistrationText({ beforeState, decision, nextStep })) {
    return '[redacted]';
  }
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length > 120) return `${text.slice(0, 117)}...`;
  return text;
}

function shouldRedactRegistrationText({ beforeState = null, decision = null, nextStep = null } = {}) {
  const steps = [
    beforeState?.current_step,
    beforeState?.currentStep,
    nextStep,
    decision?.statePatch?.currentStep
  ].map((value) => String(value || '').toLowerCase());
  return steps.some((step) => step.includes('password'));
}

async function handleAccountViewDecision({ store, contact, decision, bot = null }) {
  const view = decision.accountView || {};
  if (!bot?.telegram) {
    for (const reply of decision.replies || []) {
      await queueBotReply({ store, user: contact, text: reply.text, buttons: reply.buttons || [], bot });
    }
    return;
  }

  if (view.action === 'hide') {
    const messageId = Number(view.messageId || 0) || null;
    if (messageId && bot.telegram.deleteMessage) {
      try {
        await bot.telegram.deleteMessage(contact.telegram_id, messageId);
        const state = await store.getAutomationState(contact.id).catch(() => null);
        await store.updateAutomationState(contact.id, {
          registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
            token: view.token,
            messageId,
            hidden: true
          })
        }).catch(() => null);
        return;
      } catch (error) {
        console.log(`[chatbot] account_view_delete_failed contact=${contact.id} message_id=${messageId} reason=${error.message}`);
      }
    }
    if (messageId && bot.telegram.editMessageText) {
      try {
        await bot.telegram.editMessageText(contact.telegram_id, messageId, undefined, view.fallbackText || 'Account details hidden.');
        const state = await store.getAutomationState(contact.id).catch(() => null);
        await store.updateAutomationState(contact.id, {
          registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
            token: view.token,
            messageId,
            hidden: true
          })
        }).catch(() => null);
        return;
      } catch (error) {
        console.log(`[chatbot] account_view_hide_edit_failed contact=${contact.id} message_id=${messageId} reason=${error.message}`);
      }
    }
    return;
  }

  if (view.action !== 'show') return;

  const normalizedButtons = normalizeButtonRows(view.buttons || []);
  const replyMarkup = normalizedButtons.length
    ? { inline_keyboard: normalizedButtons.map((row) => row.map(toTelegramInlineButton)) }
    : undefined;
  const previousMessageId = Number(view.previousMessageId || 0) || null;
  let messageId = null;

  if (previousMessageId && bot.telegram.editMessageText) {
    try {
      await bot.telegram.editMessageText(
        contact.telegram_id,
        previousMessageId,
        undefined,
        view.text,
        replyMarkup ? { reply_markup: replyMarkup } : undefined
      );
      messageId = previousMessageId;
    } catch (error) {
      console.log(`[chatbot] account_view_edit_previous_failed contact=${contact.id} message_id=${previousMessageId} reason=${error.message}`);
    }
  }

  if (!messageId) {
    const sent = await bot.telegram.sendMessage(
      contact.telegram_id,
      view.text,
      replyMarkup ? { reply_markup: replyMarkup } : undefined
    );
    messageId = sent?.message_id || null;
    await store.storeOutgoingMessage({
      telegramUserId: contact.id,
      telegramMessageId: messageId,
      text: decision.sensitive ? '[sensitive account details omitted]' : view.text,
      payload: {
        channel: 'bot_api',
        accountView: true,
        buttons: normalizedButtons
      },
      senderType: 'bot',
      source: 'bot_api',
      messageType: normalizedButtons.length ? 'buttons' : 'text'
    });
  }

  if (messageId) {
    const state = await store.getAutomationState(contact.id).catch(() => null);
    await store.updateAutomationState(contact.id, {
      registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
        token: view.token,
        messageId,
        hidden: false
      })
    });
  }
}

function formatLogExtra(logEvent = {}) {
  return Object.entries(logEvent)
    .filter(([key]) => key !== 'event')
    .map(([key, value]) => ` ${key}=${value}`)
    .join('');
}

/**
 * After Cancel Deposit: delete the QR photo message when possible.
 * If Telegram refuses delete, edit caption to "Deposit cancelled" and strip buttons.
 * When awaiting payment, the Cancel button is on the QR photo itself — delete that
 * callback message even if the stored message id was lost.
 */
async function handleDepositCancelCleanup({ contact, cleanup = {}, bot = null }) {
  const activeBot = bot || globalThis.telegramBot || null;
  if (!activeBot?.telegram || !contact?.telegram_id) {
    console.log(
      `[chatbot] deposit_qr_cleanup_skipped contact=${contact?.id || 'n/a'} ` +
      `reason=${!activeBot?.telegram ? 'missing_bot' : 'missing_telegram_id'}`
    );
    return;
  }

  const chatId = contact.telegram_id;
  const storedQrMessageId = Number(cleanup.messageId || 0) || null;
  const callbackMessageId = Number(cleanup.callbackMessageId || 0) || null;
  const awaitingPayment = Boolean(cleanup.awaitingPayment);
  const messageIds = new Set();
  if (storedQrMessageId) messageIds.add(storedQrMessageId);
  // Cancel Deposit on the QR photo: callback message is the photo to remove.
  if (awaitingPayment && callbackMessageId) messageIds.add(callbackMessageId);

  if (!messageIds.size) {
    console.log(
      `[chatbot] deposit_qr_cleanup_no_message_id contact=${contact.id} ` +
      `callback_message_id=${callbackMessageId || 'none'} awaiting_payment=${awaitingPayment}`
    );
    if (callbackMessageId && activeBot.telegram.editMessageReplyMarkup) {
      try {
        await activeBot.telegram.editMessageReplyMarkup(chatId, callbackMessageId, undefined, { inline_keyboard: [] });
        console.log(`[chatbot] deposit_cancel_button_cleared contact=${contact.id} message_id=${callbackMessageId}`);
      } catch (error) {
        console.log(
          `[chatbot] deposit_cancel_button_clear_failed contact=${contact.id} ` +
          `message_id=${callbackMessageId} reason=${error.message}`
        );
      }
    }
    return;
  }

  for (const qrMessageId of messageIds) {
    let qrRemoved = false;
    if (activeBot.telegram.deleteMessage) {
      try {
        await activeBot.telegram.deleteMessage(chatId, qrMessageId);
        qrRemoved = true;
        console.log(`[chatbot] deposit_qr_message_deleted contact=${contact.id} message_id=${qrMessageId}`);
      } catch (error) {
        console.log(
          `[chatbot] deposit_qr_message_delete_failed contact=${contact.id} ` +
          `message_id=${qrMessageId} reason=${error.message}`
        );
      }
    }

    if (!qrRemoved) {
      const emptyMarkup = { reply_markup: { inline_keyboard: [] } };
      try {
        if (activeBot.telegram.editMessageCaption) {
          await activeBot.telegram.editMessageCaption(
            chatId,
            qrMessageId,
            undefined,
            'Deposit cancelled.',
            emptyMarkup
          );
        } else if (activeBot.telegram.editMessageText) {
          await activeBot.telegram.editMessageText(
            chatId,
            qrMessageId,
            undefined,
            'Deposit cancelled.',
            emptyMarkup
          );
        } else if (activeBot.telegram.editMessageReplyMarkup) {
          await activeBot.telegram.editMessageReplyMarkup(chatId, qrMessageId, undefined, { inline_keyboard: [] });
        }
        console.log(`[chatbot] deposit_qr_message_cancelled_inplace contact=${contact.id} message_id=${qrMessageId}`);
      } catch (error) {
        console.log(
          `[chatbot] deposit_qr_message_edit_failed contact=${contact.id} ` +
          `message_id=${qrMessageId} reason=${error.message}`
        );
        if (activeBot.telegram.editMessageReplyMarkup) {
          try {
            await activeBot.telegram.editMessageReplyMarkup(chatId, qrMessageId, undefined, { inline_keyboard: [] });
          } catch (markupError) {
            console.log(
              `[chatbot] deposit_qr_button_clear_failed contact=${contact.id} ` +
              `message_id=${qrMessageId} reason=${markupError.message}`
            );
          }
        }
      }
    }
  }

  // Pre-QR cancel: clear Cancel Deposit on the amount/name prompt message.
  if (!awaitingPayment && callbackMessageId && !messageIds.has(callbackMessageId) && activeBot.telegram.editMessageReplyMarkup) {
    try {
      await activeBot.telegram.editMessageReplyMarkup(chatId, callbackMessageId, undefined, { inline_keyboard: [] });
      console.log(`[chatbot] deposit_cancel_button_cleared contact=${contact.id} message_id=${callbackMessageId}`);
    } catch (error) {
      console.log(
        `[chatbot] deposit_cancel_button_clear_failed contact=${contact.id} ` +
        `message_id=${callbackMessageId} reason=${error.message}`
      );
    }
  }
}

async function reinforceDepositAmountSession(store, contact, decision) {
  const patch = decision?.statePatch || {};
  const step = patch.currentStep === 'deposit_payment_name'
    ? DEPOSIT_BOT_SESSION_STEP_NAME
    : DEPOSIT_BOT_SESSION_STEP_AMOUNT;
  const current = await store.getAutomationState(contact.id).catch(() => null);
  const info = {
    ...(current?.registration_info || {}),
    ...(patch.registrationInfo || {}),
    deposit_in_progress: true,
    deposit_awaiting_payment: false
  };
  await store.updateAutomationState(contact.id, {
    currentFlow: REGISTERED_DEPOSIT_FLOW,
    currentStep: patch.currentStep || 'deposit_amount',
    registrationInfo: info
  }).catch(() => null);

  if (typeof store.resetBotState === 'function') {
    await store.resetBotState(contact.id, { actorName: 'Bot', action: 'deposit' }).catch(() => null);
  }
  if (typeof store.setBotScreen === 'function') {
    await store.setBotScreen(contact.id, 'Deposit', {
      actorName: 'Bot',
      pushCurrent: false,
      workflowKey: DEPOSIT_BOT_SESSION_FLOW,
      workflowStep: step,
      context: {
        payment_name: info.payment_display_name || info.payment_name || null
      }
    }).catch(() => null);
  }

  console.log(
    `[chatbot] deposit_session_reinforced contact=${contact.id} ` +
    `flow=${DEPOSIT_BOT_SESSION_FLOW} step=${step} ` +
    `automation_flow=${REGISTERED_DEPOSIT_FLOW} automation_step=${patch.currentStep || 'deposit_amount'}`
  );
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
