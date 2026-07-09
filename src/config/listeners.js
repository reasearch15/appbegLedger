export const listenerRoles = {
  chatAccount: {
    key: 'CHAT_TELEGRAM_ACCOUNT',
    value: process.env.CHAT_TELEGRAM_ACCOUNT || process.env.CHAT_ACCOUNT_LISTENER || 'business_telegram_account',
    description: 'Customer private chat listener (Telethon business account session).'
  },
  paymentGroup: {
    key: 'PAYMENT_TELEGRAM_GROUP',
    value: process.env.PAYMENT_GROUP_LISTENER || 'payment_telegram_group',
    chatId: process.env.PAYMENT_TELEGRAM_GROUP || process.env.PAYMENT_GROUP_CHAT_ID || null,
    description: 'Separate payment confirmation group listener using PAYMENT_TELEGRAM_SESSION.'
  }
};
