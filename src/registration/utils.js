export function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizePaymentTag(tag) {
  return String(tag || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._@-]+/g, '');
}

export function normalizeAppBegUsername(username) {
  return String(username || '').trim().toLowerCase();
}

export function isUnregisteredStatus(status) {
  return ['New', 'Collecting Info', 'Pending', 'Pending Verification'].includes(status);
}

export function registrationCompletionStatus() {
  const configured = process.env.REGISTRATION_FLOW_COMPLETION_STATUS || 'Pending Verification';
  return configured === 'Registered' ? 'Registered' : 'Pending Verification';
}

export function welcomeCooldownMs() {
  const hours = Number(process.env.WELCOME_COOLDOWN_HOURS || 24);
  return hours * 60 * 60 * 1000;
}

/** Short chatbot welcome re-prompt throttle (seconds). Never permanent. */
export function chatbotWelcomeCooldownMs() {
  const seconds = Number(process.env.CHATBOT_WELCOME_COOLDOWN_SECONDS || 30);
  return Math.max(0, seconds) * 1000;
}

export const WELCOME_MESSAGE = `Hello, welcome to Royal VIP 👋
You are not registered with us yet.
Click Register to start.`;

export const WELCOME_BUTTONS = [[{ label: 'Register', action: 'flow:registration_info' }]];
