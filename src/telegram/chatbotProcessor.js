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
import { accountViewSnapshotPatch, ACCOUNT_DETAILS_HIDDEN_TEXT, ACCOUNT_SENSITIVE_LOG_TEXT } from './accountView.js';
import { normalizeButtonRows, toTelegramInlineButton } from './messageDelivery.js';
import { buildSupportRequestRecord, sendSupportBotNotification, SUPPORT_DELIVERY_FAILED_TEXT } from './supportNotificationBot.js';
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
  if (flow === 'bot_registration' || flow === 'registration_info' || flow === 'registered_deposit' || flow === 'contact_support') return true;
  const step = String(automationState.current_step || automationState.currentStep || '');
  if (['deposit_payment_name', 'deposit_amount', 'deposit_await_payment', 'waiting_amount', 'waiting_payment_name', 'awaiting_support_inquiry'].includes(step)) return true;
  const info = automationState.registration_info || automationState.registrationInfo || {};
  // Keep amount entry on the deposit bot even if flow was wiped while the prompt was shown.
  if (info.deposit_in_progress || info.deposit_awaiting_payment) return true;
  if (info.support_request_status === 'awaiting_question') return true;
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
    const beforeInfo = beforeState.registration_info || beforeState.registrationInfo || {};
    const pendingDepositStartAmount = Boolean(
      job.job_type === 'inbound_message'
      && !job.action
      && parseMoneyToCents(job.input_text || '') != null
      && String(beforeInfo.payment_display_name || beforeInfo.payment_name || '').trim()
      && typeof store.hasPendingDepositStartJob === 'function'
      && await store.hasPendingDepositStartJob(contact.id).catch(() => false)
    );
    // Amount belongs to deposit when session is active OR Deposit callback is still
    // persisting the session (race: amount arrives before depositActive flips true).
    const depositAmountOwned = depositActive || pendingDepositStartAmount;
    console.log(
      `[chatbot] inbound_lifecycle contact=${contact.id} telegram_id=${contact.telegram_id} ` +
      `update_id=${job.update_id || 'n/a'} telegram_message_id=${job.incoming_telegram_message_id || 'n/a'} ` +
      `text=${JSON.stringify(safeRegistrationLogText(job.input_text, { beforeState }))} ` +
      `action=${job.action || 'none'} job_type=${job.job_type || 'none'} ` +
      `automation_flow=${beforeState.current_flow || 'none'} automation_step=${beforeState.current_step || 'none'} ` +
      `bot_session=${botSession?.workflow_key || 'none'}/${botSession?.workflow_step || 'none'} ` +
      `deposit_active=${depositActive} parsed_amount_cents=${parseMoneyToCents(job.input_text || '') ?? 'invalid'} ` +
      `pending_deposit_start_amount=${pendingDepositStartAmount} deposit_amount_owned=${depositAmountOwned} ` +
      `status=${contact.registration_status}`
    );

    const registrationJob = pendingDepositStartAmount || shouldUseRegistrationBot(job, beforeState, contact, botSession);
    console.log(
      `[chatbot] inbound_router contact=${contact.id} handler=${registrationJob ? 'deposit_or_registration_bot' : 'support_ai'} ` +
      `deposit_active=${depositActive} deposit_amount_owned=${depositAmountOwned}`
    );
    if (!registrationJob) {
      return await processSupportAiJob({ store, contact, job, io, bot, supportAiGenerator });
    }

    const eligibility = await store.isIncomingMessageEligibleForAutoBot(contact.id, {
      telegramMessageId: job.incoming_telegram_message_id,
      jobCreatedAt: job.created_at
    });
    if (!eligibility.eligible) {
      // Owned deposit amount must never be silently dropped by eligibility gates.
      // Includes the race where Deposit callback is still pending and depositActive
      // is not written yet — otherwise the first "5" is Skipped with no reply.
      if (depositAmountOwned) {
        console.log(
          `[chatbot] deposit amount bypassed chatbot eligibility gate ` +
          `jobId=${job.id} contactId=${contact.id} ` +
          `telegramMessageId=${job.incoming_telegram_message_id || 'n/a'} ` +
          `depositActive=${depositActive} pendingDepositStartAmount=${pendingDepositStartAmount} ` +
          `eligibilityReason=${eligibility.reason}`
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
    if (!autoBot.enabled && !depositAmountOwned) {
      await store.completeBotJob(job.id, { status: 'completed', errorText: 'Auto registration bot disabled' });
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${contact.id} job=${job.id}`);
      return { ok: true, skipped: true, reason: 'bot_disabled' };
    }
    if (!autoBot.enabled && depositAmountOwned) {
      console.log(
        `[chatbot] deposit amount bypassed chatbot eligibility gate ` +
        `jobId=${job.id} contactId=${contact.id} ` +
        `telegramMessageId=${job.incoming_telegram_message_id || 'n/a'} ` +
        `depositActive=${depositActive} pendingDepositStartAmount=${pendingDepositStartAmount} ` +
        `eligibilityReason=bot_disabled`
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
      const accountDelivery = await handleAccountViewDecision({
        store,
        contact,
        decision,
        bot: bot || globalThis.telegramBot || null
      });
      if (['show', 'edit', 'hide'].includes(decision.accountView.action) && !accountDelivery?.delivered) {
        throw new Error('Account credentials response was not delivered.');
      }
      accountViewHandled = true;
    }

    if (decision.supportOwnerNotify) {
      const notify = decision.supportOwnerNotify;
      const delivery = await deliverSupportOwnerNotification({
        store,
        contact,
        job,
        notify
      });

      if (delivery.delivered || delivery.alreadySent) {
        decision.replies = [{
          text: notify.playerSuccessText || 'Your support request has been sent.'
        }];
        if (delivery.delivered && (notify.kind === 'support' || notify.kind === 'inquiry')) {
          const currentInfo = (await store.getAutomationState(contact.id).catch(() => null))?.registration_info || {};
          await store.updateAutomationState(contact.id, {
            registrationInfo: {
              ...currentInfo,
              support_request_status: 'sent',
              support_request_error: null,
              support_request_sent_at: new Date().toISOString()
            }
          }).catch(() => null);
        }
      } else {
        const failureText = notify.playerFailureText || SUPPORT_DELIVERY_FAILED_TEXT;
        if (notify.preserveMessageOnFailure || notify.kind === 'support' || notify.kind === 'inquiry') {
          const currentInfo = (await store.getAutomationState(contact.id).catch(() => null))?.registration_info || {};
          await store.updateAutomationState(contact.id, {
            registrationInfo: {
              ...currentInfo,
              support_request_status: 'failed',
              support_request_error: String(
                delivery.error?.code || delivery.error?.message || delivery.reason || 'send_failed'
              ).slice(0, 200)
            }
          }).catch(() => null);
        }
        await queueBotReply({
          store,
          user: contact,
          text: failureText,
          bot: bot || globalThis.telegramBot || null
        });
        const error = delivery.error || new Error(delivery.reason || 'Support notification delivery failed.');
        throw error;
      }
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
        const safeErrorMessage = String(error.message || 'RoyalVIP player creation failed.').slice(0, 500);
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
        ? ACCOUNT_SENSITIVE_LOG_TEXT
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

async function deliverSupportOwnerNotification({ store, contact, job, notify }) {
  const kind = notify?.kind || 'support';
  const fingerprint = String(notify?.fingerprint || kind);
  let supportLock = null;

  if (kind !== 'freeplay' && typeof store.tryAcquireSupportNotifyLock === 'function') {
    supportLock = await store.tryAcquireSupportNotifyLock(contact.id, fingerprint);
    if (!supportLock?.ok) {
      return {
        delivered: false,
        alreadySent: Boolean(supportLock?.alreadySent),
        reason: supportLock?.reason || 'lock_failed'
      };
    }
  }

  try {
    let supportRequest = null;
    if (typeof store.createSupportRequest === 'function') {
      const record = buildSupportRequestRecord({
        kind,
        username: notify.username,
        topic: notify.topic,
        question: notify.question,
        message: notify.message
      });
      supportRequest = await store.createSupportRequest({
        ...record,
        contactId: contact.id,
        sourceJobId: job?.id ?? null,
        fingerprint
      });
    }

    const result = await sendSupportBotNotification({
      store,
      kind,
      text: notify.text,
      request: supportRequest,
      meta: {
        contactId: contact.id,
        jobId: job?.id ?? null,
        updateId: job?.update_id ?? null,
        action: job?.action ?? null,
        topic: notify.topic ?? null
      }
    });

    if (kind === 'freeplay') {
      if (typeof store.commitFreePlayRequest === 'function') {
        await store.commitFreePlayRequest(contact.id, {
          inflightAt: notify.freePlayInflightAt || null
        });
      }
    } else if (supportLock && typeof store.commitSupportNotifyLock === 'function') {
      await store.commitSupportNotifyLock(contact.id, {
        fingerprint,
        inflightAt: supportLock.inflightAt
      });
    }

    return { delivered: true, messageId: result.messageId };
  } catch (error) {
    if (kind === 'freeplay' && typeof store.releaseFreePlaySendLock === 'function') {
      await store.releaseFreePlaySendLock(contact.id, notify.freePlayInflightAt || null).catch(() => null);
    } else if (supportLock && typeof store.releaseSupportNotifyLock === 'function') {
      await store.releaseSupportNotifyLock(contact.id, supportLock.inflightAt).catch(() => null);
    }
    return {
      delivered: false,
      alreadySent: false,
      reason: 'send_failed',
      error
    };
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
  const activeBot = bot || globalThis.telegramBot || null;

  if (view.action === 'edit' || view.action === 'hide') {
    if (!activeBot?.telegram) {
      throw new Error('Telegram bot is required to update account details.');
    }
    const messageId = Number(view.messageId || 0) || null;
    const editText = String(view.text || view.fallbackText || ACCOUNT_DETAILS_HIDDEN_TEXT).trim();
    const buttons = view.buttons || [];
    const normalizedButtons = normalizeButtonRows(buttons);
    const replyMarkup = normalizedButtons.length
      ? { inline_keyboard: normalizedButtons.map((row) => row.map(toTelegramInlineButton)) }
      : { inline_keyboard: [] };

    if (messageId && activeBot.telegram.editMessageText) {
      try {
        await activeBot.telegram.editMessageText(
          contact.telegram_id,
          messageId,
          undefined,
          editText,
          { reply_markup: replyMarkup }
        );
        const state = await store.getAutomationState(contact.id).catch(() => null);
        await store.updateAutomationState(contact.id, {
          registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
            token: view.token,
            messageId,
            hidden: view.mode === 'hidden' || view.action === 'hide',
            mode: view.mode || (view.action === 'hide' ? 'hidden' : null)
          })
        }).catch(() => null);
        return { delivered: true, messageId, action: 'edit', mode: view.mode || null };
      } catch (error) {
        console.log(`[chatbot] account_view_edit_failed contact=${contact.id} message_id=${messageId} reason=${error.message}`);
      }
    }

    // Fall through: send a fresh message if in-place edit is unavailable.
    const sendResult = await queueBotReply({
      store,
      user: contact,
      text: editText,
      buttons: normalizedButtons,
      bot: activeBot,
      storeText: decision.sensitive ? ACCOUNT_SENSITIVE_LOG_TEXT : null
    });
    const sentMessageId = Number(sendResult?.messageId || 0) || null;
    if (sentMessageId) {
      const state = await store.getAutomationState(contact.id).catch(() => null);
      await store.updateAutomationState(contact.id, {
        registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
          token: view.token,
          messageId: sentMessageId,
          hidden: view.mode === 'hidden' || view.action === 'hide',
          mode: view.mode || null
        })
      }).catch(() => null);
    }
    return {
      delivered: Boolean(sendResult?.queued) || Boolean(sentMessageId),
      messageId: sentMessageId,
      action: 'edit_fallback_send',
      mode: view.mode || null
    };
  }

  if (view.action !== 'show') {
    return { delivered: false, reason: 'unsupported_account_view_action' };
  }

  const replyText = String(view.text || decision.replies?.[0]?.text || '').trim();
  if (!replyText) {
    throw new Error('Account credentials decision has no user-visible text.');
  }

  const buttons = view.buttons || decision.replies?.[0]?.buttons || [];
  const previousMessageId = Number(view.previousMessageId || 0) || null;

  // Always send a fresh private message through the standard outbound pipeline.
  // Never edit an older account_view_message_id for the initial open — that looked silent in production.
  // Show Game Passwords / Hide Details edit the active message in place (action=edit above).
  // Never persist/log credential plaintext — storeText redacts durable storage.
  let sendResult;
  try {
    sendResult = await queueBotReply({
      store,
      user: contact,
      text: replyText,
      buttons,
      bot: activeBot,
      storeText: decision.sensitive ? ACCOUNT_SENSITIVE_LOG_TEXT : null
    });
  } catch (error) {
    console.error('[chatbot] account_view_send_failed', {
      contact_id: contact.id,
      stack: error?.stack || String(error)
    });
    throw error;
  }

  const messageId = Number(sendResult?.messageId || 0) || null;
  const deliveredOrQueued = Boolean(sendResult?.queued) || Boolean(messageId);
  if (!deliveredOrQueued) {
    throw new Error('Account credentials response was not delivered or queued.');
  }

  if (previousMessageId && previousMessageId !== messageId && activeBot?.telegram?.deleteMessage) {
    try {
      await activeBot.telegram.deleteMessage(contact.telegram_id, previousMessageId);
    } catch (error) {
      console.log(
        `[chatbot] account_view_previous_cleanup_skipped contact=${contact.id} ` +
        `message_id=${previousMessageId} reason=${error.message}`
      );
    }
  }

  if (messageId) {
    const state = await store.getAutomationState(contact.id).catch(() => null);
    await store.updateAutomationState(contact.id, {
      registrationInfo: accountViewSnapshotPatch(state?.registration_info || {}, {
        token: view.token,
        messageId,
        hidden: false,
        mode: view.mode || 'usernames'
      })
    });
  }

  return {
    delivered: true,
    messageId,
    queued: Boolean(sendResult?.queued),
    action: 'show'
  };
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
