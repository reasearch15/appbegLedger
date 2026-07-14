/** Timer urgency for ongoing registration / deposit windows. */

export const ONGOING_URGENCY = {
  ACTIVE: 'active',
  EXPIRING_SOON: 'expiring_soon',
  CRITICAL: 'critical',
  EXPIRED: 'expired'
};

export const ONGOING_URGENCY_LABELS = {
  [ONGOING_URGENCY.ACTIVE]: 'Active',
  [ONGOING_URGENCY.EXPIRING_SOON]: 'Expiring Soon',
  [ONGOING_URGENCY.CRITICAL]: 'Critical',
  [ONGOING_URGENCY.EXPIRED]: 'Expired'
};

/** @param {number|null} remainingSeconds */
export function resolveOngoingUrgency(remainingSeconds) {
  if (remainingSeconds == null || !Number.isFinite(remainingSeconds)) {
    return ONGOING_URGENCY.ACTIVE;
  }
  if (remainingSeconds <= 0) return ONGOING_URGENCY.EXPIRED;
  if (remainingSeconds < 30) return ONGOING_URGENCY.CRITICAL;
  if (remainingSeconds < 120) return ONGOING_URGENCY.EXPIRING_SOON;
  return ONGOING_URGENCY.ACTIVE;
}

export function remainingSecondsUntil(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (!Number.isFinite(end)) return null;
  const base = typeof nowMs === 'number' ? nowMs : new Date(nowMs).getTime();
  if (!Number.isFinite(base)) return null;
  return Math.max(0, Math.floor((end - base) / 1000));
}
