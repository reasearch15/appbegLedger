export function isCustomerSupportAiConfigured(env = process.env) {
  if (String(env.CUSTOMER_SUPPORT_AI_ENABLED || '').toLowerCase() === 'false') {
    return false;
  }

  const provider = String(env.CUSTOMER_SUPPORT_AI_PROVIDER || 'template').trim().toLowerCase();
  if (!provider || provider === 'template' || provider === 'builtin') {
    return true;
  }

  if (provider === 'openai') {
    return Boolean(String(env.OPENAI_API_KEY || '').trim());
  }

  return Boolean(String(env.CUSTOMER_SUPPORT_AI_API_KEY || '').trim());
}

export function getCustomerSupportAiProvider(env = process.env) {
  return String(env.CUSTOMER_SUPPORT_AI_PROVIDER || 'template').trim().toLowerCase() || 'template';
}
