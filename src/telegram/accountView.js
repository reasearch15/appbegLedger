import crypto from 'node:crypto';
import { ROYALVIP_GAME_PLATFORMS } from '../db/appbegGamePlatforms.js';

export const ACCOUNT_VIEW_TOKEN_BYTES = 6;
export const ACCOUNT_DETAILS_HIDDEN_TEXT = 'Account details hidden.';
export const ACCOUNT_DETAILS_UNAVAILABLE_TEXT = [
  'Royal VIP account information is currently unavailable.',
  'Please contact Support.'
].join('\n');
export const ACCOUNT_PRIVACY_WARNING = 'Keep these details private. Anyone with access to this Telegram chat may be able to see them.';
export const ACCOUNT_SENSITIVE_LOG_TEXT = '[sensitive account details omitted]';
export const ACCOUNT_PASSWORD_MASK = '••••••••';
export const GAME_PASSWORD_UNAVAILABLE = 'Not available';

/** @typedef {'main' | 'main_hidden' | 'game' | 'game_hidden'} AccountViewMode */

const PLATFORM_EMOJI = Object.freeze({
  orion_stars: '🟣',
  fire_kirin: '🟠',
  juwa: '🟢',
  juwa2: '🔵',
  ultra_panda: '🟡',
  vb_link: '🔴',
  mafia: '🟤',
  cash_frenzy: '🟦',
  vegas_sweeps: '🟪',
  milky_way: '🟩',
  game_vault: '⚫'
});

const PLATFORM_KEY_SET = new Set(ROYALVIP_GAME_PLATFORMS.map((platform) => platform.key));

export function createAccountViewToken() {
  return crypto.randomBytes(ACCOUNT_VIEW_TOKEN_BYTES).toString('hex');
}

export function platformEmoji(platformKey) {
  return PLATFORM_EMOJI[String(platformKey || '').trim()] || '🎮';
}

export function platformLabel(platformKey) {
  const key = String(platformKey || '').trim();
  return ROYALVIP_GAME_PLATFORMS.find((platform) => platform.key === key)?.label || key;
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

function buildCredentialBlock(titleLines, username, password, { hidePassword = false } = {}) {
  const lines = [
    ...titleLines,
    '',
    'Username:',
    sanitizeCredentialText(username),
    '',
    'Password:',
    hidePassword
      ? ACCOUNT_PASSWORD_MASK
      : (sanitizeCredentialText(password) || GAME_PASSWORD_UNAVAILABLE)
  ];
  return lines;
}

/**
 * Main My Account text: Royal VIP credentials + Game Accounts header.
 * Game usernames/passwords are not dumped here — they open via buttons.
 */
export function buildMyAccountMainText(credentials, { hidePassword = false } = {}) {
  if (!credentials?.ok) return ACCOUNT_DETAILS_UNAVAILABLE_TEXT;
  return [
    ...buildCredentialBlock(
      ['Royal VIP Account'],
      credentials.username,
      credentials.password,
      { hidePassword }
    ),
    '',
    '🎮 Game Accounts',
    '',
    ACCOUNT_PRIVACY_WARNING
  ].join('\n');
}

/**
 * Single-game detail text.
 */
export function buildGameAccountDetailText(account, { hidePassword = false } = {}) {
  const label = sanitizeCredentialText(account?.label || platformLabel(account?.key));
  return [
    ...buildCredentialBlock(
      [`🎮 ${label}`.trim()],
      account?.username,
      account?.password,
      { hidePassword }
    ),
    '',
    ACCOUNT_PRIVACY_WARNING
  ].join('\n');
}

/** @deprecated Use buildMyAccountMainText / buildGameAccountDetailText */
export function buildMyAccountText(credentials, gameAccounts = [], mode = 'main') {
  if (mode === 'game' || mode === 'game_hidden') {
    const account = Array.isArray(gameAccounts) ? gameAccounts[0] : null;
    return buildGameAccountDetailText(account || {}, { hidePassword: mode === 'game_hidden' });
  }
  return buildMyAccountMainText(credentials, {
    hidePassword: mode === 'main_hidden' || mode === 'hidden'
  });
}

export function buildGameAccountButtons(token, gameAccounts = []) {
  const accounts = Array.isArray(gameAccounts) ? gameAccounts : [];
  const rows = [];
  for (const account of accounts) {
    const key = String(account.key || '').trim();
    if (!PLATFORM_KEY_SET.has(key)) continue;
    const label = sanitizeCredentialText(account.label || platformLabel(key));
    const emoji = platformEmoji(key);
    const text = `${emoji} ${label}`.trim();
    rows.push([{
      label: text,
      text,
      action: `account:game:${key}:${token}`,
      data: `account:game:${key}:${token}`
    }]);
  }
  return rows;
}

export function buildMyAccountButtons(token, {
  gameAccounts = [],
  includeHide = true,
  mode = 'main'
} = {}) {
  const rows = [
    [{
      label: '🔴 Open Royal VIP',
      text: '🔴 Open Royal VIP',
      web_app: { url: 'https://royal.youplatform.org' },
      style: 'danger'
    }],
    ...buildGameAccountButtons(token, gameAccounts)
  ];

  const footer = [];
  if (includeHide && mode !== 'main_hidden' && mode !== 'game_hidden') {
    footer.push({
      label: '🙈 Hide Details',
      text: '🙈 Hide Details',
      action: `account:hide:${token}`,
      data: `account:hide:${token}`
    });
  }
  footer.push({
    label: '🏠 Home',
    text: '🏠 Home',
    action: 'bot:main_menu',
    data: 'bot:main_menu'
  });
  rows.push(footer);

  rows.push([{
    label: '💬 Support',
    text: 'Support',
    action: `account:support:${token}`,
    data: `account:support:${token}`
  }]);

  return rows;
}

export function buildGameDetailButtons(token, { includeHide = true, mode = 'game' } = {}) {
  const rows = [
    [{
      label: '⬅️ Back to Games',
      text: '⬅️ Back to Games',
      action: `account:game_list:${token}`,
      data: `account:game_list:${token}`
    }]
  ];
  const footer = [];
  if (includeHide && mode !== 'game_hidden') {
    footer.push({
      label: '🙈 Hide Details',
      text: '🙈 Hide Details',
      action: `account:hide:${token}`,
      data: `account:hide:${token}`
    });
  }
  footer.push({
    label: '🏠 Home',
    text: '🏠 Home',
    action: 'bot:main_menu',
    data: 'bot:main_menu'
  });
  rows.push(footer);
  return rows;
}

export function buildMissingAccountButtons(token) {
  return [
    [{ label: '💬 Support', text: 'Support', action: `account:support:${token}`, data: `account:support:${token}` }],
    [{ label: '🏠 Home', text: '🏠 Home', action: 'bot:main_menu', data: 'bot:main_menu' }]
  ];
}

export function parseAccountAction(action = '') {
  const raw = String(action || '').trim();
  const gameMatch = raw.match(/^account:game:([a-z0-9_]+):([a-f0-9]{12})$/i);
  if (gameMatch) {
    const platformKey = gameMatch[1].toLowerCase();
    if (!PLATFORM_KEY_SET.has(platformKey)) return null;
    return {
      type: 'game',
      platformKey,
      token: gameMatch[2].toLowerCase()
    };
  }

  const match = raw.match(
    /^account:(hide|game_list|back|support):([a-f0-9]{12})$/i
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
  mode = null,
  platformKey = null
} = {}) {
  const next = {
    ...info,
    account_view_token: token,
    account_view_message_id: Number(messageId) || null,
    account_view_hidden: Boolean(hidden),
    account_view_updated_at: new Date().toISOString()
  };
  if (mode) next.account_view_mode = mode;
  if (platformKey === null) {
    delete next.account_view_platform_key;
  } else if (platformKey !== undefined) {
    next.account_view_platform_key = platformKey;
  }
  return next;
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

export function findGameAccount(gameAccounts = [], platformKey) {
  const key = String(platformKey || '').trim();
  if (!key) return null;
  return (Array.isArray(gameAccounts) ? gameAccounts : []).find((account) => account.key === key) || null;
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = sanitizeCredentialText(value);
    if (text) return text;
  }
  return '';
}
