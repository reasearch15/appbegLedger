import { queueBotReply } from './chatbotProcessor.js';

export const REGISTRATION_PAYMENT_EXPIRY_MESSAGE = [
  '⏰ Your payment confirmation window has expired.',
  '',
  'Your registration has been cancelled for your security.',
  '',
  'Please type **Register** to start the registration process again.'
].join('\n');

export async function processPaymentWindowExpiryTick({
  store,
  io = null,
  sendExpiryMessage = queueBotReply
}) {
  const windows = await store.listRegistrationPaymentWindowsForExpiryWorker();
  let expiredCount = 0;
  let notifiedCount = 0;

  for (const window of windows) {
    if (window.status === 'completed') continue;

    const expired = await store.expireRegistrationPaymentWindowIfDue(window.id);
    if (expired) {
      expiredCount += 1;
      console.log(`[chatbot] payment_window_expired contact=${window.contact_id} window=${window.id}`);
    }

    const claimed = await store.claimRegistrationPaymentWindowExpiryNotification(window.id);
    if (!claimed) continue;

    const contact = await store.getUserProfile(window.contact_id);
    if (!contact) continue;

    const automationState = await store.getAutomationState(window.contact_id);
    if (automationState?.current_flow === 'bot_registration') {
      await store.resetRegistrationFlowToIdle(window.contact_id, 'PaymentWindowExpiry');
      console.log(`[chatbot] registration_cancelled_due_to_timeout contact=${window.contact_id} window=${window.id}`);
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
      text: REGISTRATION_PAYMENT_EXPIRY_MESSAGE,
      bot: globalThis.telegramBot || null
    });
    notifiedCount += 1;
    console.log(`[chatbot] expiry_notification_sent contact=${window.contact_id} window=${window.id}`);

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
