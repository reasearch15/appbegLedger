import QRCode from './lib/qrcode.js';

/** Compact on-screen preview size (px). */
export const DISPLAY_QR_SIZE = 168;

/** High-res PNG for print / social / phone scanning (px). */
export const DOWNLOAD_QR_SIZE = 1024;

const QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 4,
  color: {
    dark: '#000000',
    light: '#ffffff'
  }
};

/**
 * Build a filesystem-safe download name: `<vendor-name>-telegram-qr.png`
 */
export function telegramQrFilename(vendorName) {
  const base = String(vendorName || 'vendor')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'vendor';
  return `${base}-telegram-qr.png`;
}

export async function paintTelegramQr(canvas, url, size = DISPLAY_QR_SIZE) {
  const text = String(url || '').trim();
  if (!canvas || !text) return null;
  await QRCode.toCanvas(canvas, text, {
    ...QR_OPTIONS,
    width: size
  });
  return canvas;
}

/**
 * Generate a high-resolution PNG and trigger a browser download.
 * Revokes the Object URL after click so repeated downloads do not leak memory.
 */
export async function downloadTelegramQr(url, filename) {
  const text = String(url || '').trim();
  if (!text) {
    throw new Error('Telegram link not configured');
  }

  const dataUrl = await QRCode.toDataURL(text, {
    ...QR_OPTIONS,
    width: DOWNLOAD_QR_SIZE
  });

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'telegram-qr.png';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
