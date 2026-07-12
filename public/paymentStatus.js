/**
 * Staff-facing payment queue status helpers (mirrors src/payments/constants.js).
 */

export const MATCHING_STATUS = {
  SEARCHING: 'searching',
  MATCHED: 'matched',
  COMPLETED: 'completed',
  FROZEN: 'frozen',
  MANUAL_REVIEW: 'manual_review',
  IGNORED: 'ignored'
};

export const PAYMENT_STATUS_FILTERS = [
  'All',
  'searching',
  'matched',
  'completed',
  'frozen'
];

export const MANUAL_REVIEW_FILTERS = [
  'All',
  'ambiguous',
  'parse_failure',
  'missing_data',
  'non_payment',
  'cashout',
  'assigned',
  'unassigned',
  'ignored'
];

const SORT_PRIORITY = {
  searching: 1,
  manual_review: 2,
  frozen: 3,
  matched: 4,
  completed: 5,
  ignored: 6
};

export function coerceIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function remainingSecondsUntil(freezeAt, now = Date.now()) {
  const endIso = coerceIsoTimestamp(freezeAt);
  if (!endIso) return null;
  const end = new Date(endIso).getTime();
  const base = typeof now === 'number' ? now : new Date(now).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(base)) return null;
  return Math.max(0, Math.floor((end - base) / 1000));
}

export function formatFreezeCountdown(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Resolve freeze_at for display; prefers API freeze_at. */
export function resolvePaymentFreezeAt(payment = {}) {
  return coerceIsoTimestamp(payment.freeze_at);
}

export function deriveMatchingStatus(payment = {}, now = Date.now()) {
  const routing = payment.routing_status;
  const unmatched = payment.unmatched_reason || null;
  const processing = String(payment.processing_status || '').toLowerCase();

  if (processing === 'completed') return MATCHING_STATUS.COMPLETED;
  if (routing === 'ignored' || routing === 'duplicate_ignored') return MATCHING_STATUS.IGNORED;
  if (routing === 'frozen') return MATCHING_STATUS.FROZEN;

  if (routing === 'parse_failed' || routing === 'route_failed' || routing === 'expired_deposit') {
    return MATCHING_STATUS.MANUAL_REVIEW;
  }

  if (routing === 'manual_review' || routing === 'untouched_unmatched') {
    if (
      unmatched === 'no_active_window'
      || unmatched === 'window_expired'
      || unmatched === 'amount_mismatch'
      || unmatched === 'name_mismatch'
      || !unmatched
    ) {
      return MATCHING_STATUS.FROZEN;
    }
    return MATCHING_STATUS.MANUAL_REVIEW;
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
    const freezeAt = resolvePaymentFreezeAt(payment);
    const remaining = remainingSecondsUntil(freezeAt, now);
    if (freezeAt && remaining === 0) return MATCHING_STATUS.FROZEN;
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
    case MATCHING_STATUS.IGNORED: return 'Ignored';
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
    case MATCHING_STATUS.IGNORED: return '⚪';
    default: return '🟡';
  }
}

export function matchingStatusFilterLabel(filter) {
  if (filter === 'All') return 'All';
  return matchingStatusLabel(filter);
}

export function manualReviewFilterLabel(filter) {
  switch (filter) {
    case 'All': return 'All';
    case 'ambiguous': return 'Ambiguous Match';
    case 'parse_failure': return 'Parse Failure';
    case 'missing_data': return 'Missing Data';
    case 'non_payment': return 'Non-Payment';
    case 'cashout': return 'Cashout Message';
    case 'assigned': return 'Assigned';
    case 'unassigned': return 'Unassigned';
    case 'ignored': return 'Ignored';
    default: return filter;
  }
}

const REVIEW_REASON_LABELS = {
  ambiguous_match: 'Multiple active matching windows',
  multiple_active_matching_windows: 'Multiple active matching windows',
  malformed_payment_message: 'Malformed payment message',
  unsupported_payment_format: 'Unsupported payment format',
  missing_amount: 'Missing amount',
  missing_payment_name: 'Missing payment name',
  non_payment_message: 'Non-payment Telegram message',
  cashout_message: 'Cashout message detected',
  duplicate_payment: 'Duplicate payment',
  parser_exception: 'Parser exception',
  invalid_payment_app: 'Invalid payment app',
  staff_review_requested: 'Staff review requested'
};

export function reviewReasonLabel(reason) {
  if (!reason) return 'Needs staff review';
  return REVIEW_REASON_LABELS[reason] || String(reason).replace(/_/g, ' ');
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
      const fa = resolvePaymentFreezeAt(a) ? new Date(resolvePaymentFreezeAt(a)).getTime() : Number.POSITIVE_INFINITY;
      const fb = resolvePaymentFreezeAt(b) ? new Date(resolvePaymentFreezeAt(b)).getTime() : Number.POSITIVE_INFINITY;
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
  const freezeAt = resolvePaymentFreezeAt(payment);

  if (status === MATCHING_STATUS.SEARCHING) {
    const remaining = remainingSecondsUntil(freezeAt, now);
    const clock = formatFreezeCountdown(remaining);
    if (!freezeAt || clock == null) {
      console.warn('[payments-ui] missing_freeze_at payment=%s routing=%s', payment.id, payment.routing_status);
      return `
        <span class="payment-status-cell payment-status-broken" data-payment-status-id="${payment.id}" data-matching-status="${status}">
          <span class="badge matching-${status}">${emoji} ${escapeHtml(label)}</span>
          <span class="payment-freeze-meta">
            <span class="payment-freeze-label">Timer</span>
            <span class="payment-freeze-countdown payment-freeze-diagnostic">⚠ Missing timer data</span>
          </span>
        </span>
      `;
    }
    return `
      <span class="payment-status-cell" data-payment-status-id="${payment.id}" data-freeze-at="${escapeAttr(freezeAt)}" data-matching-status="${status}">
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
