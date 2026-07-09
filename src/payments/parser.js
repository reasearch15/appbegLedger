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

const AMOUNT_LINE = /You\s+received\s+\$(?<amount>\d+(?:\.\d+)?)\s+from\s+(?<payment_sender_name>.+?)\s*(?:\r?\n|$)/i;
const MESSAGE_TIME_LINE = /(?<message_time>\d{1,2}:\d{2}\s+(?:AM|PM)\s+-\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i;
const RECIPIENT_LINE = /Hi\s+\$?(?<recipient_tag>[A-Za-z0-9_.-]+)/i;

function parseDecimal(value) {
  return Number.parseFloat(String(value).replace(/,/g, ''));
}

function roundAmount(value) {
  return Math.round(value * 100) / 100;
}

export function parseMessageTime(messageTime) {
  const match = String(messageTime || '').trim().match(
    /(\d{1,2}):(\d{2})\s+(AM|PM)\s+-\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i
  );
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = String(match[3]).toUpperCase();
  const month = MONTHS[String(match[5]).toLowerCase()];

  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59 || !month) {
    return null;
  }

  hour %= 12;
  if (meridiem === 'PM') hour += 12;

  return new Date(
    Number.parseInt(match[6], 10),
    month - 1,
    Number.parseInt(match[4], 10),
    hour,
    minute,
    0,
    0
  );
}

export function isChimePaymentMessage(rawText = '') {
  const text = String(rawText || '').trim();
  return AMOUNT_LINE.test(text) && MESSAGE_TIME_LINE.test(text);
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

export function parsePaymentMessage(rawText) {
  const raw_text = String(rawText || '').trim();
  if (!raw_text) return null;

  const amountMatch = raw_text.match(AMOUNT_LINE);
  const timeMatch = raw_text.match(MESSAGE_TIME_LINE);
  if (!amountMatch?.groups || !timeMatch?.groups) return null;

  const amount = roundAmount(parseDecimal(amountMatch.groups.amount));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const payment_sender_name = String(amountMatch.groups.payment_sender_name || '').trim().replace(/\s+/g, ' ');
  const message_time = String(timeMatch.groups.message_time || '').trim();
  if (!payment_sender_name || !message_time) return null;

  const recipientMatch = raw_text.match(RECIPIENT_LINE);
  const recipient_tag = recipientMatch?.groups?.recipient_tag || null;
  const payment_datetime = parseMessageTime(message_time);

  return {
    raw_text,
    payment_app: 'Chime',
    amount,
    payment_sender_name,
    message_time,
    payment_datetime: payment_datetime ? payment_datetime.toISOString() : null,
    recipient_tag,
    recipient_tag_normalized: recipient_tag ? recipient_tag.toLowerCase() : null
  };
}
