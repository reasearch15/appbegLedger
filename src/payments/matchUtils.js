export function normalizePaymentName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '');
}

function nameTokens(value = '') {
  return normalizePaymentName(value).split(' ').filter(Boolean);
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
  return paymentNameMatchMethod(expectedName, parsedName) !== null;
}

export function paymentNameMatchMethod(expectedName, parsedName) {
  const expected = normalizePaymentName(expectedName);
  const parsed = normalizePaymentName(parsedName);
  if (!expected || !parsed) return null;
  if (expected === parsed) return 'exact_name';

  const expectedTokens = nameTokens(expectedName);
  const parsedTokens = nameTokens(parsedName);
  if (expectedTokens.length < 2 || parsedTokens.length !== 2) return null;

  const [expectedFirst, expectedSurname] = expectedTokens;
  const [parsedFirst, parsedSurname] = parsedTokens;
  if (expectedFirst !== parsedFirst) return null;
  if (parsedSurname.length !== 1) return null;
  if (!expectedSurname || expectedSurname[0] !== parsedSurname) return null;
  return 'surname_initial';
}
