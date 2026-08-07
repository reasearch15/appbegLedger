import crypto from 'node:crypto';

export const ACCOUNT_VIEW_TOKEN_BYTES = 6;
export const ACCOUNT_DETAILS_HIDDEN_TEXT = 'Account details hidden.';
export const ACCOUNT_DETAILS_UNAVAILABLE_TEXT = [
  'Royal VIP account information is currently unavailable.',
  'Please contact Support.'
].join('\n');
export const ACCOUNT_PRIVACY_WARNING = 'Keep these details private. Anyone with access to this Telegram chat may be able to see them.';
export const ACCOUNT_SENSITIVE_LOG_TEXT = '[sensitive account details omitted]';
export const ACCOUNT_PASSWORD_MASK = '********';
export const GAME_PASSWORD_UNAVAILABLE = 'Not available';

/** @typedef {'usernames' | 'revealed' | 'hidden'} AccountViewMode */

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

/**
 * Build My Account message text.
 * @param {object} credentials - resolveRoyalVipCredentials result
 * @param {object[]} [gameAccounts] - live AppBeg rows { label, username, password|null }
 * @param {AccountViewMode} [mode]
 */
export function buildMyAccountText(credentials, gameAccounts = [], mode = 'usernames') {
  if (!credentials?.ok) return ACCOUNT_DETAILS_UNAVAILABLE_TEXT;

  const showRoyalPassword = mode !== 'hidden';
  const lines = [
    'Royal VIP Account',
    `Username: ${sanitizeCredentialText(credentials.username)}`,
    `Password: ${showRoyalPassword ? sanitizeCredentialText(credentials.password) : ACCOUNT_PASSWORD_MASK}`
  ];

  const accounts = Array.isArray(gameAccounts) ? gameAccounts : [];
  if (accounts.length) {
    lines.push('', '🎮 Game Accounts');
    for (const account of accounts) {
      const label = sanitizeCredentialText(account.label);
      const username = sanitizeCredentialText(account.username);
      if (!label || !username) continue;

      if (mode === 'revealed') {
        const password = sanitizeCredentialText(account.password);
        lines.push(
          '',
          label,
          '',
          'Username:',
          username,
          '',
          'Password:',
          password || GAME_PASSWORD_UNAVAILABLE
        );
      } else {
        // usernames | hidden — never include game passwords
        lines.push('', label, `Username: ${username}`);
      }
    }
  }

  lines.push('', ACCOUNT_PRIVACY_WARNING);
  return lines.join('\n');
}

export function buildMyAccountButtons(token, {
  includeHide = false,
  includeShowGamePasswords = false
} = {}) {
  const royalVipButton = {
    label: '🔴 Open Royal VIP',
    text: '🔴 Open Royal VIP',
    web_app: { url: 'https://royal.youplatform.org' },
    style: 'danger'
  };
  const rows = [
    [royalVipButton],
    [{ label: '🏠 Main Menu', text: 'Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]
  ];

  if (includeShowGamePasswords) {
    rows.push([{
      label: '🔐 Show Game Passwords',
      text: '🔐 Show Game Passwords',
      action: `account:show_game_passwords:${token}`,
      data: `account:show_game_passwords:${token}`
    }]);
  }

  rows.push([
    includeHide
      ? { label: '🙈 Hide Details', text: '🙈 Hide Details', action: `account:hide:${token}`, data: `account:hide:${token}` }
      : null,
    { label: '💬 Support', text: 'Support', action: `account:support:${token}`, data: `account:support:${token}` }
  ].filter(Boolean));

  return rows;
}

export function buildMissingAccountButtons(token) {
  return [
    [{ label: '💬 Support', text: 'Support', action: `account:support:${token}`, data: `account:support:${token}` }],
    [{ label: '🏠 Main Menu', text: 'Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]
  ];
}

export function parseAccountAction(action = '') {
  const match = String(action || '').trim().match(
    /^account:(hide|show_game_passwords|back|support):([a-f0-9]{12})$/i
  );
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
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

export function accountViewSnapshotPatch(info = {}, {
  token,
  messageId,
  hidden = false,
  mode = null
} = {}) {
  return {
    ...info,
    account_view_token: token,
    account_view_message_id: Number(messageId) || null,
    account_view_hidden: Boolean(hidden),
    ...(mode ? { account_view_mode: mode } : {}),
    account_view_updated_at: new Date().toISOString()
  };
}

export function royalVipCredentialSnapshot({ info = {}, username, password, playerUid = null, telegramUserId = null } = {}) {
  return {
    ...info,
    royal_vip_credentials: {
      username: sanitizeCredentialText(username),
      password: sanitizeCredentialText(password),
      player_uid: playerUid || info.appbeg_player_uid || null,
      telegram_user_id: telegramUserId || info.telegram_user_id || null,
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
