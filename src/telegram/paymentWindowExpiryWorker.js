import { queueBotReply } from './chatbotProcessor.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { registeredMenuButtons } from './botRegistrationState.js';

export const REGISTRATION_PAYMENT_EXPIRY_MESSAGE = [
  'Registration failed.',
  '',
  'We did not receive your payment within the 7-minute payment window.',
  '',
  'Press Register to start again.'
].join('\n');

export const DEPOSIT_PAYMENT_EXPIRY_MESSAGE = [
  'Your deposit request expired because no matching payment was received within 7 minutes.',
  '',
  'Press Deposit to try again.'
].join('\n');

export const REGISTRATION_PAYMENT_EXPIRY_BUTTONS = [
  [{ label: '👑 Register', action: 'menu:register', text: 'Register', data: 'menu:register' }]
];

export const DEPOSIT_PAYMENT_EXPIRY_BUTTONS = [
  [{ label: '💰 Deposit', action: 'menu:deposit', text: 'Deposit', data: 'menu:deposit' }],
  ...registeredMenuButtons().slice(1)
];

export async function processPaymentWindowExpiryTick({
  store,
  io = null,
  sendExpiryMessage = queueBotReply
}) {
  const windows = await store.listRegistrationPaymentWindowsForExpiryWorker();
  let expiredCount = 0;
  let notifiedCount = 0;

  for (const window of windows) {
    if (window.status === 'completed' || window.status === 'matched') continue;

    const expired = await store.expireRegistrationPaymentWindowIfDue(window.id);
    if (expired) {
      expiredCount += 1;
      console.log(
        `[chatbot] payment_window_expired contact=${window.contact_id} window=${window.id} ` +
        `flow=${window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION}`
      );
    }

    const claimed = await store.claimRegistrationPaymentWindowExpiryNotification(window.id);
    if (!claimed) continue;

    const contact = await store.getUserProfile(window.contact_id);
    if (!contact) continue;

    const flowType = window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION;
    const isDeposit = flowType === PAYMENT_WINDOW_FLOW.DEPOSIT;
    const automationState = await store.getAutomationState(window.contact_id);

    if (!isDeposit && automationState?.current_flow === 'bot_registration') {
      await store.resetRegistrationFlowToIdle(window.contact_id, 'PaymentWindowExpiry');
      console.log(`[chatbot] registration_cancelled_due_to_timeout contact=${window.contact_id} window=${window.id}`);
    }

    if (isDeposit) {
      await store.updateAutomationState(window.contact_id, {
        currentFlow: null,
        currentStep: null,
        registrationInfo: {
          ...(automationState?.registration_info || {}),
          deposit_in_progress: false,
          deposit_awaiting_payment: false,
          deposit_requested_amount: undefined,
          deposit_payment_window_id: undefined
        }
      }).catch(() => null);
      console.log(`[chatbot] deposit_cancelled_due_to_timeout contact=${window.contact_id} window=${window.id}`);
    }

    const autoBot = await store.getAutoRegistrationBotSettings();
    if (!autoBot.enabled) {
      console.log(`[chatbot] auto_reply_skipped_bot_disabled contact=${window.contact_id} window=${window.id} reason=payment_window_expiry`);
      notifiedCount += 1;
      continue;
    }

    await sendExpiryMessage({
      store,
      user: contact,
      text: isDeposit ? DEPOSIT_PAYMENT_EXPIRY_MESSAGE : REGISTRATION_PAYMENT_EXPIRY_MESSAGE,
      buttons: isDeposit ? DEPOSIT_PAYMENT_EXPIRY_BUTTONS : REGISTRATION_PAYMENT_EXPIRY_BUTTONS,
      bot: globalThis.telegramBot || null
    });
    notifiedCount += 1;
    console.log(`[chatbot] expiry_notification_sent contact=${window.contact_id} window=${window.id} flow=${flowType}`);

    if (io) {
      io.emit('message:new', { userId: contact.id, contactId: contact.id, telegramId: contact.telegram_id });
      io.emit('contacts:changed');
      io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    }
  }

  return { checked: windows.length, expired: expiredCount, notified: notifiedCount };
}

export function startPaymentWindowExpiryWorker({ store, io, pollMs = Number(process.env.PAYMENT_WINDOW_EXPIRY_POLL_MS || 30000) } = {}) {
  const enabled = process.env.PAYMENT_WINDOW_EXPIRY_ENABLED !== 'false';
  if (!enabled) {
    console.log('[chatbot] payment window expiry worker disabled (PAYMENT_WINDOW_EXPIRY_ENABLED=false)');
    return { stop: async () => {} };
  }

  let stopped = false;
  let tickPromise = null;

  console.log(`[chatbot] payment_window_expiry_worker_started poll_ms=${pollMs}`);

  async function tick() {
    if (stopped) return;
    try {
      await processPaymentWindowExpiryTick({ store, io });
    } catch (error) {
      console.error('[chatbot] payment window expiry worker tick failed:', error);
    }
  }

  const timer = setInterval(() => {
    if (tickPromise) return;
    tickPromise = tick().finally(() => {
      tickPromise = null;
    });
  }, pollMs);

  tickPromise = tick().finally(() => {
    tickPromise = null;
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (tickPromise) await tickPromise;
      console.log('[chatbot] payment window expiry worker stopped');
    }
  };
}
