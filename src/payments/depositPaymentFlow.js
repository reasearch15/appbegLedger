import { queueBotReply } from '../telegram/chatbotProcessor.js';
import { registeredMenuButtons } from '../telegram/botRegistrationState.js';
import { formatDepositAmount } from './methodUtils.js';
import { PAYMENT_WINDOW_FLOW } from './constants.js';
import { emitOngoingChanged } from '../ongoing/emit.js';

const DEPOSIT_RECEIVED_MESSAGE = [
  'Payment received and verified!',
  '',
  'Your deposit is being credited to your Royal VIP account.',
  'You will see the updated balance shortly.'
].join('\n');

/**
 * Complete a registered-user deposit after an active deposit window match.
 * Idempotent: safe if the window was already claimed by the router.
 */
export async function continueRegisteredDepositAfterPayment(store, {
  contactId,
  windowId,
  paymentEventId = null,
  actorName = 'PaymentGroupListener',
  bot = null,
  io = null,
  alreadyClaimed = false
} = {}) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Contact not found for deposit payment continuation.');

  const window = await store.getRegistrationPaymentWindow(windowId);
  if (!window) throw new Error('Deposit payment window not found.');
  if (window.flow_type && window.flow_type !== PAYMENT_WINDOW_FLOW.DEPOSIT) {
    throw new Error(`Expected deposit window, got flow_type=${window.flow_type}`);
  }

  if (!alreadyClaimed && paymentEventId != null && typeof store.claimPaymentWindowMatch === 'function') {
    const claimed = await store.claimPaymentWindowMatch(windowId, paymentEventId);
    if (!claimed.ok && claimed.reason !== 'already_matched') {
      console.log(`[payment-router] deposit_window_claim_skipped contact=${contactId} window=${windowId} reason=${claimed.reason}`);
    }
  } else if (!alreadyClaimed) {
    await store.completeRegistrationPaymentWindow(windowId, { paymentEventId });
  }

  const automation = await store.getAutomationState(contactId);
  const info = {
    ...(automation?.registration_info || {}),
    last_deposit_confirmed: true,
    last_deposit_confirmed_at: new Date().toISOString(),
    last_deposit_amount: window.first_deposit_amount,
    last_deposit_window_id: windowId,
    last_deposit_payment_event_id: paymentEventId,
    deposit_awaiting_payment: false
  };

  // Clear temporary deposit wizard state; keep payment display name for next time.
  delete info.deposit_in_progress;
  delete info.deposit_requested_amount;
  delete info.deposit_payment_window_id;

  await store.updateRegistrationInfo(contactId, info, actorName);
  await store.updateAutomationState(contactId, {
    currentFlow: null,
    currentStep: null,
    registrationInfo: info
  });

  await store.logEvent({
    telegramUserId: contactId,
    eventType: 'deposit_confirmed_after_payment_match',
    title: 'Deposit Confirmed After Payment Match',
    body: `Deposit window matched. Amount ${formatDepositAmount(window.first_deposit_amount)}.`,
    actorName,
    metadata: {
      windowId,
      paymentEventId,
      amount: window.first_deposit_amount,
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
    }
  });

  // Existing AppBeg credit integration hook (no separate auto-credit API in-repo).
  if (typeof store.creditRegisteredDeposit === 'function') {
    await store.creditRegisteredDeposit({
      contactId,
      amount: window.first_deposit_amount,
      paymentEventId,
      windowId,
      actorName,
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT
    });
  }

  const autoBot = await store.getAutoRegistrationBotSettings?.() || { enabled: true };
  if (autoBot.enabled !== false) {
    await queueBotReply({
      store,
      user: contact,
      text: [
        DEPOSIT_RECEIVED_MESSAGE,
        '',
        `Amount: $${formatDepositAmount(window.first_deposit_amount)}`
      ].join('\n'),
      buttons: registeredMenuButtons(),
      bot: bot || globalThis.telegramBot || null
    });
  }

  console.log(`[payment-router] deposit_continued_after_payment_match contact=${contactId} window=${windowId}`);

  if (paymentEventId) {
    await store.logPaymentRouting(paymentEventId, 'deposit_continued_after_payment_match', 'Registered deposit confirmed after payment window match.', {
      contactId,
      windowId,
      amount: window.first_deposit_amount
    });
    if (typeof store.updatePaymentRouting === 'function') {
      await store.updatePaymentRouting(paymentEventId, { processing_status: 'Completed' });
    }
  }

  if (io) {
    io.emit('contacts:changed');
    io.emit('contact:changed', { contactId, userId: contactId });
    io.emit('payments:changed');
    emitOngoingChanged(io, { reason: 'deposit_matched', contactId, windowId });
  }

  return { contact, window };
}
