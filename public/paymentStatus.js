/**
 * Staff-facing payment queue status helpers (mirrors src/payments/constants.js).
 */

export const MATCHING_STATUS = {
  SEARCHING: 'searching',
  MATCHED: 'matched',
  COMPLETED: 'completed',
  FROZEN: 'frozen',
  MANUAL_REVIEW: 'manual_review'
};

export const PAYMENT_STATUS_FILTERS = [
  'All',
  'searching',
  'matched',
  'completed',
  'frozen',
  'manual_review'
];

const SORT_PRIORITY = {
  searching: 1,
  manual_review: 2,
  frozen: 3,
  matched: 4,
  completed: 5
};

export function remainingSecondsUntil(freezeAt, now = Date.now()) {
  if (!freezeAt) return null;
  const end = new Date(freezeAt).getTime();
  if (!Number.isFinite(end)) return null;
  const base = typeof now === 'number' ? now : new Date(now).getTime();
  return Math.max(0, Math.floor((end - base) / 1000));
}

export function formatFreezeCountdown(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function deriveMatchingStatus(payment = {}, now = Date.now()) {
  const routing = payment.routing_status;
  const unmatched = payment.unmatched_reason || null;
  const processing = String(payment.processing_status || '').toLowerCase();

  if (processing === 'completed') return MATCHING_STATUS.COMPLETED;

  if (routing === 'frozen') return MATCHING_STATUS.FROZEN;

  if (routing === 'manual_review' || routing === 'untouched_unmatched') {
    if (unmatched === 'ambiguous_match') return MATCHING_STATUS.MANUAL_REVIEW;
    return MATCHING_STATUS.FROZEN;
  }

  if (
    routing === 'registered_player_deposit'
    || routing === 'deposit_window_matched'
    || routing === 'registration_payment_matched'
    || routing === 'appbeg_owned'
  ) {
    return MATCHING_STATUS.MATCHED;
  }

  if (routing === 'searching' || routing === 'unrouted') {
    // Prefer backend status. Only show Frozen visually when freeze_at elapsed;
    // backend worker remains authoritative for permanent freeze.
    const remaining = remainingSecondsUntil(payment.freeze_at, now);
    if (payment.freeze_at && remaining === 0) return MATCHING_STATUS.FROZEN;
    return MATCHING_STATUS.SEARCHING;
  }

  if (payment.matching_status && Object.values(MATCHING_STATUS).includes(payment.matching_status)) {
    return payment.matching_status;
  }

  return MATCHING_STATUS.MANUAL_REVIEW;
}

export function matchingStatusLabel(status) {
  switch (status) {
    case MATCHING_STATUS.SEARCHING: return 'Waiting';
    case MATCHING_STATUS.MATCHED: return 'Matched';
    case MATCHING_STATUS.COMPLETED: return 'Completed';
    case MATCHING_STATUS.FROZEN: return 'Frozen';
    case MATCHING_STATUS.MANUAL_REVIEW: return 'Manual Review';
    default: return status || 'Waiting';
  }
}

export function matchingStatusEmoji(status) {
  switch (status) {
    case MATCHING_STATUS.SEARCHING: return '🟡';
    case MATCHING_STATUS.MATCHED: return '🟢';
    case MATCHING_STATUS.COMPLETED: return '🔵';
    case MATCHING_STATUS.FROZEN: return '🔴';
    case MATCHING_STATUS.MANUAL_REVIEW: return '🟠';
    default: return '🟡';
  }
}

export function matchingStatusFilterLabel(filter) {
  if (filter === 'All') return 'All';
  return matchingStatusLabel(filter);
}

export function paymentStatusDetailCopy(payment = {}) {
  const status = deriveMatchingStatus(payment);
  const flow = payment.flow_type || payment.window_flow_type;
  if (status === MATCHING_STATUS.MATCHED) {
    if (flow === 'deposit') return 'Deposit accepted. Waiting for remaining processing if applicable.';
    return 'Payment verified. Registration continues.';
  }
  if (status === MATCHING_STATUS.COMPLETED) {
    if (flow === 'deposit') return 'Deposit credited. Workflow finished.';
    return 'Registration payment completed.';
  }
  if (status === MATCHING_STATUS.FROZEN) {
    return 'No active matching registration or deposit window was found.';
  }
  if (status === MATCHING_STATUS.MANUAL_REVIEW) {
    return 'Multiple active matching windows';
  }
  if (status === MATCHING_STATUS.SEARCHING) {
    return 'Still inside the automatic matching window.';
  }
  return payment.routing_reason || '—';
}

export function sortPaymentsByStatus(payments = [], now = Date.now()) {
  return [...payments].sort((a, b) => {
    const sa = deriveMatchingStatus(a, now);
    const sb = deriveMatchingStatus(b, now);
    const pa = SORT_PRIORITY[sa] ?? 99;
    const pb = SORT_PRIORITY[sb] ?? 99;
    if (pa !== pb) return pa - pb;
    if (sa === MATCHING_STATUS.SEARCHING && sb === MATCHING_STATUS.SEARCHING) {
      const fa = a.freeze_at ? new Date(a.freeze_at).getTime() : Number.POSITIVE_INFINITY;
      const fb = b.freeze_at ? new Date(b.freeze_at).getTime() : Number.POSITIVE_INFINITY;
      if (fa !== fb) return fa - fb;
    }
    const ta = new Date(a.message_date || 0).getTime();
    const tb = new Date(b.message_date || 0).getTime();
    if (tb !== ta) return tb - ta;
    return Number(b.id) - Number(a.id);
  });
}

export function renderPaymentStatusCell(payment = {}, now = Date.now()) {
  const status = deriveMatchingStatus(payment, now);
  const label = matchingStatusLabel(status);
  const emoji = matchingStatusEmoji(status);

  if (status === MATCHING_STATUS.SEARCHING) {
    const remaining = remainingSecondsUntil(payment.freeze_at, now);
    const clock = formatFreezeCountdown(remaining);
    if (!payment.freeze_at || clock == null) {
      return `
        <span class="payment-status-cell" data-payment-status-id="${payment.id}" data-matching-status="${status}">
          <span class="badge matching-${status}">${emoji} ${escapeHtml(label)}</span>
          <span class="payment-freeze-meta">
            <span class="payment-freeze-label">Freeze in</span>
            <span class="payment-freeze-countdown subtle">Awaiting deadline…</span>
          </span>
        </span>
      `;
    }
    return `
      <span class="payment-status-cell" data-payment-status-id="${payment.id}" data-freeze-at="${escapeAttr(payment.freeze_at)}" data-matching-status="${status}">
        <span class="badge matching-${status}">${emoji} ${escapeHtml(label)}</span>
        <span class="payment-freeze-meta">
          <span class="payment-freeze-label">Freeze in</span>
          <span class="payment-freeze-countdown" data-freeze-countdown>${clock}</span>
        </span>
      </span>
    `;
  }

  return `
    <span class="payment-status-cell" data-payment-status-id="${payment.id}" data-matching-status="${status}">
      <span class="badge matching-${status}">${emoji} ${escapeHtml(label)}</span>
    </span>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
