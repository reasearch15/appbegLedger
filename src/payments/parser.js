import { centsToDollars, parseMoneyToCents } from '../registration/utils.js';

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

/** Classic Chime body: "You received $1.00 from Amy F." */
const CLASSIC_AMOUNT_LINE = /You\s+received\s+\$(?<amount>\d+(?:\.\d+)?)\s+from\s+(?<payment_sender_name>.+?)\s*(?:\r?\n|$)/i;
/** Classic time: "3:15 PM - 12 Jul 2026" */
const CLASSIC_TIME_LINE = /(?<message_time>\d{1,2}:\d{2}\s+(?:AM|PM)\s+-\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i;
const CLASSIC_RECIPIENT_LINE = /Hi\s+\$?(?<recipient_tag>[A-Za-z0-9_.-]+)/i;

/** Labeled bot notice marker (emoji optional). */
const NEW_CHIME_MARKER = /New\s+Chime\s+Payment/i;
const AMOUNT_RECEIVED_LINE = /Amount\s+Received\s*:\s*\$?\s*(?<amount>\d+(?:\.\d+)?)/i;
const PAYMENT_NAME_LINE = /Payment\s+Name\s*:\s*(?<payment_sender_name>[^\r\n]+)/i;
const PAYMENT_TAG_LINE = /Payment\s+Tag\s*:\s*(?<recipient_tag>[^\r\n]+)/i;
/** Labeled time: "24 Jul 2026, 10:38 PM" */
const RECEIVED_AT_LINE = /Received\s+At\s*:\s*(?<message_time>\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s*,\s*\d{1,2}:\d{2}\s+(?:AM|PM))/i;

function normalizeWhitespaceName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeOptionalTag(raw) {
  const tag = String(raw || '').trim().replace(/^\$/, '');
  if (!tag || /^(n\/?a|-|none|null|—|–)$/i.test(tag)) return null;
  return tag;
}

export function parseMessageTime(messageTime) {
  const text = String(messageTime || '').trim();
  if (!text) return null;

  // Classic: "3:15 PM - 12 Jul 2026"
  const classic = text.match(
    /^(\d{1,2}):(\d{2})\s+(AM|PM)\s+-\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/i
  );
  if (classic) {
    return buildLocalDateTime({
      hour12: Number.parseInt(classic[1], 10),
      minute: Number.parseInt(classic[2], 10),
      meridiem: classic[3],
      day: Number.parseInt(classic[4], 10),
      monthToken: classic[5],
      year: Number.parseInt(classic[6], 10)
    });
  }

  // Labeled Received At: "24 Jul 2026, 10:38 PM"
  const labeled = text.match(
    /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s*,\s*(\d{1,2}):(\d{2})\s+(AM|PM)$/i
  );
  if (labeled) {
    return buildLocalDateTime({
      day: Number.parseInt(labeled[1], 10),
      monthToken: labeled[2],
      year: Number.parseInt(labeled[3], 10),
      hour12: Number.parseInt(labeled[4], 10),
      minute: Number.parseInt(labeled[5], 10),
      meridiem: labeled[6]
    });
  }

  return null;
}

function buildLocalDateTime({ hour12, minute, meridiem, day, monthToken, year }) {
  const month = MONTHS[String(monthToken).toLowerCase()];
  let hour = hour12;

  if (!Number.isInteger(hour) || hour < 1 || hour > 12
    || !Number.isInteger(minute) || minute < 0 || minute > 59
    || !Number.isInteger(day) || day < 1 || day > 31
    || !Number.isInteger(year) || !month) {
    return null;
  }

  hour %= 12;
  if (String(meridiem).toUpperCase() === 'PM') hour += 12;

  // Same convention as before: wall-clock time in the Node process local timezone
  // (typically Asia/Kathmandu on the VPS when TZ is set there).
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function isLabeledChimePaymentMessage(rawText = '') {
  const text = String(rawText || '');
  return NEW_CHIME_MARKER.test(text)
    && AMOUNT_RECEIVED_LINE.test(text)
    && PAYMENT_NAME_LINE.test(text)
    && RECEIVED_AT_LINE.test(text);
}

function isClassicChimePaymentMessage(rawText = '') {
  const text = String(rawText || '');
  return CLASSIC_AMOUNT_LINE.test(text) && CLASSIC_TIME_LINE.test(text);
}

export function isChimePaymentMessage(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return false;
  return isLabeledChimePaymentMessage(text) || isClassicChimePaymentMessage(text);
}

export function detectPaymentApp(rawText = '') {
  if (isChimePaymentMessage(rawText)) return 'Chime';
  const text = String(rawText || '').toLowerCase();
  if (text.includes('cash app')) return 'Cash App';
  if (text.includes('apple pay')) return 'Apple Pay';
  if (text.includes('zelle')) return 'Zelle';
  if (text.includes('chime')) return 'Chime';
  return null;
}

function parseLabeledChimePayment(raw_text) {
  if (!NEW_CHIME_MARKER.test(raw_text)) return null;

  const amountMatch = raw_text.match(AMOUNT_RECEIVED_LINE);
  const nameMatch = raw_text.match(PAYMENT_NAME_LINE);
  const timeMatch = raw_text.match(RECEIVED_AT_LINE);
  if (!amountMatch?.groups || !nameMatch?.groups || !timeMatch?.groups) return null;

  const amountCents = parseMoneyToCents(amountMatch.groups.amount);
  const amount = centsToDollars(amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amount == null) return null;

  const payment_sender_name = normalizeWhitespaceName(nameMatch.groups.payment_sender_name);
  const message_time = String(timeMatch.groups.message_time || '').trim().replace(/\s+/g, ' ');
  if (!payment_sender_name || !message_time) return null;

  const tagMatch = raw_text.match(PAYMENT_TAG_LINE);
  const recipient_tag = normalizeOptionalTag(tagMatch?.groups?.recipient_tag);
  const payment_datetime = parseMessageTime(message_time);
  if (!payment_datetime) {
    console.warn(`[payment-parser] received_at_parse_failed message_time=${JSON.stringify(message_time)}`);
  }

  return {
    raw_text,
    payment_app: 'Chime',
    amount,
    amount_cents: amountCents,
    payment_sender_name,
    message_time,
    payment_datetime: payment_datetime ? payment_datetime.toISOString() : null,
    recipient_tag,
    recipient_tag_normalized: recipient_tag ? recipient_tag.toLowerCase() : null
  };
}

function parseClassicChimePayment(raw_text) {
  const amountMatch = raw_text.match(CLASSIC_AMOUNT_LINE);
  const timeMatch = raw_text.match(CLASSIC_TIME_LINE);
  if (!amountMatch?.groups || !timeMatch?.groups) return null;

  const amountCents = parseMoneyToCents(amountMatch.groups.amount);
  const amount = centsToDollars(amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amount == null) return null;

  const payment_sender_name = normalizeWhitespaceName(amountMatch.groups.payment_sender_name);
  const message_time = String(timeMatch.groups.message_time || '').trim();
  if (!payment_sender_name || !message_time) return null;

  const recipientMatch = raw_text.match(CLASSIC_RECIPIENT_LINE);
  const recipient_tag = recipientMatch?.groups?.recipient_tag || null;
  const payment_datetime = parseMessageTime(message_time);
  if (!payment_datetime) {
    console.warn(`[payment-parser] classic_message_time_parse_failed message_time=${JSON.stringify(message_time)}`);
  }

  return {
    raw_text,
    payment_app: 'Chime',
    amount,
    amount_cents: amountCents,
    payment_sender_name,
    message_time,
    payment_datetime: payment_datetime ? payment_datetime.toISOString() : null,
    recipient_tag,
    recipient_tag_normalized: recipient_tag ? recipient_tag.toLowerCase() : null
  };
}

export function parsePaymentMessage(rawText) {
  const raw_text = String(rawText || '').trim();
  if (!raw_text) return null;

  // Prefer labeled "New Chime Payment" notices; fall back to classic Chime body.
  return parseLabeledChimePayment(raw_text) || parseClassicChimePayment(raw_text);
}
