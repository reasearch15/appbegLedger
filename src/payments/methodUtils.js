import fs from 'node:fs';
import path from 'node:path';

export function slugifyPaymentMethodKey(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return slug || 'payment';
}

export function previewUrlFromFilePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const fileName = path.posix.basename(normalized);
  if (!fileName) return null;
  const match = normalized.match(/data\/media\/([^/]+)\//);
  const folder = match?.[1] || 'payment-qr';
  return `/media/${folder}/${fileName}`;
}

export function normalizeBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function paymentMethodEmoji(method, index = 0) {
  const icons = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return icons[index] || `${index + 1}.`;
}

export function registrationPaymentAppPrompt(methods = []) {
  const lines = methods.map((method, index) => `${paymentMethodEmoji(method, index)} ${method.name}`);
  return [
    'To register, you need to make your first deposit.',
    '',
    'Which payment app are you going to use?',
    lines.join('\n')
  ].join('\n');
}

export function parsePaymentMethodSelection(text, methods = []) {
  const value = String(text || '').trim().toLowerCase();
  if (!value || !methods.length) return null;

  const numberMatch = value.match(/^(\d+)$/);
  if (numberMatch) {
    const index = Number(numberMatch[1]) - 1;
    if (index >= 0 && index < methods.length) return methods[index];
  }

  const normalized = value.replace(/[^a-z0-9]+/g, '');
  for (const method of methods) {
    const keyNorm = String(method.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nameNorm = String(method.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!keyNorm && !nameNorm) continue;
    if (
      value === method.key?.toLowerCase()
      || value === method.name?.toLowerCase()
      || normalized === keyNorm
      || normalized === nameNorm
      || normalized.includes(keyNorm)
      || keyNorm.includes(normalized)
      || normalized.includes(nameNorm)
      || nameNorm.includes(normalized)
    ) {
      return method;
    }
  }
  return null;
}

/**
 * Format a payment amount with a $ and exactly two decimal places.
 * Used for exact-amount player warnings (must match matcher cents).
 */
export function formatExactPaymentAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Prominent player-facing warning: send the exact required amount.
 * `amount` must be the same value stored on the payment window / used by the matcher.
 */
export function exactPaymentAmountWarning(amount) {
  const money = formatExactPaymentAmount(amount);
  if (!money) return null;
  const cents = Math.round(Number(amount) * 100);
  const examples = [];
  const seen = new Set([money]);
  const pushWrong = (value) => {
    const formatted = formatExactPaymentAmount(value);
    if (!formatted || seen.has(formatted)) return;
    seen.add(formatted);
    examples.push(`❌ ${formatted} — Wrong`);
  };
  pushWrong(Math.floor(Number(amount)));
  pushWrong((cents - 1) / 100);
  pushWrong((cents + 1) / 100);
  return [
    '⚠️ IMPORTANT — SEND THE EXACT AMOUNT',
    '',
    `Please send exactly ${money}.`,
    '',
    'Do not round or change the amount.',
    'Even a $0.01 difference may prevent your payment from being matched and loaded automatically.',
    '',
    'Example:',
    `✅ ${money} — Correct`,
    ...examples
  ].join('\n');
}

export function paymentQrCaption({ paymentMethodName, firstDepositAmount, paymentDisplayName, flowType = 'registration', creditedDepositAmount = null }) {
  const hasAmount = firstDepositAmount != null && firstDepositAmount !== '' && Number(firstDepositAmount) > 0;
  if (!hasAmount) {
    return [
      '💵 DEPOSIT INSTRUCTIONS',
      '',
      'Send your payment using the QR / payment information below.',
      'You do not need to tell us the amount — we read it from the payment notice.',
      paymentDisplayName ? `Payment Name on file: ${paymentDisplayName}` : null,
      `Method: ${paymentMethodName || 'Payment'}`,
      '',
      'You have 15 minutes to complete your payment.',
      flowType === 'deposit'
        ? 'We will verify the incoming payment and credit the recipient.'
        : 'We will automatically verify your payment.'
    ].filter((line, index, lines) => line != null && !(line === '' && lines[index - 1] === '')).join('\n');
  }
  const money = formatExactPaymentAmount(firstDepositAmount)
    || (() => {
      const amount = formatDepositAmount(firstDepositAmount);
      return amount.startsWith('$') ? amount : `$${amount}`;
    })();
  const creditedMoney = creditedDepositAmount == null
    ? null
    : (formatExactPaymentAmount(creditedDepositAmount) || (() => {
      const credited = formatDepositAmount(creditedDepositAmount);
      return credited.startsWith('$') ? credited : `$${credited}`;
    })());
  const closing = flowType === 'deposit'
    ? 'We will automatically verify your payment and credit your deposit.'
    : 'We will automatically verify your payment and continue your registration.';
  const registrationCreditLines = flowType === 'deposit' || !creditedMoney
    ? []
    : [`Balance credit after verification: ${creditedMoney}`];
  const exactWarning = exactPaymentAmountWarning(firstDepositAmount);
  return [
    `💰 YOUR EXACT PAYMENT AMOUNT: ${money}`,
    '',
    `Please send exactly ${money} using the payment information below.`,
    '',
    exactWarning,
    '',
    `Payment Name: ${paymentDisplayName || '-'}`,
    `Amount: ${money}`,
    ...registrationCreditLines,
    '',
    'You have 15 minutes to complete your payment.',
    closing
  ].filter((line, index, lines) => !(line === '' && lines[index - 1] === '')).join('\n');
}

export function formatDepositAmount(amount) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function paymentDisplayNamePrompt(paymentMethodName) {
  return `Please enter your payment name.

This should be the name shown on your ${paymentMethodName} payment, not a $tag.`;
}

export function paymentMethodUnavailableMessage(paymentMethodName) {
  return `Sorry, ${paymentMethodName} payments are currently unavailable.`;
}

export const REGISTRATION_QR_LOAD_FAILED_MESSAGE = [
  'We could not load the payment QR right now. Please try again or contact support.'
].join('\n');

/**
 * Resolve a stored QR path into Telegram-ready photo metadata.
 * Accepts HTTPS URL, absolute/relative filesystem path, or /media/... preview URLs.
 */
export function resolvePaymentQrTelegramInput(filePath, { rootDir = process.cwd() } = {}) {
  const raw = String(filePath || '').trim();
  if (!raw) return { ok: false, reason: 'empty_path' };

  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, type: 'url', mediaPath: raw };
  }

  let absolutePath = raw;
  if (raw.startsWith('/media/')) {
    absolutePath = path.join(rootDir, 'data', raw.slice(1));
  } else if (!path.isAbsolute(raw)) {
    absolutePath = path.resolve(rootDir, raw);
  }

  if (!fs.existsSync(absolutePath)) {
    return { ok: false, reason: 'file_missing', absolutePath };
  }

  return {
    ok: true,
    type: 'file',
    mediaPath: absolutePath,
    absolutePath
  };
}
