import { escapeHtml } from './playerUtils.js';

const LEDGER_COLUMNS = [
  { key: 'display_name', label: 'Name', sortable: 'name' },
  { key: 'player_uid', label: 'UID' },
  { key: 'username', label: 'Username' },
  { key: 'coadmin', label: 'Coadmin' },
  { key: 'created_by', label: 'Created By' },
  { key: 'source', label: 'Source' },
  { key: 'coin_balance', label: 'Coins', sortable: 'coin_balance' },
  { key: 'cash_balance', label: 'Cash', sortable: 'cash_balance' },
  { key: 'npr_balance', label: 'NPR' },
  { key: 'game_usernames', label: 'Game Users' },
  { key: 'game_names', label: 'Games' },
  { key: 'status', label: 'Status' },
  { key: 'last_activity', label: 'Last Activity', sortable: 'last_activity' },
  { key: 'created_at', label: 'Created', sortable: 'created_at' },
  { key: 'updated_at', label: 'Updated', sortable: 'updated_at' }
];

function formatCell(value, fmtDateTime) {
  if (value == null || value === '') return '—';
  return escapeHtml(String(value));
}

function formatDateCell(value, fmtDateTime) {
  if (!value) return '—';
  return escapeHtml(fmtDateTime(value));
}

export function createAppBegPlayersController({ api, getState, setState, render, fmtDateTime }) {
  let searchTimer = null;

  function buildQuery(state) {
    const params = new URLSearchParams();
    params.set('page', String(state.appbegPlayersPage || 1));
    params.set('limit', String(state.appbegPlayersLimit || 50));
    if (state.appbegPlayersQuery) params.set('query', state.appbegPlayersQuery);
    if (state.appbegPlayersSort) params.set('sort', state.appbegPlayersSort);
    if (state.appbegPlayersDir) params.set('dir', state.appbegPlayersDir);
    if (state.appbegPlayersStatus) params.set('status', state.appbegPlayersStatus);
    if (state.appbegPlayersCoadmin) params.set('coadmin', state.appbegPlayersCoadmin);
    return params.toString();
  }

  async function refreshAppBegPlayers({ silent = false } = {}) {
    const state = getState();
    if (!silent) setState({ appbegPlayersLoading: true, appbegPlayersError: null });
    render();

    try {
      const payload = await api(`/api/appbeg-players?${buildQuery(state)}`);
      if (!payload.configured) {
        setState({
          appbegPlayersConfigured: false,
          appbegPlayersLoading: false,
          appbegPlayersError: payload.error || 'AppBeg database is not configured.',
          appbegPlayers: [],
          appbegPlayersPagination: null
        });
        return;
      }
      setState({
        appbegPlayersConfigured: true,
        appbegPlayersLoading: false,
        appbegPlayersError: null,
        appbegPlayers: payload.players || [],
        appbegPlayersPagination: payload.pagination || null,
        appbegPlayersFilters: payload.filters || { statuses: [], coadmins: [] },
        appbegPlayersSort: payload.sort?.by || state.appbegPlayersSort,
        appbegPlayersDir: payload.sort?.dir || state.appbegPlayersDir
      });
    } catch (error) {
      const message = error.body?.error || error.message || 'Could not load AppBeg players.';
      setState({
        appbegPlayersLoading: false,
        appbegPlayersError: message,
        appbegPlayersConfigured: error.status !== 503
      });
    }
  }

  function renderHeaderCell(column, state) {
    if (!column.sortable) return `<span>${column.label}</span>`;
    const active = state.appbegPlayersSort === column.sortable;
    const dir = active ? state.appbegPlayersDir : 'desc';
    const indicator = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<button type="button" class="ledger-sort" data-appbeg-sort="${column.sortable}" data-appbeg-sort-dir="${active && dir === 'asc' ? 'desc' : 'asc'}">${column.label}${indicator}</button>`;
  }

  function renderLedgerRow(player, fmt) {
    return `
      <div class="appbeg-ledger-row">
        <div class="appbeg-ledger-cell" title="${formatCell(player.display_name)}">${formatCell(player.display_name)}</div>
        <div class="appbeg-ledger-cell mono" title="${formatCell(player.player_uid)}">${formatCell(player.player_uid)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.username)}">${formatCell(player.username)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.coadmin)}">${formatCell(player.coadmin)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.created_by)}">${formatCell(player.created_by)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.source)}">${formatCell(player.source)}</div>
        <div class="appbeg-ledger-cell num" title="${formatCell(player.coin_balance)}">${formatCell(player.coin_balance)}</div>
        <div class="appbeg-ledger-cell num" title="${formatCell(player.cash_balance)}">${formatCell(player.cash_balance)}</div>
        <div class="appbeg-ledger-cell num" title="${formatCell(player.npr_balance)}">${formatCell(player.npr_balance)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.game_usernames)}">${formatCell(player.game_usernames)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.game_names)}">${formatCell(player.game_names)}</div>
        <div class="appbeg-ledger-cell" title="${formatCell(player.status)}">${formatCell(player.status)}</div>
        <div class="appbeg-ledger-cell" title="${formatDateCell(player.last_activity, fmt)}">${formatDateCell(player.last_activity, fmt)}</div>
        <div class="appbeg-ledger-cell" title="${formatDateCell(player.created_at, fmt)}">${formatDateCell(player.created_at, fmt)}</div>
        <div class="appbeg-ledger-cell" title="${formatDateCell(player.updated_at, fmt)}">${formatDateCell(player.updated_at, fmt)}</div>
      </div>
    `;
  }

  function renderMobileCard(player, fmt) {
    return `
      <article class="appbeg-ledger-card card">
        <div class="appbeg-ledger-card-title">${formatCell(player.display_name)}</div>
        <div class="appbeg-ledger-card-grid">
          <div><span>UID</span><strong>${formatCell(player.player_uid)}</strong></div>
          <div><span>Username</span><strong>${formatCell(player.username)}</strong></div>
          <div><span>Coadmin</span><strong>${formatCell(player.coadmin)}</strong></div>
          <div><span>Status</span><strong>${formatCell(player.status)}</strong></div>
          <div><span>Coins</span><strong>${formatCell(player.coin_balance)}</strong></div>
          <div><span>Cash</span><strong>${formatCell(player.cash_balance)}</strong></div>
          <div><span>NPR</span><strong>${formatCell(player.npr_balance)}</strong></div>
          <div><span>Games</span><strong>${formatCell(player.game_names)}</strong></div>
          <div><span>Game Users</span><strong>${formatCell(player.game_usernames)}</strong></div>
          <div><span>Created By</span><strong>${formatCell(player.created_by)}</strong></div>
          <div><span>Source</span><strong>${formatCell(player.source)}</strong></div>
          <div><span>Last Activity</span><strong>${formatDateCell(player.last_activity, fmt)}</strong></div>
        </div>
      </article>
    `;
  }

  function renderPagination(state) {
    const pagination = state.appbegPlayersPagination;
    if (!pagination) return '';
    const { page, totalPages, total } = pagination;
    return `
      <div class="appbeg-ledger-pagination">
        <div class="subtle">${total.toLocaleString()} players</div>
        <div class="appbeg-ledger-page-controls">
          <button type="button" class="button secondary small" data-appbeg-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Prev</button>
          <span class="subtle">Page ${page} / ${totalPages}</span>
          <button type="button" class="button secondary small" data-appbeg-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;
  }

  function renderAppBegPlayersWorkspace(state) {
    const filters = state.appbegPlayersFilters || { statuses: [], coadmins: [] };
    const players = state.appbegPlayers || [];

    if (state.appbegPlayersConfigured === false) {
      return `
        <main class="ops-main appbeg-players-main">
          <header class="topbar">
            <div>
              <div class="eyebrow">Read-only Ledger</div>
              <h1>AppBeg Players</h1>
            </div>
          </header>
          <section class="card appbeg-ledger-empty">
            <div class="settings-error">${escapeHtml(state.appbegPlayersError || 'AppBeg database is not configured.')}</div>
            <p class="subtle">Set <code>APPBEG_DATABASE_URL</code> in the server environment and restart AppBeg Ledger.</p>
          </section>
        </main>
      `;
    }

    return `
      <main class="ops-main appbeg-players-main">
        <header class="topbar appbeg-players-topbar">
          <div>
            <div class="eyebrow">Read-only Ledger</div>
            <h1>AppBeg Players</h1>
            <div class="subtle">Live player data from the AppBeg PostgreSQL database.</div>
          </div>
          <div class="appbeg-ledger-actions">
            <button type="button" class="button secondary small" id="appbegPlayersExport">Export CSV</button>
          </div>
        </header>

        <section class="appbeg-ledger-toolbar card">
          <input id="appbegPlayersSearch" class="search" value="${escapeHtml(state.appbegPlayersQuery || '')}" placeholder="Search name, UID, username, game username" />
          <div class="appbeg-ledger-filter-row">
            <label class="appbeg-ledger-filter">
              <span>Status</span>
              <select id="appbegPlayersStatus">
                <option value="">All</option>
                ${filters.statuses.map((status) => `
                  <option value="${escapeHtml(status)}" ${state.appbegPlayersStatus === status ? 'selected' : ''}>${escapeHtml(status)}</option>
                `).join('')}
              </select>
            </label>
            <label class="appbeg-ledger-filter">
              <span>Coadmin</span>
              <select id="appbegPlayersCoadmin">
                <option value="">All</option>
                ${filters.coadmins.map((coadmin) => `
                  <option value="${escapeHtml(coadmin)}" ${state.appbegPlayersCoadmin === coadmin ? 'selected' : ''}>${escapeHtml(coadmin)}</option>
                `).join('')}
              </select>
            </label>
          </div>
        </section>

        ${state.appbegPlayersError ? `<div class="settings-error appbeg-ledger-banner">${escapeHtml(state.appbegPlayersError)}</div>` : ''}

        <section class="appbeg-ledger-shell card">
          ${state.appbegPlayersLoading ? '<div class="subtle appbeg-ledger-loading">Loading AppBeg players…</div>' : ''}
          <div class="appbeg-ledger-table-wrap">
            <div class="appbeg-ledger-header sticky-table-header">
              ${LEDGER_COLUMNS.map((column) => `<div class="appbeg-ledger-cell">${renderHeaderCell(column, state)}</div>`).join('')}
            </div>
            <div class="appbeg-ledger-body desktop-only">
              ${players.length
                ? players.map((player) => renderLedgerRow(player, fmtDateTime)).join('')
                : '<div class="appbeg-ledger-empty-row subtle">No players matched your filters.</div>'}
            </div>
          </div>
          <div class="appbeg-ledger-cards mobile-only">
            ${players.length
              ? players.map((player) => renderMobileCard(player, fmtDateTime)).join('')
              : '<div class="appbeg-ledger-empty-row subtle">No players matched your filters.</div>'}
          </div>
          ${renderPagination(state)}
        </section>
      </main>
    `;
  }

  function bindAppBegPlayersEvents(root) {
    root.querySelector('#appbegPlayersSearch')?.addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      setState({ appbegPlayersQuery: value, appbegPlayersPage: 1 });
      searchTimer = setTimeout(async () => {
        await refreshAppBegPlayers({ silent: true });
        render();
      }, 250);
    });

    root.querySelector('#appbegPlayersStatus')?.addEventListener('change', async (event) => {
      setState({ appbegPlayersStatus: event.target.value, appbegPlayersPage: 1 });
      await refreshAppBegPlayers({ silent: true });
      render();
    });

    root.querySelector('#appbegPlayersCoadmin')?.addEventListener('change', async (event) => {
      setState({ appbegPlayersCoadmin: event.target.value, appbegPlayersPage: 1 });
      await refreshAppBegPlayers({ silent: true });
      render();
    });

    root.querySelectorAll('[data-appbeg-sort]').forEach((button) => {
      button.addEventListener('click', async () => {
        setState({
          appbegPlayersSort: button.dataset.appbegSort,
          appbegPlayersDir: button.dataset.appbegSortDir || 'desc',
          appbegPlayersPage: 1
        });
        await refreshAppBegPlayers({ silent: true });
        render();
      });
    });

    root.querySelectorAll('[data-appbeg-page]').forEach((button) => {
      button.addEventListener('click', async () => {
        const page = Number(button.dataset.appbegPage);
        if (!Number.isInteger(page) || page < 1) return;
        setState({ appbegPlayersPage: page });
        await refreshAppBegPlayers({ silent: true });
        render();
      });
    });

    root.querySelector('#appbegPlayersExport')?.addEventListener('click', () => {
      const state = getState();
      const params = new URLSearchParams(buildQuery(state));
      params.set('format', 'csv');
      window.open(`/api/appbeg-players?${params.toString()}`, '_blank', 'noopener');
    });
  }

  return {
    refreshAppBegPlayers,
    renderAppBegPlayersWorkspace,
    bindAppBegPlayersEvents
  };
}
