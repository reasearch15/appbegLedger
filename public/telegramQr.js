import QRCode from './lib/qrcode.js';

/** Compact on-screen card width (px). */
export const DISPLAY_CARD_WIDTH = 260;

/** High-res downloadable card width (px) — suitable for print/social. */
export const DOWNLOAD_CARD_WIDTH = 1080;

/** @deprecated Use DOWNLOAD_CARD_WIDTH; kept for test compatibility. */
export const DOWNLOAD_QR_SIZE = DOWNLOAD_CARD_WIDTH;

/** High ECC so the center logo remains scannable. */
export const QR_ERROR_CORRECTION = 'H';

/** Quiet-zone modules around the QR matrix. */
export const QR_MARGIN_MODULES = 4;

/** Logo diameter as a fraction of the QR drawable area (keep modest). */
export const LOGO_SIZE_RATIO = 0.18;

const COLORS = {
  cardBg: '#ffffff',
  cardBorder: '#d7f0c8',
  quiet: '#ffffff',
  handle: '#3aa000',
  caption: '#5f6b7a',
  logoBg: '#2db200',
  logoIcon: '#ffffff',
  // Dark enough for phone-camera / Lens contrast; lime accents are used in chrome only.
  qrDark: '#0b6b3a'
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

/**
 * Extract @username from a t.me / telegram.me URL for display only.
 * Does not alter the encoded QR payload.
 */
export function telegramHandleFromUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (!/^(t\.me|telegram\.me)$/i.test(parsed.hostname)) return '';
    const username = parsed.pathname.replace(/^\/+/, '').split(/[/?#]/)[0].replace(/^@+/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return '';
    return `@${username}`;
  } catch {
    const match = text.match(/(?:t\.me|telegram\.me)\/@?([A-Za-z0-9_]{5,32})/i);
    return match ? `@${match[1]}` : '';
  }
}

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTelegramPlane(ctx, cx, cy, size) {
  const s = size;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.18);
  ctx.scale(s / 96, s / 96);
  ctx.beginPath();
  ctx.moveTo(-42, -2);
  ctx.lineTo(44, -26);
  ctx.lineTo(10, 36);
  ctx.lineTo(-2, 12);
  ctx.closePath();
  ctx.fillStyle = COLORS.logoIcon;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-2, 12);
  ctx.lineTo(44, -26);
  ctx.lineTo(6, 2);
  ctx.closePath();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = COLORS.logoIcon;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(-2, 12);
  ctx.lineTo(2, 34);
  ctx.lineTo(10, 18);
  ctx.closePath();
  ctx.fillStyle = COLORS.logoIcon;
  ctx.fill();
  ctx.restore();
}

function drawCenterLogo(ctx, qrX, qrY, qrSize) {
  const diameter = qrSize * LOGO_SIZE_RATIO;
  const cx = qrX + qrSize / 2;
  const cy = qrY + qrSize / 2;
  const clearR = diameter * 0.7;
  const logoR = diameter * 0.52;

  ctx.beginPath();
  ctx.arc(cx, cy, clearR, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.quiet;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, logoR, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.logoBg;
  ctx.fill();

  drawTelegramPlane(ctx, cx, cy, logoR * 1.3);
}

function measureCardHeight(width) {
  const pad = Math.round(width * 0.08);
  const qrSize = width - pad * 2;
  const handleSize = Math.round(width * 0.058);
  const captionSize = Math.round(width * 0.042);
  const gap = Math.round(width * 0.045);
  return pad + qrSize + gap + handleSize + Math.round(gap * 0.55) + captionSize + pad;
}

async function renderQrBitmap(url, pixelSize) {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url, {
    errorCorrectionLevel: QR_ERROR_CORRECTION,
    margin: QR_MARGIN_MODULES,
    width: pixelSize,
    color: {
      dark: COLORS.qrDark,
      light: COLORS.quiet
    }
  });
  return canvas;
}

/**
 * Shared renderer used for both on-screen preview and PNG download.
 * Encodes `url` exactly into the QR payload.
 */
export async function renderBrandedTelegramQrCard(canvas, { url, width = DISPLAY_CARD_WIDTH } = {}) {
  const text = String(url || '').trim();
  if (!canvas || !text) {
    throw new Error('Telegram link not configured');
  }

  const cardWidth = Math.max(180, Math.round(width));
  const pad = Math.round(cardWidth * 0.08);
  const qrSize = cardWidth - pad * 2;
  const handle = telegramHandleFromUrl(text);
  const handleSize = Math.round(cardWidth * 0.058);
  const captionSize = Math.round(cardWidth * 0.042);
  const gap = Math.round(cardWidth * 0.045);
  const cardHeight = measureCardHeight(cardWidth);

  // Render QR via the library bitmap path (gap-free modules = reliable scans),
  // then brand with a modest center logo and card chrome.
  const qrCanvas = await renderQrBitmap(text, qrSize);

  canvas.width = cardWidth;
  canvas.height = cardHeight;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cardWidth, cardHeight);

  roundRectPath(ctx, 0.5, 0.5, cardWidth - 1, cardHeight - 1, Math.round(cardWidth * 0.045));
  ctx.fillStyle = COLORS.cardBg;
  ctx.fill();
  ctx.strokeStyle = COLORS.cardBorder;
  ctx.lineWidth = Math.max(2, Math.round(cardWidth * 0.006));
  ctx.stroke();

  ctx.fillStyle = COLORS.quiet;
  ctx.fillRect(pad, pad, qrSize, qrSize);
  ctx.drawImage(qrCanvas, pad, pad, qrSize, qrSize);
  drawCenterLogo(ctx, pad, pad, qrSize);

  let textY = pad + qrSize + gap + handleSize;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  if (handle) {
    ctx.font = `700 ${handleSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillStyle = COLORS.handle;
    ctx.fillText(handle, cardWidth / 2, textY, cardWidth - pad * 2);
    textY += Math.round(gap * 0.55) + captionSize;
  } else {
    textY += captionSize;
  }

  ctx.font = `500 ${captionSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = COLORS.caption;
  ctx.fillText('Scan to open Telegram', cardWidth / 2, textY, cardWidth - pad * 2);

  return canvas;
}

/** Paint the branded card onto an existing canvas (display preview). */
export async function paintTelegramQr(canvas, url, width = DISPLAY_CARD_WIDTH) {
  return renderBrandedTelegramQrCard(canvas, { url, width });
}

/**
 * Generate a high-resolution branded PNG and trigger a browser download.
 * Revokes the Object URL after click so repeated downloads do not leak memory.
 */
export async function downloadTelegramQr(url, filename) {
  const text = String(url || '').trim();
  if (!text) {
    throw new Error('Telegram link not configured');
  }

  const canvas = document.createElement('canvas');
  await renderBrandedTelegramQrCard(canvas, {
    url: text,
    width: DOWNLOAD_CARD_WIDTH
  });

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Could not create Telegram QR image.'));
    }, 'image/png');
  });

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
