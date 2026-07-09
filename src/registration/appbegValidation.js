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
  '• At least 8 characters',
  '• Include uppercase and lowercase letters',
  '• Include at least one number'
].join('\n');

export function validateAppBegUsername(username) {
  const value = String(username || '').trim();
  if (!value) {
    return { ok: false, error: 'Username is required.', help: APPBEG_USERNAME_HELP };
  }
  if (!APPBEG_USERNAME_PATTERN.test(value)) {
    return { ok: false, error: 'That username does not meet AppBeg requirements.', help: APPBEG_USERNAME_HELP };
  }
  return { ok: true, username: value };
}

export function validateAppBegPassword(password) {
  const value = String(password || '');
  if (!value || value.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.', help: APPBEG_PASSWORD_HELP };
  }
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) {
    return { ok: false, error: 'Password must include uppercase, lowercase, and a number.', help: APPBEG_PASSWORD_HELP };
  }
  return { ok: true, password: value };
}
