/**
 * Ongoing dashboard — active registrations & deposits with live DB-backed countdowns.
 * Separate from Payments / Payment Freeze.
 */

import { renderAvatar as avatar } from './avatarUtils.js';
import {
  remainingSecondsUntil,
  formatFreezeCountdown
} from './paymentStatus.js';

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

export function resolveOngoingUrgency(remainingSeconds) {
  if (remainingSeconds == null || !Number.isFinite(remainingSeconds)) {
    return ONGOING_URGENCY.ACTIVE;
  }
  if (remainingSeconds <= 0) return ONGOING_URGENCY.EXPIRED;
  if (remainingSeconds < 30) return ONGOING_URGENCY.CRITICAL;
  if (remainingSeconds < 120) return ONGOING_URGENCY.EXPIRING_SOON;
  return ONGOING_URGENCY.ACTIVE;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function windowExpiresAt(item) {
  return item.window_expires_at
    || item.registration_window_expires_at
    || item.deposit_window_expires_at
    || null;
}

function windowStartedAt(item) {
  return item.window_started_at
    || item.registration_window_started_at
    || item.deposit_window_started_at
    || null;
}

function urgencyBadge(urgency) {
  const label = ONGOING_URGENCY_LABELS[urgency] || 'Active';
  return `<span class="ongoing-urgency-badge urgency-${escapeHtml(urgency)}" data-ongoing-urgency-badge>${escapeHtml(label)}</span>`;
}

function infoLine(label, value) {
  if (value == null || value === '') return '';
  return `
    <div class="ongoing-meta-row">
      <span class="ongoing-meta-label">${escapeHtml(label)}</span>
      <span class="ongoing-meta-value">${value}</span>
    </div>
  `;
}

export function createOngoingController({ api, getState, setState, render, openContact }) {
  let tickerId = null;
  let refreshBusy = false;

  function syncServerSkew(serverTime) {
    if (!serverTime) return;
    const serverMs = new Date(serverTime).getTime();
    if (!Number.isFinite(serverMs)) return;
    setState({ ongoingServerSkewMs: serverMs - Date.now() });
  }

  function nowWithSkew() {
    const skew = Number(getState().ongoingServerSkewMs || 0);
    return Date.now() + skew;
  }

  async function refreshOngoing() {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const payload = await api('/api/ongoing');
      syncServerSkew(payload.serverTime);
      setState({
        ongoingRegistrations: payload.registrations || [],
        ongoingDeposits: payload.deposits || [],
        ongoingSummary: payload.summary || {
          activeRegistrations: 0,
          activeDeposits: 0,
          expiringSoon: 0,
          expiredToday: 0
        },
        ongoingServerTime: payload.serverTime || null,
        ongoingLoading: false,
        ongoingError: null
      });
    } catch (error) {
      setState({
        ongoingLoading: false,
        ongoingError: error.message || 'Failed to load ongoing workflows.'
      });
    } finally {
      refreshBusy = false;
    }
  }

  function stopTicker() {
    if (tickerId != null) {
      clearInterval(tickerId);
      tickerId = null;
    }
  }

  function tickCountdowns() {
    const now = nowWithSkew();
    let needsRefresh = false;

    document.querySelectorAll('[data-ongoing-countdown]').forEach((el) => {
      const card = el.closest('[data-ongoing-expires-at]');
      const expiresAt = card?.getAttribute('data-ongoing-expires-at');
      if (!expiresAt) return;
      const remaining = remainingSecondsUntil(expiresAt, now);
      const clock = formatFreezeCountdown(remaining);
      if (clock != null) el.textContent = clock;

      const urgency = resolveOngoingUrgency(remaining);
      if (card) {
        card.classList.remove('urgency-active', 'urgency-expiring_soon', 'urgency-critical', 'urgency-expired');
        card.classList.add(`urgency-${urgency}`);
        const badge = card.querySelector('[data-ongoing-urgency-badge]');
        if (badge) {
          badge.className = `ongoing-urgency-badge urgency-${urgency}`;
          badge.textContent = ONGOING_URGENCY_LABELS[urgency] || 'Active';
        }
      }
      if (remaining === 0) needsRefresh = true;
    });

    if (needsRefresh && getState().section === 'ongoing') {
      void refreshOngoing().then(() => render());
    }
  }

  function syncTicker() {
    stopTicker();
    if (getState().section !== 'ongoing') return;
    tickCountdowns();
    tickerId = setInterval(() => {
      if (getState().section !== 'ongoing') {
        stopTicker();
        return;
      }
      tickCountdowns();
    }, 1000);
  }

  function statCards() {
    const summary = getState().ongoingSummary || {};
    const cards = [
      ['Active Registrations', summary.activeRegistrations || 0],
      ['Active Deposits', summary.activeDeposits || 0],
      ['Expiring Soon', summary.expiringSoon || 0],
      ['Expired Today', summary.expiredToday || 0]
    ];
    return cards.map(([label, value]) => `
      <article class="stat-card">
        <div class="stat-number">${value}</div>
        <div class="stat-name">${escapeHtml(label)}</div>
      </article>
    `).join('');
  }

  function renderCard(item, { kind }) {
    const now = nowWithSkew();
    const expiresAt = windowExpiresAt(item);
    const startedAt = windowStartedAt(item);
    const remaining = remainingSecondsUntil(expiresAt, now);
    const urgency = resolveOngoingUrgency(remaining);
    const countdown = formatFreezeCountdown(remaining) || '00:00';
    const username = item.telegram_username ? `@${item.telegram_username}` : '';
    const contact = {
      display_name: item.display_name,
      username: item.telegram_username,
      profile_photo_url: item.profile_photo_url
    };
    const amount = item.deposit_amount != null && Number.isFinite(Number(item.deposit_amount))
      ? `$${Number(item.deposit_amount).toFixed(2)}`
      : null;

    const paymentButton = item.matched_payment_event_id
      ? `<button type="button" class="button secondary small" data-ongoing-open-payment="${item.matched_payment_event_id}">Open Payment</button>`
      : '';

    return `
      <article
        class="ongoing-card urgency-${escapeHtml(urgency)}"
        data-ongoing-expires-at="${escapeHtml(expiresAt || '')}"
        data-ongoing-window-id="${item.window_id}"
        data-ongoing-kind="${escapeHtml(kind)}"
      >
        <div class="ongoing-card-top">
          <div class="ongoing-card-identity">
            ${avatar(contact, 'md')}
            <div class="ongoing-card-names">
              <div class="ongoing-card-name">${escapeHtml(item.display_name || 'Unknown')}</div>
              ${username ? `<div class="ongoing-card-username">${escapeHtml(username)}</div>` : ''}
            </div>
          </div>
          <div class="ongoing-card-timer-wrap">
            ${urgencyBadge(urgency)}
            <div class="ongoing-countdown" data-ongoing-countdown>${escapeHtml(countdown)}</div>
          </div>
        </div>
        <div class="ongoing-card-body">
          ${infoLine('Registration Step', kind === 'registration' ? escapeHtml(item.current_step_label || item.current_step || '—') : '')}
          ${infoLine('Deposit Step', kind === 'deposit' ? escapeHtml(item.current_step_label || item.current_step || '—') : '')}
          ${infoLine('AppBeg Username', item.appbeg_username ? escapeHtml(item.appbeg_username) : '')}
          ${infoLine('Payment Tag', item.payment_tag ? escapeHtml(item.payment_tag) : '')}
          ${infoLine('Deposit Amount', amount ? escapeHtml(amount) : '')}
          ${infoLine('Assigned Staff', escapeHtml(item.assigned_staff_name || 'Unassigned'))}
          ${infoLine('Started', escapeHtml(fmtDateTime(startedAt)))}
          ${infoLine('Expires', escapeHtml(fmtDateTime(expiresAt)))}
        </div>
        <div class="ongoing-card-actions">
          <button type="button" class="button small" data-ongoing-open-contact="${item.contact_id}">Open Conversation</button>
          ${paymentButton}
        </div>
      </article>
    `;
  }

  function sectionBlock(title, items, kind, emptyCopy) {
    if (!items.length) {
      return `
        <section class="ongoing-section">
          <h2 class="ongoing-section-title">${escapeHtml(title)}</h2>
          <div class="empty-state">${escapeHtml(emptyCopy)}</div>
        </section>
      `;
    }
    return `
      <section class="ongoing-section">
        <h2 class="ongoing-section-title">${escapeHtml(title)} <span class="ongoing-section-count">${items.length}</span></h2>
        <div class="ongoing-card-list">
          ${items.map((item) => renderCard(item, { kind })).join('')}
        </div>
      </section>
    `;
  }

  function renderWorkspace(state) {
    const error = state.ongoingError
      ? `<div class="modal-error">${escapeHtml(state.ongoingError)}</div>`
      : '';
    const loading = state.ongoingLoading
      ? '<div class="subtle">Loading active workflows…</div>'
      : '';

    return `
      <main class="ops-main ongoing-workspace">
        <header class="topbar">
          <div>
            <div class="eyebrow">Live Workflows</div>
            <h1>Ongoing</h1>
            <div class="subtle">Active registrations and deposits with live countdown timers.</div>
          </div>
          <div class="topbar-actions">
            <button class="button secondary" type="button" data-ongoing-refresh>Refresh</button>
            <div class="stats">${statCards()}</div>
          </div>
        </header>

        <div class="stats mobile-stats mobile-only">${statCards()}</div>
        ${error}
        ${loading}

        <div class="ongoing-layout">
          ${sectionBlock(
    'Ongoing Registrations',
    state.ongoingRegistrations || [],
    'registration',
    'No users are currently inside a registration payment window.'
  )}
          ${sectionBlock(
    'Ongoing Deposits',
    state.ongoingDeposits || [],
    'deposit',
    'No users currently have an active deposit window.'
  )}
        </div>
      </main>
    `;
  }

  function bindEvents(root) {
    root.querySelector('[data-ongoing-refresh]')?.addEventListener('click', async (event) => {
      event.preventDefault();
      setState({ ongoingLoading: true });
      await refreshOngoing();
      render();
    });

    root.querySelectorAll('[data-ongoing-open-contact]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const contactId = Number(button.getAttribute('data-ongoing-open-contact'));
        if (contactId && typeof openContact === 'function') {
          void openContact(contactId);
        }
      });
    });

    root.querySelectorAll('[data-ongoing-open-payment]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const paymentId = Number(button.getAttribute('data-ongoing-open-payment'));
        if (!paymentId) return;
        setState({
          section: 'payments',
          selectedPaymentId: paymentId,
          mobilePaymentsPane: 'detail'
        });
        render();
        void (async () => {
          try {
            const payload = await api(`/api/payments/${paymentId}`);
            setState({
              payment: payload.payment || null,
              paymentRoutingLogs: payload.routingLogs || [],
              registrationWindow: payload.registrationWindow || null
            });
            render();
          } catch (error) {
            console.warn('[ongoing] open payment failed:', error);
          }
        })();
      });
    });
  }

  return {
    refreshOngoing,
    renderWorkspace,
    bindEvents,
    syncTicker,
    stopTicker
  };
}
