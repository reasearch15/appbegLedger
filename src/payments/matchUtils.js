export function normalizePaymentName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '');
}

export function amountsMatch(expected, parsed) {
  const left = Number(expected);
  const right = Number(parsed);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) < 0.011;
}

export function paymentAppsMatch(expectedApp, parsedApp) {
  const expected = String(expectedApp || '').trim().toLowerCase();
  const parsed = String(parsedApp || '').trim().toLowerCase();
  if (!expected || !parsed) return false;
  if (expected === parsed) return true;
  if (expected.includes(parsed) || parsed.includes(expected)) return true;
  return false;
}

export function paymentNamesMatch(expectedName, parsedName) {
  const expected = normalizePaymentName(expectedName);
  const parsed = normalizePaymentName(parsedName);
  if (!expected || !parsed) return false;
  return expected === parsed;
}
