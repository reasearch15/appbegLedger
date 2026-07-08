import { queueBotReply } from './chatbotProcessor.js';

export const REGISTRATION_PAYMENT_EXPIRY_MESSAGE = [
  'Your 5-minute payment window has expired.',
  '',
  'Please type Register to start again.'
].join('\n');

const PAYMENT_WAIT_STEPS = new Set(['await_payment_done', 'first_deposit_amount']);

export async function processPaymentWindowExpiryTick({
  store,
  io = null,
  sendExpiryMessage = queueBotReply
}) {
  const dueWindows = await store.listDueRegistrationPaymentWindows();
  let expiredCount = 0;

  for (const window of dueWindows) {
    const expired = await store.expireRegistrationPaymentWindowIfDue(window.id);
    if (!expired) continue;

    expiredCount += 1;
    console.log(`[chatbot] payment_window_expired contact=${window.contact_id} window=${window.id}`);

    const contact = await store.getUserProfile(window.contact_id);
    if (!contact) continue;

    const automationState = await store.getAutomationState(window.contact_id);
    const shouldResetFlow = automationState?.current_flow === 'bot_registration'
      && PAYMENT_WAIT_STEPS.has(automationState?.current_step);

    if (shouldResetFlow) {
      await store.resetRegistrationFlowToIdle(window.contact_id, 'PaymentWindowExpiry');
      console.log(`[chatbot] registration_flow_auto_stopped contact=${window.contact_id} window=${window.id}`);
    }

    await sendExpiryMessage({
      store,
      user: contact,
      text: REGISTRATION_PAYMENT_EXPIRY_MESSAGE,
      bot: globalThis.telegramBot || null
    });
    console.log(`[chatbot] expiry_message_queued contact=${window.contact_id} window=${window.id}`);

    if (io) {
      io.emit('message:new', { userId: contact.id, contactId: contact.id, telegramId: contact.telegram_id });
      io.emit('contacts:changed');
      io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    }
  }

  return { checked: dueWindows.length, expired: expiredCount };
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
