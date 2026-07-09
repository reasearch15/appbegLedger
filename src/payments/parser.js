const UNKNOWN_RECIPIENT_TAG = 'unknown';

const MONEY_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
const OPTIONAL_MARKER = String.raw`(?:[^\w\s$]{1,3}[ \t]*)?`;
const OPTIONAL_GREETING = String.raw`[ \t]*(?:${OPTIONAL_MARKER})?Hi[ \t]+\$?(?<recipient_tag>[A-Za-z0-9_]+),[ \t]*\r?\n[ \t]*\r?\n`;

const PAYMENT_MESSAGE_PATTERN = new RegExp(
  String.raw`^(?:${OPTIONAL_GREETING})?[ \t]*You[ \t]+received[ \t]+\$(?<amount>${MONEY_PATTERN})[ \t]+from[ \t]+(?<payment_sender_name>[^\r\n]+?)\.[ \t]*\r?\n[ \t]*\r?\n[ \t]*(?<hour>\d{1,2}):(?<minute>\d{2})[ \t]+(?<meridiem>AM|PM)[ \t]+-[ \t]+(?<day>\d{1,2})[ \t]+(?<month>[A-Za-z]{3})[ \t]+(?<year>\d{4})[ \t]*\r?\n[ \t]*(?:${OPTIONAL_MARKER})?Total[ \t]+In[ \t]*:[ \t]*(?<total_in>${MONEY_PATTERN})\$[ \t]*\r?\n[ \t]*(?:${OPTIONAL_MARKER})?Total[ \t]+Out[ \t]*:[ \t]*(?<total_out>${MONEY_PATTERN})\$[ \t]*(?:\r?\n[\s\S]*)?$`,
  'i'
);

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

function parseDecimal(value) {
  return Number.parseFloat(String(value).replace(/,/g, ''));
}

function parseDatetime(groups) {
  let hour = Number.parseInt(groups.hour, 10);
  const minute = Number.parseInt(groups.minute, 10);
  const meridiem = String(groups.meridiem).toUpperCase();

  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('Invalid payment time');
  }

  hour %= 12;
  if (meridiem === 'PM') {
    hour += 12;
  }

  const month = MONTHS[String(groups.month).toLowerCase()];
  if (!month) {
    throw new Error('Invalid payment month');
  }

  return new Date(
    Number.parseInt(groups.year, 10),
    month - 1,
    Number.parseInt(groups.day, 10),
    hour,
    minute,
    0,
    0
  );
}

export function detectPaymentApp(rawText = '') {
  const text = String(rawText || '').toLowerCase();
  if (text.includes('cash app')) return 'Cash App';
  if (text.includes('apple pay')) return 'Apple Pay';
  if (text.includes('zelle')) return 'Zelle';
  if (text.includes('chime') || PAYMENT_MESSAGE_PATTERN.test(String(rawText || '').trim())) return 'Chime';
  return null;
}

export function parsePaymentMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const match = text.match(PAYMENT_MESSAGE_PATTERN);
  if (!match?.groups) return null;

  try {
    const recipientTag = match.groups.recipient_tag || UNKNOWN_RECIPIENT_TAG;
    const amount = parseDecimal(match.groups.amount);
    const totalIn = parseDecimal(match.groups.total_in);
    const totalOut = parseDecimal(match.groups.total_out);
    if (!Number.isFinite(amount) || !Number.isFinite(totalIn) || !Number.isFinite(totalOut)) {
      return null;
    }

    return {
      recipient_tag: recipientTag,
      recipient_tag_normalized: recipientTag.toLowerCase(),
      amount,
      payment_sender_name: match.groups.payment_sender_name.trim(),
      payment_datetime: parseDatetime(match.groups).toISOString(),
      total_in: totalIn,
      total_out: totalOut,
      payment_app: detectPaymentApp(text)
    };
  } catch {
    return null;
  }
}
