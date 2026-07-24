export function configuredPaymentGroupChatId() {
  const value = process.env.PAYMENT_TELEGRAM_GROUP || process.env.PAYMENT_GROUP_CHAT_ID || null;
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

/** True when chatId matches the configured payment source group (PAYMENT_TELEGRAM_GROUP / PAYMENT_GROUP_CHAT_ID). */
export function isConfiguredPaymentSourceChat(chatId) {
  const configured = configuredPaymentGroupChatId();
  if (configured == null) return false;
  return String(chatId) === configured;
}

export const listenerRoles = {
  chatAccount: {
    key: 'CHAT_TELEGRAM_ACCOUNT',
    value: 'disabled',
    description: 'Personal Telegram private-chat sync is disabled. User contacts are created only through the official Bot API.'
  },
  paymentGroup: {
    key: 'PAYMENT_TELEGRAM_GROUP',
    value: process.env.PAYMENT_GROUP_LISTENER || 'payment_telegram_group',
    chatId: configuredPaymentGroupChatId(),
    description: 'Separate payment confirmation group listener using PAYMENT_TELEGRAM_SESSION.'
  }
};
