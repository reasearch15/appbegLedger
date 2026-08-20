export const OPERATIONAL_ROLES = {
  ROOT_ADMIN: 'root_admin',
  COADMIN: 'coadmin',
  STAFF: 'staff'
};

export const ROLE_RANK = {
  [OPERATIONAL_ROLES.STAFF]: 1,
  [OPERATIONAL_ROLES.COADMIN]: 2,
  [OPERATIONAL_ROLES.ROOT_ADMIN]: 3
};

export function normalizeTelegramUserId(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  return text;
}

export function roleRank(role) {
  return ROLE_RANK[role] || 0;
}

export function canManageHub(role) {
  return role === OPERATIONAL_ROLES.ROOT_ADMIN || role === OPERATIONAL_ROLES.COADMIN;
}

export function canManageStaff(role) {
  return canManageHub(role);
}

export function canToggleConfidenceMode(role) {
  return role === OPERATIONAL_ROLES.ROOT_ADMIN || role === OPERATIONAL_ROLES.COADMIN;
}

export function canOperatePayments(role) {
  return Boolean(ROLE_RANK[role]);
}

export function canAccessSecrets(role) {
  return false;
}

export function assertNotRootRemoval(targetRole) {
  if (targetRole === OPERATIONAL_ROLES.ROOT_ADMIN) {
    const error = new Error('Root Admin cannot be removed.');
    error.code = 'ROOT_ADMIN_IMMUTABLE';
    throw error;
  }
}

export function staffGroupIdFromEnv(env = process.env) {
  const raw = String(env.STAFF_TELEGRAM_GROUP_ID || '').trim();
  return raw || null;
}

export function royalVipHubChannelIdFromEnv(env = process.env) {
  const raw = String(env.ROYAL_VIP_HUB_CHANNEL_ID || '').trim();
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  return raw;
}

export function rootAdminTelegramUserIdFromEnv(env = process.env) {
  return normalizeTelegramUserId(env.ROOT_ADMIN_TELEGRAM_USER_ID);
}

/**
 * Root Admin is the numeric Telegram user ID of the Royal VIP channel
 * creator/owner. Telegram Bot API cannot reliably prove channel ownership
 * (the creator may be hidden; the bot may not be a channel administrator).
 *
 * ROOT_ADMIN_TELEGRAM_USER_ID is therefore an explicit trusted bootstrap
 * value. It is never inferred from username, first staff member, channel
 * membership, or callback payload.
 *
 * Ownership machine-verified: NO
 */
export function describeRootAdminEstablishment(env = process.env) {
  return {
    machineVerified: false,
    source: 'trusted_bootstrap_env',
    configuredTelegramUserId: rootAdminTelegramUserIdFromEnv(env),
    requirement: 'ROOT_ADMIN_TELEGRAM_USER_ID must be the numeric Telegram user ID of the Royal VIP channel creator/owner.'
  };
}

export function isStaffGroupChat(chatId, env = process.env) {
  const configured = staffGroupIdFromEnv(env);
  if (!configured) return false;
  const hubId = royalVipHubChannelIdFromEnv(env);
  if (hubId && String(chatId) === String(hubId)) return false;
  return String(chatId) === String(configured);
}

export function isRoyalVipHubChat(chatId, env = process.env) {
  const hubId = royalVipHubChannelIdFromEnv(env);
  if (!hubId) return false;
  return String(chatId) === String(hubId);
}
