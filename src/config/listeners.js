export const listenerRoles = {
  chatAccount: {
    key: 'CHAT_TELEGRAM_ACCOUNT',
    value: 'disabled',
    description: 'Personal Telegram private-chat sync is disabled. User contacts are created only through the official Bot API.'
  },
  paymentGroup: {
    key: 'PAYMENT_TELEGRAM_GROUP',
    value: process.env.PAYMENT_GROUP_LISTENER || 'payment_telegram_group',
    chatId: process.env.PAYMENT_TELEGRAM_GROUP || process.env.PAYMENT_GROUP_CHAT_ID || null,
    description: 'Separate payment confirmation group listener using PAYMENT_TELEGRAM_SESSION.'
  }
};
