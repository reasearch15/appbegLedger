import crypto from 'node:crypto';
import { registeredMenuButtons } from './botRegistrationState.js';

export const ACCOUNT_VIEW_TOKEN_BYTES = 6;
export const ACCOUNT_DETAILS_HIDDEN_TEXT = 'Account details hidden.';
export const ACCOUNT_DETAILS_UNAVAILABLE_TEXT = 'Your Royal VIP account details are not available yet. Please contact Support.';
export const ACCOUNT_PRIVACY_WARNING = 'Keep these details private. Anyone with access to this Telegram chat may be able to see them.';

export function createAccountViewToken() {
  return crypto.randomBytes(ACCOUNT_VIEW_TOKEN_BYTES).toString('hex');
}

export function resolveRoyalVipCredentials({ contact = {}, info = {} } = {}) {
  const stored = info.royal_vip_credentials && typeof info.royal_vip_credentials === 'object'
    ? info.royal_vip_credentials
    : {};
  const username = firstNonBlank(
    stored.username,
    info.royal_vip_username,
    info.preferred_appbeg_username,
    info.appbeg_username
  );
  const password = firstNonBlank(
    stored.password,
    info.royal_vip_password,
    info.appbeg_password
  );
  const linkedUid = firstNonBlank(stored.player_uid, info.appbeg_player_uid, contact.appbeg_account_id);
  const credentialTelegramId = firstNonBlank(stored.telegram_user_id, info.telegram_user_id);
  const contactTelegramId = firstNonBlank(contact.telegram_id);
  const contactLinkedUid = firstNonBlank(contact.appbeg_account_id);

  if (credentialTelegramId && contactTelegramId && credentialTelegramId !== contactTelegramId) {
    return {
      ok: false,
      reason: 'ownership_mismatch',
      username: null,
      linkedUid: linkedUid || null
    };
  }

  if (stored.player_uid && contactLinkedUid && String(stored.player_uid) !== contactLinkedUid) {
    return {
      ok: false,
      reason: 'ownership_mismatch',
      username: null,
      linkedUid: linkedUid || null
    };
  }

  if (!username || !password) {
    return {
      ok: false,
      reason: !username && !password ? 'missing_username_and_password' : (!username ? 'missing_username' : 'missing_password'),
      username: username || null,
      linkedUid: linkedUid || null
    };
  }

  return {
    ok: true,
    username,
    password,
    linkedUid: linkedUid || null
  };
}

export function buildMyAccountText(credentials) {
  if (!credentials?.ok) return ACCOUNT_DETAILS_UNAVAILABLE_TEXT;
  return [
    '👤 Royal VIP Account',
    '',
    'Username:',
    sanitizeCredentialText(credentials.username),
    '',
    'Password:',
    sanitizeCredentialText(credentials.password),
    '',
    ACCOUNT_PRIVACY_WARNING
  ].join('\n');
}

export function buildMyAccountButtons(token, { includeHide = true, includeBack = true } = {}) {
  const royalVipButton = registeredMenuButtons()[0][1];
  const rows = [
    [royalVipButton],
    [
      includeHide
        ? { label: '🙈 Hide Details', text: '🙈 Hide Details', action: `account:hide:${token}`, data: `account:hide:${token}` }
        : null,
      { label: 'Support', text: 'Support', action: `account:support:${token}`, data: `account:support:${token}` }
    ].filter(Boolean)
  ];
  if (includeBack) {
    rows.push([{ label: 'Back', text: 'Back', action: `account:back:${token}`, data: `account:back:${token}` }]);
  }
  return rows;
}

export function buildMissingAccountButtons(token) {
  return [
    [{ label: 'Support', text: 'Support', action: `account:support:${token}`, data: `account:support:${token}` }],
    [{ label: 'Back', text: 'Back', action: `account:back:${token}`, data: `account:back:${token}` }]
  ];
}

export function parseAccountAction(action = '') {
  const match = String(action || '').trim().match(/^account:(hide|back|support):([a-f0-9]{12})$/i);
  if (!match) return null;
  return {
    type: match[1],
    token: match[2].toLowerCase()
  };
}

export function isFreshAccountAction({ info = {}, action = null, messageId = null } = {}) {
  const parsed = typeof action === 'string' ? parseAccountAction(action) : action;
  if (!parsed) return false;
  const expectedToken = String(info.account_view_token || '').trim().toLowerCase();
  const expectedMessageId = Number(info.account_view_message_id || 0) || null;
  const pressedMessageId = Number(messageId || 0) || null;
  return Boolean(expectedToken)
    && parsed.token === expectedToken
    && Boolean(expectedMessageId)
    && expectedMessageId === pressedMessageId;
}

export function accountViewSnapshotPatch(info = {}, { token, messageId, hidden = false } = {}) {
  return {
    ...info,
    account_view_token: token,
    account_view_message_id: Number(messageId) || null,
    account_view_hidden: Boolean(hidden),
    account_view_updated_at: new Date().toISOString()
  };
}

export function royalVipCredentialSnapshot({ info = {}, username, password, playerUid = null } = {}) {
  return {
    ...info,
    royal_vip_credentials: {
      username: sanitizeCredentialText(username),
      password: sanitizeCredentialText(password),
      player_uid: playerUid || info.appbeg_player_uid || null,
      telegram_user_id: info.telegram_user_id || null,
      saved_at: new Date().toISOString()
    }
  };
}

export function sanitizeCredentialText(value = '') {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 256);
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = sanitizeCredentialText(value);
    if (text) return text;
  }
  return '';
}
