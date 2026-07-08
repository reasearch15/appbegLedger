export const listenerRoles = {
  chatAccount: {
    key: 'CHAT_TELEGRAM_ACCOUNT',
    value: process.env.CHAT_TELEGRAM_ACCOUNT || process.env.CHAT_ACCOUNT_LISTENER || 'business_telegram_account',
    description: 'Customer chat account listener handled by Telethon.'
  },
  paymentGroup: {
    key: 'PAYMENT_TELEGRAM_GROUP',
    value: process.env.PAYMENT_GROUP_LISTENER || 'payment_telegram_group',
    chatId: process.env.PAYMENT_TELEGRAM_GROUP || process.env.PAYMENT_GROUP_CHAT_ID || null,
    description: 'Payment confirmation group listener handled by a separate Telethon account. Parsing and matching are not implemented.'
  }
};
