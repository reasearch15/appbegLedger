const INTENTS = [
  {
    intent: 'registration',
    patterns: [/make.*account/i, /create.*account/i, /register/i, /sign ?up/i],
    reply: 'Sure, we can help you make an account. Please send the details requested in the registration section, and staff will guide you if anything is missing.'
  },
  {
    intent: 'payment_problem',
    patterns: [/where.*money/i, /money.*missing/i, /not.*received/i, /payment.*problem/i],
    reply: 'I understand. Please send your payment screenshot or transaction details here, and our staff will check it for you.'
  },
  {
    intent: 'deposit_question',
    patterns: [/already paid/i, /i paid/i, /deposit/i, /sent.*money/i],
    reply: 'Thanks. If you already paid, please send the payment screenshot or transaction details so staff can verify it.'
  },
  {
    intent: 'withdrawal_question',
    patterns: [/withdraw/i, /cash ?out/i, /payout/i],
    reply: 'For withdrawal help, please send your account username and the issue you are seeing. Staff will review it and guide you.'
  },
  {
    intent: 'bonus_question',
    patterns: [/bonus/i, /promo/i, /promotion/i, /offer/i],
    reply: 'Bonus rules can depend on the offer. Please send which bonus you mean, and staff will explain the details clearly.'
  },
  {
    intent: 'needs_staff',
    patterns: [/help/i, /staff/i, /somebody/i, /agent/i, /support/i],
    reply: 'Yes, staff can help you. Please tell us what happened, and we will check it for you.'
  },
  {
    intent: 'greeting',
    patterns: [/^(hi|hello|hey|bro|good morning|good afternoon|good evening)\b/i],
    reply: 'Hello, how can we help you today?'
  }
];

export async function generateCustomerSupportDraft({ store, contact, messageText }) {
  const text = String(messageText || '').trim();
  const messages = await store.listMessagesForUser(contact.id);
  const recent = messages.slice(-10).map((message) => {
    const speaker = message.direction === 'incoming' ? 'Customer' : message.sender_type === 'staff' ? 'Staff' : 'Support';
    return `${speaker}: ${message.text || `[${message.message_type || 'message'}]`}`;
  }).join('\n');
  const automationState = await store.getAutomationState(contact.id);
  let activePaymentWindow = null;
  try {
    activePaymentWindow = store.getActiveRegistrationPaymentWindow
      ? await store.getActiveRegistrationPaymentWindow(contact.id)
      : null;
  } catch {
    activePaymentWindow = null;
  }
  const matched = detectIntent(text);
  const reply = softenReply(matched.reply, contact);

  return {
    kind: matched.intent,
    confidence: matched.confidence,
    reply,
    entities: {
      registrationStatus: contact.registration_status || null,
      language: contact.language_code || null,
      currentFlow: automationState?.current_flow || null,
      currentStep: automationState?.current_step || null,
      hasActivePaymentWindow: Boolean(activePaymentWindow)
    },
    context: [
      `Profile: ${contact.display_name || 'Customer'}${contact.username ? ` (@${contact.username})` : ''}`,
      `Registration: ${contact.registration_status || 'Unknown'}`,
      `Language: ${contact.language_code || 'Unknown'}`,
      recent
    ].filter(Boolean).join('\n')
  };
}

function detectIntent(text) {
  for (const item of INTENTS) {
    if (item.patterns.some((pattern) => pattern.test(text))) {
      return { ...item, confidence: 0.7 };
    }
  }
  return {
    intent: 'general_support',
    confidence: 0.45,
    reply: 'Thanks for messaging us. Please share a little more detail so staff can help you quickly.'
  };
}

function softenReply(reply, contact) {
  const name = contact?.first_name || '';
  if (!name || /^@/.test(name)) return reply;
  return reply;
}
