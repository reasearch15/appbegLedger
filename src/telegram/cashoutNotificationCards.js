/**
 * Cash-out Telegram notification cards (Phases 3–7).
 * Phase 6: DONE only for current Telegram operational claimant (viewer-specific).
 * Phase 7: effective flag matrix (notifications → claim → done).
 */

import {
  isCashoutTelegramClaimEnabled as effectiveClaimEnabled,
  isCashoutTelegramDoneEnabled as effectiveDoneEnabled
} from './cashoutTelegramFeatureFlags.js';

export const CASHOUT_CLAIM_PREFIX = 'cashout:claim:';
export const CASHOUT_DONE_PREFIX = 'cashout:done:';

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function isCashoutTelegramClaimEnabled(env = process.env) {
  return effectiveClaimEnabled(env);
}

export function isCashoutTelegramDoneEnabled(env = process.env) {
  return effectiveDoneEnabled(env);
}

export function formatCashoutAmountForNotification(amountNpr) {
  const n = Math.round(Number(amountNpr || 0));
  return `USD ${n.toLocaleString()}`;
}

export function formatCashoutPayoutLabel({ payoutMethod = null, paymentAppName = null } = {}) {
  const appName = clean(paymentAppName);
  if (appName) return appName;
  const method = clean(payoutMethod);
  if (!method) return 'Unknown';
  if (/^qr$/i.test(method)) return 'QR';
  return method;
}

export function formatCashoutDateTime(value, timeZone = 'UTC') {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatCashoutRequestedAt(createdAt, timeZone = 'UTC') {
  return formatCashoutDateTime(createdAt, timeZone) || '—';
}

export function formatCashoutClaimExpiresAt(expiresAt, timeZone = 'UTC', nowMs = Date.now()) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() <= nowMs) return null;
  const formatted = formatCashoutDateTime(expiresAt, timeZone);
  return formatted ? `Claim expires: ${formatted}` : null;
}

export function shortCashoutTaskRef(taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) return null;
  const slice = id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
  return slice ? `#${slice}` : null;
}

export function normalizeCashoutTaskStatus(status) {
  const raw = String(status ?? '').trim().toLowerCase();
  if (raw === 'in_progress' || raw === 'in-progress' || raw === 'claimed') {
    return 'in_progress';
  }
  if (raw === 'completed' || raw === 'complete') return 'completed';
  if (raw === 'declined' || raw === 'decline') return 'declined';
  return 'pending';
}

function resolveOperationalClaim(task) {
  return task?.operationalClaim || (
    task?.operationalAttribution?.actionSource
      ? {
          actionSource: task.operationalAttribution.actionSource,
          telegramUserId: task.operationalAttribution.telegramUserId,
          telegramUsername: task.operationalAttribution.telegramUsername,
          telegramDisplayName: task.operationalAttribution.telegramDisplayName,
          telegramClaimedAt: task.operationalAttribution.telegramClaimedAt
        }
      : null
  );
}

function resolveOperationalCompletion(task) {
  if (task?.operationalCompletion) return task.operationalCompletion;
  const attrs = task?.operationalAttribution;
  if (attrs?.telegramCompletedAt || attrs?.completionSource === 'telegram') {
    return {
      actionSource: attrs.completionSource || 'telegram',
      telegramUserId: attrs.telegramUserId,
      telegramUsername: attrs.telegramUsername,
      telegramDisplayName: attrs.telegramDisplayName,
      telegramCompletedAt: attrs.telegramCompletedAt || null
    };
  }
  return null;
}

function telegramPersonLabel(ops) {
  if (!ops) return null;
  const display = clean(ops.telegramDisplayName);
  if (display) return display;
  const username = clean(ops.telegramUsername);
  if (username) return username.startsWith('@') ? username : `@${username}`;
  return clean(ops.telegramUserId);
}

/**
 * Build plain-text cash-out card from authoritative AppBeg task state.
 */
export function buildCashoutNotificationCard(task, {
  timeZone = 'UTC',
  nowMs = Date.now()
} = {}) {
  const player = clean(task?.playerUsername) || 'Unknown';
  const amount = formatCashoutAmountForNotification(task?.amountNpr);
  const payout = formatCashoutPayoutLabel({
    payoutMethod: task?.payoutMethod,
    paymentAppName: task?.paymentAppName
  });
  const requested = formatCashoutRequestedAt(task?.createdAt, timeZone);
  const ref = shortCashoutTaskRef(task?.taskId);
  const status = normalizeCashoutTaskStatus(task?.status);
  const handler = clean(task?.assignedHandlerUsername);
  const completed = formatCashoutDateTime(task?.completedAt, timeZone);
  const claimExpires = formatCashoutClaimExpiresAt(task?.expiresAt, timeZone, nowMs);
  const claim = resolveOperationalClaim(task);
  const completion = resolveOperationalCompletion(task);
  const telegramClaimant = String(claim?.actionSource || '').toLowerCase() === 'telegram'
    ? telegramPersonLabel(claim)
    : null;
  const telegramCompleter = String(completion?.actionSource || '').toLowerCase() === 'telegram'
    ? telegramPersonLabel(completion)
    : null;

  const lines = [
    '💸 Cash Out',
    `Player: ${player}`,
    `Amount: ${amount}`,
    `Payout: ${payout}`,
    `Requested: ${requested}`
  ];

  if (status === 'in_progress') {
    lines.push('Status: 🟠 IN PROGRESS');
    if (telegramClaimant) {
      lines.push(`Claimed via Telegram by: ${telegramClaimant}`);
      const username = clean(claim?.telegramUsername);
      if (username && !String(telegramClaimant).includes(username.replace(/^@/, ''))) {
        lines.push(username.startsWith('@') ? username : `@${username}`);
      }
    } else if (handler) {
      lines.push(`Handler: ${handler}`);
    }
    if (claimExpires) lines.push(claimExpires);
  } else if (status === 'completed') {
    lines.push('Status: 🟢 COMPLETED');
    if (telegramCompleter) {
      lines.push(`Completed via Telegram by: ${telegramCompleter}`);
      const username = clean(completion?.telegramUsername);
      if (username && !String(telegramCompleter).includes(username.replace(/^@/, ''))) {
        lines.push(username.startsWith('@') ? username : `@${username}`);
      }
    } else if (handler) {
      lines.push(`Handler: ${handler}`);
    }
    if (completed) lines.push(`Completed: ${completed}`);
  } else if (status === 'declined') {
    lines.push('Status: 🔴 DECLINED');
  } else {
    lines.push('Status: 🟡 PENDING');
  }

  if (ref) lines.push(`Ref: ${ref}`);
  return lines.join('\n');
}

export function buildCashoutTaskCreatedCard(task, options = {}) {
  return buildCashoutNotificationCard(task, options);
}

/**
 * Viewer-specific markup:
 * - pending + claim flag → CLAIM (all eligible viewers)
 * - in_progress + DONE flag + viewer is current Telegram claimant → DONE
 * - otherwise empty keyboard (clears stale buttons)
 */
export function buildCashoutNotificationReplyMarkup(task = null, {
  env = process.env,
  claimEnabled = null,
  doneEnabled = null,
  viewerTelegramUserId = null
} = {}) {
  const claimOn = claimEnabled == null
    ? isCashoutTelegramClaimEnabled(env)
    : Boolean(claimEnabled);
  const doneOn = doneEnabled == null
    ? isCashoutTelegramDoneEnabled(env)
    : Boolean(doneEnabled);
  const status = normalizeCashoutTaskStatus(task?.status);
  const taskId = clean(task?.taskId);
  const viewerId = clean(viewerTelegramUserId);

  if (claimOn && status === 'pending' && taskId) {
    const callbackData = `${CASHOUT_CLAIM_PREFIX}${taskId}`;
    if (callbackData.length <= 64) {
      return {
        inline_keyboard: [[{ text: 'CLAIM', callback_data: callbackData }]]
      };
    }
  }

  if (doneOn && status === 'in_progress' && taskId && viewerId) {
    const claim = resolveOperationalClaim(task);
    if (
      String(claim?.actionSource || '').toLowerCase() === 'telegram'
      && clean(claim?.telegramUserId) === viewerId
    ) {
      const callbackData = `${CASHOUT_DONE_PREFIX}${taskId}`;
      if (callbackData.length <= 64) {
        return {
          inline_keyboard: [[{ text: 'DONE', callback_data: callbackData }]]
        };
      }
    }
  }

  return { inline_keyboard: [] };
}

export function buildCashoutTaskCreatedReplyMarkup(task, options) {
  return buildCashoutNotificationReplyMarkup(task, options);
}

export function parseCashoutClaimCallback(action) {
  const raw = String(action || '').trim();
  if (!raw.startsWith(CASHOUT_CLAIM_PREFIX)) return null;
  const taskId = raw.slice(CASHOUT_CLAIM_PREFIX.length).trim();
  return taskId || null;
}

export function parseCashoutDoneCallback(action) {
  const raw = String(action || '').trim();
  if (!raw.startsWith(CASHOUT_DONE_PREFIX)) return null;
  const taskId = raw.slice(CASHOUT_DONE_PREFIX.length).trim();
  return taskId || null;
}
