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

export function canManageStaff(role) {
  return role === OPERATIONAL_ROLES.ROOT_ADMIN || role === OPERATIONAL_ROLES.COADMIN;
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

export function rootAdminTelegramUserIdFromEnv(env = process.env) {
  return normalizeTelegramUserId(env.ROOT_ADMIN_TELEGRAM_USER_ID);
}

export function isStaffGroupChat(chatId, env = process.env) {
  const configured = staffGroupIdFromEnv(env);
  if (!configured) return false;
  return String(chatId) === String(configured);
}
