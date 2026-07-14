import { queueBotReply } from '../telegram/chatbotProcessor.js';
import {
  APPBEG_USERNAME_HELP,
  validateAppBegUsername
} from '../registration/appbegValidation.js';
import { emitOngoingChanged } from '../ongoing/emit.js';

const USERNAME_PROMPT = [
  'Payment received and verified!',
  '',
  'Now choose your Royal VIP username.',
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
  alreadyClaimed = false
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
  const info = {
    ...(automation?.registration_info || {}),
    payment_confirmed: true,
    payment_confirmed_at: new Date().toISOString(),
    payment_confirmed_by: 'payment_group_listener',
    registration_payment_window_id: windowId
  };

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

  await queueBotReply({
    store,
    user: contact,
    text: USERNAME_PROMPT,
    bot: bot || globalThis.telegramBot || null
  });

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
