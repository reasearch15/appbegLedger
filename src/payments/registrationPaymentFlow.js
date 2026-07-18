import { queueBotReply } from '../telegram/chatbotProcessor.js';
import {
  APPBEG_USERNAME_HELP,
  validateAppBegUsername
} from '../registration/appbegValidation.js';
import { emitOngoingChanged } from '../ongoing/emit.js';

const USERNAME_PROMPT = [
  'Payment confirmed. What Royal VIP username would you like to create?',
  '',
  'Example:',
  'JohnVIP01',
  '',
  APPBEG_USERNAME_HELP
].join('\n');

export async function continueBotRegistrationAfterPayment(store, {
  contactId,
  windowId,
  paymentEventId = null,
  actorName = 'PaymentGroupListener',
  bot = null,
  io = null,
  alreadyClaimed = false,
  matchingMethod = null
}) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Contact not found for registration payment continuation.');

  const window = await store.getRegistrationPaymentWindow(windowId);
  if (!window) throw new Error('Registration payment window not found.');

  if (!alreadyClaimed && paymentEventId != null && typeof store.claimPaymentWindowMatch === 'function') {
    await store.claimPaymentWindowMatch(windowId, paymentEventId);
  } else if (!alreadyClaimed) {
    await store.completeRegistrationPaymentWindow(windowId, { paymentEventId });
  }

  const automation = await store.getAutomationState(contactId);
  const previousInfo = automation?.registration_info || {};
  const confirmedAt = previousInfo.payment_confirmed_at || new Date().toISOString();
  const depositAmount = Number(window.first_deposit_amount);
  const info = {
    ...previousInfo,
    payment_confirmed: true,
    payment_confirmed_at: confirmedAt,
    payment_confirmed_by: 'payment_group_listener',
    matched_payment_event_id: paymentEventId,
    registration_payment_event_id: paymentEventId,
    registration_payment_window_id: windowId,
    confirmed_deposit_amount: Number.isFinite(depositAmount) ? depositAmount : previousInfo.confirmed_deposit_amount
  };

  console.log('[payment-router] registration_payment_matched', JSON.stringify({
    contactId,
    windowId,
    paymentEventId,
    matchingMethod,
    currentPhase: automation?.current_step || null,
    nextPhase: 'username'
  }));
  if (paymentEventId) {
    await store.logPaymentRouting(paymentEventId, 'registration_payment_continuation_started', 'Registration payment matched; starting bot continuation.', {
      contactId,
      windowId,
      matchingMethod,
      currentPhase: automation?.current_step || null,
      nextPhase: 'username'
    });
  }

  await store.updateRegistrationInfo(contactId, info, actorName);

  const autoBot = await store.getAutoRegistrationBotSettings();
  if (!autoBot.enabled) {
    console.log(`[payment-router] registration_continued_after_payment_match skipped reason=auto_registration_bot_disabled contact=${contactId} window=${windowId}`);
    if (paymentEventId) {
      await store.logPaymentRouting(paymentEventId, 'registration_payment_matched_bot_paused', 'Payment matched but auto registration bot is disabled; no automatic reply sent.', {
        contactId,
        windowId
      });
    }
    if (io) {
      io.emit('contacts:changed');
      io.emit('contact:changed', { contactId, userId: contactId });
      emitOngoingChanged(io, { reason: 'registration_matched', contactId, windowId });
    }
    return { contact, window, botSkipped: true };
  }

  await store.updateAutomationState(contactId, {
    currentFlow: 'bot_registration',
    currentStep: 'username',
    registrationInfo: info
  });
  console.log('[payment-router] registration_session_phase_updated', JSON.stringify({
    contactId,
    windowId,
    paymentEventId,
    matchingMethod,
    currentPhase: automation?.current_step || null,
    nextPhase: 'username'
  }));
  if (paymentEventId) {
    await store.logPaymentRouting(paymentEventId, 'registration_session_phase_updated', 'Registration session advanced after payment confirmation.', {
      contactId,
      windowId,
      matchingMethod,
      currentPhase: automation?.current_step || null,
      nextPhase: 'username'
    });
  }
  if (store.updateRegistrationStatus) {
    await store.updateRegistrationStatus(contactId, 'Collecting Info', actorName).catch(() => null);
  }

  await store.logEvent({
    telegramUserId: contactId,
    eventType: 'registration_continued_after_payment_match',
    title: 'Registration Continued After Payment Match',
    body: 'Payment group listener confirmed payment and advanced registration to username.',
    actorName,
    metadata: { windowId, paymentEventId }
  });

  const alreadyPrompted = Boolean(previousInfo.post_payment_username_prompted_at);
  if (!alreadyPrompted) {
    try {
      await queueBotReply({
        store,
        user: contact,
        text: USERNAME_PROMPT,
        bot: bot || globalThis.telegramBot || null
      });
      const promptedAt = new Date().toISOString();
      await store.updateRegistrationInfo(contactId, {
        post_payment_username_prompted_at: promptedAt
      }, actorName);
      console.log('[payment-router] registration_username_prompt_sent', JSON.stringify({
        contactId,
        windowId,
        paymentEventId,
        matchingMethod,
        nextPhase: 'username'
      }));
      if (paymentEventId) {
        await store.logPaymentRouting(paymentEventId, 'registration_username_prompt_sent', 'Royal VIP username prompt sent after payment confirmation.', {
          contactId,
          windowId,
          matchingMethod,
          nextPhase: 'username'
        });
      }
    } catch (error) {
      console.log('[payment-router] registration_continuation_failure', JSON.stringify({
        contactId,
        windowId,
        paymentEventId,
        matchingMethod,
        phase: 'username',
        error: error.message
      }));
      if (paymentEventId) {
        await store.logPaymentRouting(paymentEventId, 'registration_continuation_failure', 'Registration session was advanced, but the username prompt could not be sent.', {
          contactId,
          windowId,
          matchingMethod,
          phase: 'username',
          error: error.message
        }, 'warn');
      }
      return { contact, window, messageFailed: true };
    }
  } else {
    console.log('[payment-router] registration_username_prompt_duplicate_skipped', JSON.stringify({
      contactId,
      windowId,
      paymentEventId,
      matchingMethod,
      nextPhase: 'username'
    }));
  }

  console.log(`[payment-router] registration_continued_after_payment_match contact=${contactId} window=${windowId}`);

  if (paymentEventId) {
    await store.logPaymentRouting(paymentEventId, 'registration_continued_after_payment_match', 'Bot registration advanced to username after payment confirmation.', {
      contactId,
      windowId
    });
  }

  if (io) {
    io.emit('contacts:changed');
    io.emit('contact:changed', { contactId, userId: contactId });
    emitOngoingChanged(io, { reason: 'registration_matched', contactId, windowId });
  }

  return { contact, window };
}

export function paymentConfirmedRegistrationStep(automationState = {}) {
  const info = automationState?.registration_info || {};
  if (!info.payment_confirmed) return 'await_payment';
  return automationState?.current_step || 'username';
}

export { validateAppBegUsername };
