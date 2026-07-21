export const APPBEG_USERNAME_PATTERN = /^[A-Z][A-Za-z]*(?:_[A-Za-z]*)?[0-9]+$/;

export const APPBEG_USERNAME_HELP = [
  'Username rules:',
  '• Start with a capital letter',
  '• Letters only (optional underscore)',
  '• Must end with numbers',
  '',
  'Valid examples: Rajex01, Test22, Rajex_22',
  'Invalid examples: saddd, test22, Test, 22Test'
].join('\n');

export const APPBEG_PASSWORD_HELP = [
  'Password rules:',
  '• At least 6 characters'
].join('\n');

export function validateAppBegUsername(username) {
  const value = String(username || '').trim();
  if (!value) {
    return { ok: false, error: 'Username is required.', help: APPBEG_USERNAME_HELP };
  }
  if (!APPBEG_USERNAME_PATTERN.test(value)) {
    return { ok: false, error: 'That username does not meet Royal VIP requirements.', help: APPBEG_USERNAME_HELP };
  }
  return { ok: true, username: value };
}

export function validateAppBegPassword(password) {
  const value = String(password || '');
  if (!value || value.length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters.', help: APPBEG_PASSWORD_HELP };
  }
  return { ok: true, password: value };
}
