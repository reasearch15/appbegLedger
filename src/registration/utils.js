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

export const WELCOME_MESSAGE = [
  'How registration works:',
  '',
  '1. Register your Royal VIP account.',
  '2. Make your first deposit when prompted.',
  '3. Your account is created automatically after payment verification.',
  '4. Log in and start playing instantly.',
  '5. Deposit and cash out online anytime through the Royal VIP website.',
  '',
  '💎 Royal VIP is a fast online casino platform with instant game loading, secure deposits, and convenient online cash outs.'
].join('\n');

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

/**
 * Parse a money amount string into integer cents when the intent is unambiguous.
 *
 * Accepted examples:
 *   5.25, $5.25 → 525
 *   10.5, $10.5 → 1050 (one decimal digit pads to tenths: $10.50)
 *   5¢5, $5¢5 → 505 (one digit after ¢ is literal cents: $5.05, not $5.50)
 *   5¢05, 5¢50 → 505, 550
 *
 * Strips harmless whitespace and `$`. Rejects mixed `.` + `¢` and other malformed input.
 * Does not enforce registration-only rules (minimum / non-zero cents).
 */
export function parseMoneyToCents(text) {
  const raw = String(text || '')
    .trim()
    .replace(/\$/g, '')
    .replace(/\s+/g, '');
  if (!raw) return null;

  // Decimal + cent-sign together is ambiguous (e.g. 5.5¢5).
  if (raw.includes('¢') && raw.includes('.')) return null;

  const centSignMatch = raw.match(/^(\d+)¢(\d{1,2})$/);
  if (centSignMatch) {
    const dollars = Number.parseInt(centSignMatch[1], 10);
    // One digit after ¢ is literal: 5¢5 → 5 cents ($X.05), not padded to 50.
    const cents = Number.parseInt(centSignMatch[2], 10);
    if (!Number.isSafeInteger(dollars) || dollars < 0) return null;
    if (!Number.isInteger(cents) || cents < 0 || cents > 99) return null;
    return dollars * 100 + cents;
  }

  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const dollars = Number.parseInt(match[1], 10);
  const centsText = (match[2] || '').padEnd(2, '0');
  const cents = centsText ? Number.parseInt(centsText, 10) : 0;
  if (!Number.isSafeInteger(dollars) || dollars < 0) return null;
  if (!Number.isInteger(cents) || cents < 0 || cents > 99) return null;
  return dollars * 100 + cents;
}

export function centsToDollars(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) return null;
  return value / 100;
}

export function registrationCreditCents(paymentCents) {
  const cents = Number(paymentCents);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return Math.floor((cents + 99) / 100) * 100;
}

export function parseRegistrationPaymentAmount(text, { minAmount = MIN_REGISTRATION_DEPOSIT } = {}) {
  const paymentCents = parseMoneyToCents(text);
  const minCents = minAmount == null ? null : Number(minAmount) * 100;
  if (!Number.isSafeInteger(paymentCents) || paymentCents <= 0) return null;
  if (minCents != null && paymentCents < minCents) return null;
  if (paymentCents % 100 === 0) return null;
  const creditCents = registrationCreditCents(paymentCents);
  return {
    paymentCents,
    creditCents,
    paymentAmount: centsToDollars(paymentCents),
    creditAmount: centsToDollars(creditCents)
  };
}
