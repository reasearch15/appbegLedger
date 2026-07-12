import {
  paymentQrCaption,
  REGISTRATION_QR_LOAD_FAILED_MESSAGE,
  resolvePaymentQrTelegramInput
} from '../payments/methodUtils.js';
import { PAYMENT_WINDOW_FLOW, paymentWindowMinutes } from '../payments/constants.js';
import { paymentQrRetryButtons, registeredMenuButtons, waitingPaymentCancelButtons } from './botRegistrationState.js';
import { queueBotPhotoReply, queueBotReply } from './chatbotProcessorDelivery.js';

async function recoverQrFailure({
  store,
  contact,
  sendPaymentQr,
  bot,
  reason,
  logAsSendFailed = true,
  recoverStep = 'first_deposit_amount',
  buttons = paymentQrRetryButtons()
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
    currentStep: recoverStep
  }).catch(() => null);

  const flowType = sendPaymentQr.flowType || PAYMENT_WINDOW_FLOW.REGISTRATION;
  const activeWindow = await store.getActiveRegistrationPaymentWindow?.(contact.id, { flowType }).catch(() => null);
  if (!activeWindow && store.updateRegistrationStatus && flowType === PAYMENT_WINDOW_FLOW.REGISTRATION) {
    if (contact.registration_status === 'Waiting For Payment') {
      await store.updateRegistrationStatus(contact.id, 'Collecting Info', 'Chatbot').catch(() => null);
    }
  }

  await queueBotReply({
    store,
    user: contact,
    text: REGISTRATION_QR_LOAD_FAILED_MESSAGE,
    buttons,
    bot: bot || globalThis.telegramBot || null
  });
}

/**
 * Send QR photo, then open the 7-minute payment window.
 * Order is intentional: QR must succeed before waiting / timer start.
 */
export async function handlePaymentRegistrationQr({ store, contact, sendPaymentQr, bot }) {
  const contactId = contact.id;
  const paymentMethodId = sendPaymentQr.paymentMethodId;
  const amount = sendPaymentQr.firstDepositAmount;
  const flowType = sendPaymentQr.flowType === PAYMENT_WINDOW_FLOW.DEPOSIT
    ? PAYMENT_WINDOW_FLOW.DEPOSIT
    : PAYMENT_WINDOW_FLOW.REGISTRATION;
  const isDeposit = flowType === PAYMENT_WINDOW_FLOW.DEPOSIT;
  const recoverStep = isDeposit ? 'deposit_amount' : 'first_deposit_amount';
  const waitingStep = isDeposit ? 'deposit_await_payment' : 'await_payment';
  const cancelButtons = isDeposit
    ? [[{ label: '❌ Cancel Deposit', action: 'deposit:cancel', text: 'Cancel Deposit', data: 'deposit:cancel' }]]
    : waitingPaymentCancelButtons();
  const failureButtons = isDeposit
    ? [
      [{ label: '🔄 Try Again', action: 'deposit:retry_qr', text: 'Try Again', data: 'deposit:retry_qr' }],
      ...registeredMenuButtons()
    ]
    : paymentQrRetryButtons();

  console.log(
    `[chatbot] registration_qr_lookup_started contact=${contactId} ` +
    `payment_method_id=${paymentMethodId || 'n/a'} amount=${amount ?? 'n/a'} flow=${flowType}`
  );

  const qr = typeof store.getActivePaymentQrForRegistration === 'function'
    ? await store.getActivePaymentQrForRegistration(paymentMethodId)
    : await store.getActiveDefaultPaymentQr(paymentMethodId);

  if (!qr?.file_path) {
    console.log(
      `[chatbot] registration_qr_missing contact=${contactId} ` +
      `payment_method_id=${paymentMethodId || 'n/a'} amount=${amount ?? 'n/a'}`
    );
    await recoverQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: 'qr_missing',
      logAsSendFailed: false,
      recoverStep,
      buttons: failureButtons
    });
    return { ok: false, reason: 'qr_missing' };
  }

  console.log(
    `[chatbot] registration_qr_found contact=${contactId} ` +
    `payment_method_id=${paymentMethodId} qr_id=${qr.id} amount=${amount ?? 'n/a'}`
  );

  const resolved = resolvePaymentQrTelegramInput(qr.file_path);
  if (!resolved.ok) {
    await recoverQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: resolved.reason || 'file_unresolved',
      recoverStep,
      buttons: failureButtons
    });
    return { ok: false, reason: resolved.reason || 'file_unresolved' };
  }

  const caption = paymentQrCaption({
    paymentMethodName: sendPaymentQr.paymentMethodName,
    firstDepositAmount: amount,
    paymentDisplayName: sendPaymentQr.paymentDisplayName,
    flowType
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
      buttons: cancelButtons,
      bot: bot || globalThis.telegramBot || null
    });
  } catch (error) {
    await recoverQrFailure({
      store,
      contact,
      sendPaymentQr,
      bot,
      reason: error?.message || 'send_failed',
      recoverStep,
      buttons: failureButtons
    });
    return { ok: false, reason: 'send_failed' };
  }

  console.log(
    `[chatbot] registration_qr_send_succeeded contact=${contactId} ` +
    `payment_method_id=${paymentMethodId} qr_id=${qr.id} ` +
    `message_id=${photoResult?.messageId || 'n/a'} amount=${amount ?? 'n/a'}`
  );

  let paymentWindow = await store.getActiveRegistrationPaymentWindow?.(contactId, { flowType }).catch(() => null);
  let windowCreated = false;
  if (!paymentWindow) {
    paymentWindow = await store.createRegistrationPaymentWindow({
      contactId,
      telegramUserId: contact.telegram_id,
      paymentMethodId,
      paymentQrCodeId: qr.id,
      paymentDisplayName: sendPaymentQr.paymentDisplayName,
      firstDepositAmount: amount,
      flowType,
      windowMinutes: paymentWindowMinutes()
    });
    windowCreated = true;
    console.log(
      `[chatbot] registration_payment_window_created contact=${contactId} ` +
      `window=${paymentWindow.id} payment_method_id=${paymentMethodId} ` +
      `qr_id=${qr.id} amount=${amount ?? 'n/a'} flow=${flowType} expires_at=${paymentWindow.expires_at}`
    );
  } else {
    console.log(
      `[chatbot] registration_payment_window_reused contact=${contactId} ` +
      `window=${paymentWindow.id} payment_method_id=${paymentMethodId} qr_id=${qr.id} flow=${flowType}`
    );
  }

  const currentInfo = (await store.getAutomationState(contactId))?.registration_info || {};
  await store.updateAutomationState(contactId, {
    currentFlow: isDeposit ? 'registered_deposit' : 'bot_registration',
    currentStep: waitingStep,
    registrationInfo: {
      ...currentInfo,
      payment_qr_code_id: qr.id,
      payment_window_id: paymentWindow.id,
      payment_qr_telegram_message_id: photoResult?.messageId || null,
      payment_window_expires_at: paymentWindow.expires_at,
      ...(isDeposit
        ? {
          deposit_in_progress: true,
          deposit_awaiting_payment: true,
          deposit_requested_amount: amount,
          deposit_payment_window_id: paymentWindow.id
        }
        : {})
    }
  });

  if (!isDeposit && store.updateRegistrationStatus) {
    await store.updateRegistrationStatus(contactId, 'Waiting For Payment', 'Chatbot').catch(() => null);
  }

  console.log(
    `[chatbot] registration_payment_window_started contact=${contactId} ` +
    `window=${paymentWindow.id} expires_at=${paymentWindow.expires_at} created=${windowCreated} flow=${flowType}`
  );

  return {
    ok: true,
    windowCreated,
    paymentWindow,
    qr,
    messageId: photoResult?.messageId || null,
    caption,
    flowType
  };
}
