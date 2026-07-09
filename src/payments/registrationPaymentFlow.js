import { queueBotReply } from '../telegram/chatbotProcessor.js';

const USERNAME_PROMPT = 'Thanks! We confirmed your payment. What username would you like for your account?';

export async function continueBotRegistrationAfterPayment(store, {
  contactId,
  windowId,
  paymentEventId = null,
  actorName = 'PaymentGroupListener',
  bot = null
}) {
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('Contact not found for registration payment continuation.');

  const window = await store.getRegistrationPaymentWindow(windowId);
  if (!window) throw new Error('Registration payment window not found.');

  await store.completeRegistrationPaymentWindow(windowId);

  const automation = await store.getAutomationState(contactId);
  const info = {
    ...(automation?.registration_info || {}),
    payment_confirmed: true,
    payment_confirmed_at: new Date().toISOString(),
    payment_confirmed_by: 'payment_group_listener',
    registration_payment_window_id: windowId
  };

  await store.updateRegistrationInfo(contactId, info, actorName);
  await store.updateAutomationState(contactId, {
    currentFlow: 'bot_registration',
    currentStep: 'username',
    registrationInfo: info
  });

  await store.logEvent({
    telegramUserId: contactId,
    eventType: 'payment_window_completed_from_group_message',
    title: 'Registration Payment Window Completed',
    body: 'Payment group message matched and completed the registration payment window.',
    actorName,
    metadata: {
      windowId,
      paymentEventId
    }
  });

  await queueBotReply({
    store,
    user: contact,
    text: USERNAME_PROMPT,
    bot: bot || globalThis.telegramBot || null
  });

  console.log(`[payment-router] bot_registration_continued_after_payment contact=${contactId} window=${windowId}`);

  if (paymentEventId) {
    await store.logPaymentRouting(paymentEventId, 'bot_registration_continued_after_payment', 'Bot registration advanced to username after payment confirmation.', {
      contactId,
      windowId
    });
  }

  return { contact, window };
}
