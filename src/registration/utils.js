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
  return ['New', 'Collecting Info', 'Waiting For Payment', 'Pending', 'Pending Verification'].includes(status);
}

export function isReadyToCreateAppBegPlayer(contact, info = {}) {
  if (!info || info.appbeg_creation_complete) return false;
  if (contact?.registration_status === 'Registered') return false;
  return Boolean(
    info.ready_to_create_player
    && String(info.preferred_appbeg_username || '').trim()
    && String(info.appbeg_password || '').trim()
  );
}

export function isReferralSkipInput(text = '') {
  const value = String(text || '').trim().toLowerCase();
  return !value || ['skip', 'none', 'no', 'n/a', 'na', '-'].includes(value);
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

/** Minimum first deposit for Royal VIP bot registration. */
export const MIN_REGISTRATION_DEPOSIT = 5;

/**
 * Parse a first-deposit amount for registration.
 * Accepts positive numbers like 10, 10.5, 25.00, 100.75.
 * Rejects text, zero, negatives, and symbols-only input.
 * Enforces MIN_REGISTRATION_DEPOSIT ($5) by default.
 */
export function parseFirstDepositAmount(text, { minAmount = MIN_REGISTRATION_DEPOSIT } = {}) {
  const raw = String(text || '').trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  if (minAmount != null && rounded < minAmount) return null;
  return rounded;
}
