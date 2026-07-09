import { escapeHtml } from './playerUtils.js';

const LEDGER_COLUMNS = [
  { key: 'display_name', label: 'Name', sortable: 'name', sticky: true },
  { key: 'player_uid', label: 'UID', mono: true },
  { key: 'username', label: 'Username' },
  { key: 'coadmin', label: 'Coadmin' },
  { key: 'created_by', label: 'Created By' },
  { key: 'source', label: 'Source' },
  { key: 'coin_balance', label: 'Coins', sortable: 'coin_balance', num: true },
  { key: 'cash_balance', label: 'Cash', sortable: 'cash_balance', num: true },
  { key: 'npr_balance', label: 'NPR', num: true },
  { key: 'game_usernames', label: 'Game Usernames' },
  { key: 'game_names', label: 'Games' },
  { key: 'status', label: 'Status' },
  { key: 'last_activity', label: 'Last Activity', sortable: 'last_activity', date: true },
  { key: 'created_at', label: 'Created', sortable: 'created_at', date: true },
  { key: 'updated_at', label: 'Updated', sortable: 'updated_at', date: true }
];

function cellText(value, { date = false } = {}, fmtDateTime) {
  if (value == null || value === '') return '';
  if (date) return fmtDateTime(value);
  return String(value);
}

export function createAppBegPlayersController({ api, getState, setState, render, fmtDateTime }) {
  let searchTimer = null;

  function buildQuery(state) {
    const params = new URLSearchParams();
    params.set('page', String(state.appbegPlayersPage || 1));
    params.set('limit', String(state.appbegPlayersLimit || 100));
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

  function renderSortIndicator(column, state) {
    if (!column.sortable) return '';
    if (state.appbegPlayersSort !== column.sortable) return '';
    return state.appbegPlayersDir === 'asc' ? ' ▲' : ' ▼';
  }

  function renderTableHead(state) {
    return `
      <thead>
        <tr>
          ${LEDGER_COLUMNS.map((column) => `
            <th class="${column.sticky ? 'col-sticky' : ''} ${column.num ? 'col-num' : ''}">
              ${column.sortable
                ? `<button type="button" class="terminal-sort" data-appbeg-sort="${column.sortable}" data-appbeg-sort-dir="${state.appbegPlayersSort === column.sortable && state.appbegPlayersDir === 'asc' ? 'desc' : 'asc'}">${column.label}${renderSortIndicator(column, state)}</button>`
                : escapeHtml(column.label)}
            </th>
          `).join('')}
        </tr>
      </thead>
    `;
  }

  function renderTableBody(state) {
    const players = state.appbegPlayers || [];
    if (!players.length) {
      return `
        <tbody>
          <tr class="terminal-empty-row">
            <td colspan="${LEDGER_COLUMNS.length}">${state.appbegPlayersLoading ? 'Loading…' : 'No players matched your filters.'}</td>
          </tr>
        </tbody>
      `;
    }

    return `
      <tbody>
        ${players.map((player) => `
          <tr class="terminal-data-row" data-appbeg-player-id="${escapeHtml(String(player.id))}" tabindex="0">
            ${LEDGER_COLUMNS.map((column, index) => {
              const raw = cellText(player[column.key], column, fmtDateTime);
              const classes = [
                index === 0 ? 'col-sticky' : '',
                column.num ? 'col-num' : '',
                column.mono ? 'col-mono' : ''
              ].filter(Boolean).join(' ');
              return `<td class="${classes}" title="${escapeHtml(raw || '—')}">${escapeHtml(raw || '—')}</td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    `;
  }

  function renderStatusBar(state) {
    const pagination = state.appbegPlayersPagination;
    const total = pagination?.total ?? 0;
    const page = pagination?.page ?? 1;
    const totalPages = pagination?.totalPages ?? 1;
    const from = total ? ((page - 1) * (state.appbegPlayersLimit || 100)) + 1 : 0;
    const to = total ? Math.min(page * (state.appbegPlayersLimit || 100), total) : 0;

    return `
      <div class="appbeg-terminal-status">
        <span>${state.appbegPlayersLoading ? 'Refreshing…' : `${total.toLocaleString()} players`}</span>
        <span>${total ? `${from.toLocaleString()}–${to.toLocaleString()}` : '0 rows'}</span>
        <span>Page ${page} / ${totalPages}</span>
        <div class="appbeg-terminal-page-btns">
          <button type="button" class="terminal-btn" data-appbeg-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>◀</button>
          <button type="button" class="terminal-btn" data-appbeg-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>▶</button>
        </div>
      </div>
    `;
  }

  function renderDetailDrawer(state) {
    const player = state.appbegPlayersDetail;
    if (!player) return '';

    return `
      <aside class="appbeg-detail-drawer ${state.appbegPlayersDrawerOpen ? 'open' : ''}" aria-hidden="${state.appbegPlayersDrawerOpen ? 'false' : 'true'}">
        <div class="appbeg-detail-drawer-header">
          <strong>${escapeHtml(player.display_name || 'Player')}</strong>
          <button type="button" class="terminal-btn" id="appbegPlayersDrawerClose" aria-label="Close">✕</button>
        </div>
        <div class="appbeg-detail-drawer-body">
          <p class="appbeg-detail-note">Player detail drawer — full profile view coming soon.</p>
          <dl class="appbeg-detail-list">
            ${LEDGER_COLUMNS.map((column) => `
              <div class="appbeg-detail-item">
                <dt>${escapeHtml(column.label)}</dt>
                <dd>${escapeHtml(cellText(player[column.key], column, fmtDateTime) || '—')}</dd>
              </div>
            `).join('')}
          </dl>
        </div>
      </aside>
      <button type="button" class="appbeg-detail-backdrop ${state.appbegPlayersDrawerOpen ? 'open' : ''}" id="appbegPlayersDrawerBackdrop" aria-label="Close detail"></button>
    `;
  }

  function renderToolbar(state) {
    const filters = state.appbegPlayersFilters || { statuses: [], coadmins: [] };
    return `
      <div class="appbeg-terminal-toolbar">
        <span class="appbeg-terminal-brand">AppBeg Players</span>
        <input
          id="appbegPlayersSearch"
          class="appbeg-terminal-search"
          value="${escapeHtml(state.appbegPlayersQuery || '')}"
          placeholder="Search name, UID, username, game user"
          spellcheck="false"
          autocomplete="off"
        />
        <select id="appbegPlayersStatus" class="appbeg-terminal-select" title="Status">
          <option value="">Status: All</option>
          ${filters.statuses.map((status) => `
            <option value="${escapeHtml(status)}" ${state.appbegPlayersStatus === status ? 'selected' : ''}>${escapeHtml(status)}</option>
          `).join('')}
        </select>
        <select id="appbegPlayersCoadmin" class="appbeg-terminal-select" title="Coadmin">
          <option value="">Coadmin: All</option>
          ${filters.coadmins.map((coadmin) => `
            <option value="${escapeHtml(coadmin)}" ${state.appbegPlayersCoadmin === coadmin ? 'selected' : ''}>${escapeHtml(coadmin)}</option>
          `).join('')}
        </select>
        <select id="appbegPlayersLimit" class="appbeg-terminal-select appbeg-terminal-limit" title="Rows per page">
          ${[50, 75, 100].map((size) => `
            <option value="${size}" ${Number(state.appbegPlayersLimit) === size ? 'selected' : ''}>${size}/page</option>
          `).join('')}
        </select>
        <button type="button" class="terminal-btn" id="appbegPlayersRefresh" title="Refresh">↻ Refresh</button>
        <button type="button" class="terminal-btn" id="appbegPlayersExport" title="Export CSV">⭳ CSV</button>
        ${state.appbegPlayersError ? `<span class="appbeg-terminal-error">${escapeHtml(state.appbegPlayersError)}</span>` : ''}
      </div>
    `;
  }

  function renderAppBegPlayersWorkspace(state) {
    if (state.appbegPlayersConfigured === false) {
      return `
        <main class="ops-main appbeg-terminal">
          <div class="appbeg-terminal-toolbar">
            <span class="appbeg-terminal-brand">AppBeg Players</span>
          </div>
          <div class="appbeg-terminal-config-error">
            <strong>${escapeHtml(state.appbegPlayersError || 'AppBeg database is not configured.')}</strong>
            <span>Set <code>APPBEG_DATABASE_URL</code> and restart the server.</span>
          </div>
        </main>
      `;
    }

    return `
      <main class="ops-main appbeg-terminal">
        ${renderToolbar(state)}
        <div class="appbeg-terminal-grid" id="appbegTerminalGrid">
          <table class="appbeg-terminal-table">
            ${renderTableHead(state)}
            ${renderTableBody(state)}
          </table>
        </div>
        ${renderStatusBar(state)}
        ${renderDetailDrawer(state)}
      </main>
    `;
  }

  function openPlayerDrawer(playerId) {
    const state = getState();
    const player = (state.appbegPlayers || []).find((row) => String(row.id) === String(playerId));
    if (!player) return;
    setState({
      appbegPlayersDetail: player,
      appbegPlayersDrawerOpen: true
    });
    render();
  }

  function closePlayerDrawer() {
    setState({
      appbegPlayersDrawerOpen: false
    });
    render();
  }

  function bindAppBegPlayersEvents(root) {
    root.querySelector('#appbegPlayersSearch')?.addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      setState({ appbegPlayersQuery: value, appbegPlayersPage: 1 });
      searchTimer = setTimeout(async () => {
        await refreshAppBegPlayers({ silent: true });
        render();
      }, 220);
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

    root.querySelector('#appbegPlayersLimit')?.addEventListener('change', async (event) => {
      setState({
        appbegPlayersLimit: Number(event.target.value) || 100,
        appbegPlayersPage: 1
      });
      await refreshAppBegPlayers({ silent: true });
      render();
    });

    root.querySelector('#appbegPlayersRefresh')?.addEventListener('click', async () => {
      await refreshAppBegPlayers();
      render();
    });

    root.querySelector('#appbegPlayersExport')?.addEventListener('click', () => {
      const state = getState();
      const params = new URLSearchParams(buildQuery(state));
      params.set('format', 'csv');
      window.open(`/api/appbeg-players?${params.toString()}`, '_blank', 'noopener');
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
        root.querySelector('#appbegTerminalGrid')?.scrollTo({ top: 0 });
      });
    });

    root.querySelectorAll('.terminal-data-row').forEach((row) => {
      row.addEventListener('dblclick', () => {
        openPlayerDrawer(row.dataset.appbegPlayerId);
      });
    });

    root.querySelector('#appbegPlayersDrawerClose')?.addEventListener('click', closePlayerDrawer);
    root.querySelector('#appbegPlayersDrawerBackdrop')?.addEventListener('click', closePlayerDrawer);
  }

  return {
    refreshAppBegPlayers,
    renderAppBegPlayersWorkspace,
    bindAppBegPlayersEvents
  };
}
