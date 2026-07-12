import {
  paymentQrCaption,
  REGISTRATION_QR_LOAD_FAILED_MESSAGE,
  resolvePaymentQrTelegramInput
} from '../payments/methodUtils.js';
import { paymentQrRetryButtons, waitingPaymentCancelButtons } from './botRegistrationState.js';
import { queueBotPhotoReply, queueBotReply } from './chatbotProcessorDelivery.js';

async function recoverRegistrationQrFailure({
  store,
  contact,
  sendPaymentQr,
  bot,
  reason,
  logAsSendFailed = true
}) {
  const safeReason = String(reason || 'unknown').slice(0, 200);
  if (logAsSendFailed) {
    console.log(
      `[chatbot] registration_qr_send_failed contact=${contact.id} ` +
      `payment_method_id=${sendPaymentQr.paymentMethodId || 'n/a'} ` +
      `amount=${sendPaymentQr.firstDepositAmount ?? 'n/a'} reason=${safeReason}`
    );
  }

  await store.updateAutomationState(contact.id, {
    currentStep: 'first_deposit_amount'
  }).catch(() => null);

  const activeWindow = await store.getActiveRegistrationPaymentWindow?.(contact.id).catch(() => null);
  if (!activeWindow && store.updateRegistrationStatus) {
    if (contact.registration_status === 'Waiting For Payment') {
      await store.updateRegistrationStatus(contact.id, 'Collecting Info', 'Chatbot').catch(() => null);
    }
  }

  await queueBotReply({
    store,
    user: contact,
    text: REGISTRATION_QR_LOAD_FAILED_MESSAGE,
    buttons: paymentQrRetryButtons(),
    bot: bot || globalThis.telegramBot || null
  });
}

/**
 * Send registration QR photo, then open the 5-minute payment window.
 * Order is intentional: QR must succeed before Waiting For Payment.
 */
export async function handlePaymentRegistrationQr({ store, contact, sendPaymentQr, bot }) {
  const contactId = contact.id;
  const paymentMethodId = sendPaymentQr.paymentMethodId;
  const amount = sendPaymentQr.firstDepositAmount;

  console.log(
    `[chatbot] registration_qr_lookup_started contact=${contactId} ` +
    `payment_method_id=${paymentMethodId || 'n/a'} amount=${amount ?? 'n/a'}`
  );

  const qr = typeof store.getActivePaymentQrForRegistration === 'function'
    ? await store.getActivePaymentQrForRegistration(paymentMethodId)
    : await store.getActiveDefaultPaymentQr(paymentMethodId);

  if (!qr?.file_path) {
    console.log(
      `[chatbot] registration_qr_missing contact=${contactId} ` +
      `payment_method_id=${paymentMethodId || 'n/a'} amount=${amount ?? 'n/a'}`
    );
    await recoverRegistrationQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: 'qr_missing',
      logAsSendFailed: false
    });
    return { ok: false, reason: 'qr_missing' };
  }

  console.log(
    `[chatbot] registration_qr_found contact=${contactId} ` +
    `payment_method_id=${paymentMethodId} qr_id=${qr.id} amount=${amount ?? 'n/a'}`
  );

  const resolved = resolvePaymentQrTelegramInput(qr.file_path);
  if (!resolved.ok) {
    await recoverRegistrationQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: resolved.reason || 'file_unresolved'
    });
    return { ok: false, reason: resolved.reason || 'file_unresolved' };
  }

  const caption = paymentQrCaption({
    paymentMethodName: sendPaymentQr.paymentMethodName,
    firstDepositAmount: amount,
    paymentDisplayName: sendPaymentQr.paymentDisplayName
  });

  console.log(
    `[chatbot] registration_qr_send_started contact=${contactId} ` +
    `payment_method_id=${paymentMethodId} qr_id=${qr.id} amount=${amount ?? 'n/a'}`
  );

  let photoResult;
  try {
    photoResult = await queueBotPhotoReply({
      store,
      user: contact,
      text: caption,
      mediaPath: resolved.mediaPath,
      buttons: waitingPaymentCancelButtons(),
      bot: bot || globalThis.telegramBot || null
    });
  } catch (error) {
    await recoverRegistrationQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: error?.message || 'send_failed'
    });
    return { ok: false, reason: 'send_failed' };
  }

  console.log(
    `[chatbot] registration_qr_send_succeeded contact=${contactId} ` +
    `payment_method_id=${paymentMethodId} qr_id=${qr.id} ` +
    `message_id=${photoResult?.messageId || 'n/a'} amount=${amount ?? 'n/a'}`
  );

  let paymentWindow = await store.getActiveRegistrationPaymentWindow?.(contactId).catch(() => null);
  let windowCreated = false;
  if (!paymentWindow) {
    paymentWindow = await store.createRegistrationPaymentWindow({
      contactId,
      telegramUserId: contact.telegram_id,
      paymentMethodId,
      paymentQrCodeId: qr.id,
      paymentDisplayName: sendPaymentQr.paymentDisplayName,
      firstDepositAmount: amount,
      windowMinutes: 5
    });
    windowCreated = true;
    console.log(
      `[chatbot] registration_payment_window_created contact=${contactId} ` +
      `window=${paymentWindow.id} payment_method_id=${paymentMethodId} ` +
      `qr_id=${qr.id} amount=${amount ?? 'n/a'} expires_at=${paymentWindow.expires_at}`
    );
  } else {
    console.log(
      `[chatbot] registration_payment_window_reused contact=${contactId} ` +
      `window=${paymentWindow.id} payment_method_id=${paymentMethodId} qr_id=${qr.id}`
    );
  }

  const currentInfo = (await store.getAutomationState(contactId))?.registration_info || {};
  await store.updateAutomationState(contactId, {
    currentStep: 'await_payment',
    registrationInfo: {
      ...currentInfo,
      payment_qr_code_id: qr.id,
      payment_window_id: paymentWindow.id,
      payment_qr_telegram_message_id: photoResult?.messageId || null,
      payment_window_expires_at: paymentWindow.expires_at
    }
  });

  if (store.updateRegistrationStatus) {
    await store.updateRegistrationStatus(contactId, 'Waiting For Payment', 'Chatbot').catch(() => null);
  }

  console.log(
    `[chatbot] registration_payment_window_started contact=${contactId} ` +
    `window=${paymentWindow.id} expires_at=${paymentWindow.expires_at} created=${windowCreated}`
  );

  return {
    ok: true,
    windowCreated,
    paymentWindow,
    qr,
    messageId: photoResult?.messageId || null,
    caption
  };
}
