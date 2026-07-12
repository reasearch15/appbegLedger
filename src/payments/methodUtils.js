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

export function paymentQrCaption({ paymentMethodName, firstDepositAmount, paymentDisplayName }) {
  const amount = formatDepositAmount(firstDepositAmount);
  const money = amount.startsWith('$') ? amount : `$${amount}`;
  return [
    `Please send ${money} using the QR code above.`,
    '',
    `Payment Name: ${paymentDisplayName || '—'}`,
    `Amount: ${money}`,
    '',
    'You have 5 minutes to complete your payment.',
    'We will automatically verify your payment and continue your registration.'
  ].join('\n');
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
