import {
  statusBadge,
  progressBar,
  progressChecklist,
  attentionBadge,
  escapeHtml,
  PLAYER_ROW_HEIGHT,
  getVisibleRange
} from './playerUtils.js';

export const PLAYER_FILTERS = [
  'All',
  'Needs Attention',
  'Not Registered',
  'Collecting Info',
  'Pending Verification',
  'Registered',
  'Suspended'
];

export const STAT_CARD_FILTERS = [
  ['New', 'new'],
  ['Collecting Info', 'collectingInfo'],
  ['Pending Verification', 'pendingVerification'],
  ['Registered', 'registered'],
  ['Suspended', 'suspended'],
  ['Needs Attention', 'needsAttention'],
  ['Total Players', 'total']
];

export function createPlayersController({ api, getState, setState, render }) {
  let searchTimer = null;
  let scrollRaf = null;

  function normalizePlayer(player) {
    if (!player) return player;
    return {
      ...player,
      id: Number(player.id)
    };
  }

  async function refreshPlayers({ keepSelection = true, silent = false } = {}) {
    if (!silent) setState({ playersLoading: true });
    const state = getState();
    const [{ players: rawPlayers }, { stats }] = await Promise.all([
      api(`/api/players?status=${encodeURIComponent(state.playerFilter)}&query=${encodeURIComponent(state.playerQuery)}`),
      api('/api/players/stats')
    ]);
    const players = rawPlayers.map(normalizePlayer);
    setState({
      players,
      playerStats: stats,
      playersLoading: false
    });
    const selectedPlayerId = Number(state.selectedPlayerId);
    if (!keepSelection || !selectedPlayerId || !players.some((player) => player.id === selectedPlayerId)) {
      setState({ selectedPlayerId: players[0]?.id || null });
    }
    await refreshSelectedPlayer({ silent: true });
  }

  async function refreshSelectedPlayer({ silent = false } = {}) {
    const state = getState();
    if (!state.selectedPlayerId) {
      setState({ selectedPlayerDetail: null });
      return;
    }
    if (!silent) setState({ playerDetailLoading: true });
    const detail = await api(`/api/players/${state.selectedPlayerId}`);
    setState({ selectedPlayerDetail: detail, playerDetailLoading: false });
  }

  async function patchPlayer(id, patch) {
    const state = getState();
    const playerId = Number(id);
    const nextPlayers = state.players.map((player) => (Number(player.id) === playerId ? { ...player, ...patch } : player));
    setState({ players: nextPlayers });
  }

  function bindPlayersEvents(root) {
    root.querySelector('#playerSearchInput')?.addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      setState({ playerQuery: value });
      searchTimer = setTimeout(async () => {
        await refreshPlayers({ keepSelection: false, silent: true });
        render();
      }, 220);
    });

    root.querySelectorAll('[data-player-stat]').forEach((card) => {
      card.addEventListener('click', async () => {
        const filter = card.dataset.playerStat;
        const mapped = {
          new: 'New',
          collectingInfo: 'Collecting Info',
          pendingVerification: 'Pending Verification',
          registered: 'Registered',
          suspended: 'Suspended',
          needsAttention: 'Needs Attention',
          total: 'All'
        };
        setState({ playerFilter: mapped[filter] || 'All' });
        await refreshPlayers({ keepSelection: false, silent: true });
        render();
      });
    });

    root.querySelectorAll('[data-player-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        setState({ playerFilter: button.dataset.playerStatus });
        await refreshPlayers({ keepSelection: false, silent: true });
        render();
      });
    });

    const viewport = root.querySelector('#playerTableViewport');
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = null;
          updateVirtualRows(viewport);
        });
      });
    }

    root.querySelectorAll('[data-player-id]').forEach((row) => {
      row.addEventListener('click', async (event) => {
        if (event.target.closest('[data-player-action]')) return;
        setState({ selectedPlayerId: Number(row.dataset.playerId), mobilePlayersPane: 'detail' });
        await refreshSelectedPlayer({ silent: true });
        render();
      });
    });
  }

  function updateVirtualRows(viewport) {
    const body = viewport.querySelector('#playerTableBody');
    if (!body) return;
    const state = getState();
    const { start, end } = getVisibleRange(viewport.scrollTop, viewport.clientHeight, state.players.length);
    const slice = state.players.slice(start, end);
    body.style.transform = `translateY(${start * PLAYER_ROW_HEIGHT}px)`;
    body.innerHTML = slice.map((player) => playerRowHtml(player, state)).join('');
    body.querySelectorAll('[data-player-id]').forEach((row) => {
      row.addEventListener('click', async (event) => {
        if (event.target.closest('[data-player-action]')) return;
        setState({ selectedPlayerId: Number(row.dataset.playerId), mobilePlayersPane: 'detail' });
        await refreshSelectedPlayer({ silent: true });
        render();
      });
    });
  }

  function renderPlayersWorkspace(state, helpers) {
    const selected = state.selectedPlayerDetail?.player || state.players.find((player) => player.id === state.selectedPlayerId);
    const pane = state.mobilePlayersPane || 'list';
    return `
      <main class="ops-main players-main players-workspace mobile-pane-${escapeHtml(pane)}">
        <header class="topbar players-topbar">
          <div>
            <div class="eyebrow">Registration Operations</div>
            <h1>Players Registry</h1>
          </div>
          <div class="stats player-stats">${playerStatCards(state.playerStats || {})}</div>
        </header>
        <section class="players-layout">
          <section class="players-feed">
            <div class="players-toolbar">
              <input id="playerSearchInput" class="search" value="${escapeHtml(state.playerQuery)}" placeholder="Search name, username, ID, AppBeg, payment tag, coadmin, phone, notes, tags" />
              <div class="filter-row">${playerFilterButtons(state.playerFilter)}</div>
            </div>
            <div class="players-table-shell">
              <div class="players-table-header sticky-table-header">
                <span>Player</span>
                <span>Status</span>
                <span>Progress</span>
                <span>Coadmin</span>
                <span>AppBeg</span>
                <span>Payment</span>
                <span>Last Seen</span>
                <span>Registered</span>
                <span>Actions</span>
              </div>
              <div id="playerTableViewport" class="player-table-viewport">
                ${state.playersLoading ? playerSkeletonRows() : playerVirtualTable(state, helpers)}
              </div>
            </div>
          </section>
          <aside class="details-panel players-detail-panel">
            <div class="details-sheet-bar mobile-only">
              <button type="button" class="icon-back" data-mobile-back="players" aria-label="Back to players">←</button>
              <strong>Player detail</strong>
            </div>
            ${state.playerDetailLoading ? playerDetailSkeleton() : playerDetailPanel(selected, state.selectedPlayerDetail, helpers)}
          </aside>
        </section>
      </main>
    `;
  }

  return {
    refreshPlayers,
    refreshSelectedPlayer,
    bindPlayersEvents,
    renderPlayersWorkspace,
    patchPlayer,
    updateVirtualRows
  };
}

function playerStatCards(stats) {
  return STAT_CARD_FILTERS.map(([label, key]) => `
    <button class="stat-card stat-card-button ${key === 'needsAttention' && stats.needsAttention ? 'attention' : ''}" data-player-stat="${key}">
      <div class="stat-number">${Number(stats[key] || 0)}</div>
      <div class="stat-name">${label}</div>
    </button>
  `).join('');
}

function playerFilterButtons(active) {
  return PLAYER_FILTERS.map((item) => `
    <button class="filter-chip ${active === item ? 'active' : ''} ${item === 'Needs Attention' ? 'attention-chip' : ''}" data-player-status="${escapeHtml(item)}">${escapeHtml(item)}</button>
  `).join('');
}

function playerVirtualTable(state, helpers) {
  if (!state.players.length) {
    return `<div class="empty-state players-empty"><div class="empty-icon">👤</div><h3>No players found</h3><p>Try another filter or search term.</p></div>`;
  }
  const viewportHeight = Math.min(state.players.length * PLAYER_ROW_HEIGHT, 640);
  const { start, end } = getVisibleRange(state.playerScrollTop || 0, viewportHeight, state.players.length);
  const slice = state.players.slice(start, end);
  return `
    <div class="player-table-spacer" style="height:${state.players.length * PLAYER_ROW_HEIGHT}px">
      <div id="playerTableBody" class="player-table-body" style="transform:translateY(${start * PLAYER_ROW_HEIGHT}px)">
        ${slice.map((player) => playerRowHtml(player, state, helpers)).join('')}
      </div>
    </div>
  `;
}

function playerRowHtml(player, state, helpers = {}) {
  const avatar = helpers.avatar || (() => '');
  const selected = state.selectedPlayerId === player.id;
  return `
    <article class="players-grid-row ${selected ? 'selected' : ''} ${player.needs_attention ? 'needs-attention' : ''}" data-player-id="${player.id}">
      <div class="player-cell player-identity">
        ${avatar(player, 'sm')}
        <div class="min-w-0">
          <div class="player-name-row">
            <span class="player-name truncate">${escapeHtml(player.display_name)}</span>
            ${player.needs_attention ? attentionBadge(player.attention_flags.length) : ''}
          </div>
          <div class="subtle truncate">${player.username ? '@' + escapeHtml(player.username) : 'No username'}</div>
        </div>
      </div>
      <div class="player-cell">${statusBadge(player.registration_status)}</div>
      <div class="player-cell">${progressBar(player.registration_progress, { compact: true })}</div>
      <div class="player-cell coadmin-cell">
        <div class="truncate">${escapeHtml(player.coadmin_name || '—')}</div>
        <div class="subtle truncate">${escapeHtml(player.coadmin_code || '')}</div>
      </div>
      <div class="player-cell truncate">${escapeHtml(player.appbeg_username || '—')}</div>
      <div class="player-cell truncate">${escapeHtml(player.payment_tag || '—')}</div>
      <div class="player-cell subtle">${helpers.fmtDateTime ? helpers.fmtDateTime(player.last_seen) : player.last_seen}</div>
      <div class="player-cell subtle">${helpers.fmtDateTime ? helpers.fmtDateTime(player.registered_at) : (player.registered_at || '—')}</div>
      <div class="player-cell player-actions">${quickActions(player)}</div>
    </article>
  `;
}

function quickActions(player) {
  const id = player.id;
  const groups = {
    New: [
      { action: 'register', label: 'Register' },
      { action: 'open-chat', label: 'Open Chat' }
    ],
    'Collecting Info': [
      { action: 'register', label: 'Register' },
      { action: 'open-chat', label: 'Open Chat' }
    ],
    'Pending Verification': [
      { action: 'register', label: 'Register' },
      { action: 'approve', label: 'Approve' },
      { action: 'reject', label: 'Reject' },
      { action: 'open-chat', label: 'Open Chat' }
    ],
    Registered: [
      { action: 'edit', label: 'Edit' },
      { action: 'open-chat', label: 'Open Chat' }
    ],
    Suspended: [
      { action: 'reactivate', label: 'Reactivate' },
      { action: 'open-chat', label: 'Open Chat' }
    ]
  };
  const actions = groups[player.registration_status] || [{ action: 'open-chat', label: 'Open Chat' }];
  return actions.map((item) => `
    <button type="button" class="action-chip" data-player-action="${item.action}" data-player-id="${id}">${item.label}</button>
  `).join('');
}

function playerDetailPanel(player, detail, helpers = {}) {
  if (!player) {
    return `<section class="card empty-panel"><div class="empty-state"><div class="empty-icon">👤</div><h3>Select a player</h3><p>Choose a row to review registration details and take action.</p></div></section>`;
  }
  const avatar = helpers.avatar || (() => '');
  const timeline = detail?.timeline || [];
  return `
    <section class="card profile-card">
      <div class="profile-head">
        ${avatar(player, 'lg')}
        <div>
          <h2>${escapeHtml(player.display_name)}</h2>
          <div class="subtle">${player.username ? '@' + escapeHtml(player.username) : 'No username'}</div>
          ${statusBadge(player.registration_status)}
        </div>
      </div>
      ${player.needs_attention ? `<div class="attention-list">${player.attention_flags.map((flag) => `<span class="attention-flag">${escapeHtml(flag.label)}</span>`).join('')}</div>` : ''}
    </section>

    <section class="card panel-section">
      <div class="card-title">Telegram</div>
      ${infoRow('Display Name', player.display_name)}
      ${infoRow('Username', player.username ? '@' + player.username : '—')}
      ${infoRow('Telegram ID', player.telegram_id)}
      ${infoRow('Phone', player.phone_number || '—')}
      ${infoRow('First Seen', helpers.fmtDateTime ? helpers.fmtDateTime(player.first_seen) : player.first_seen)}
      ${infoRow('Last Seen', helpers.fmtDateTime ? helpers.fmtDateTime(player.last_seen) : player.last_seen)}
    </section>

    <section class="card panel-section">
      <div class="card-title">Coadmin</div>
      ${infoRow('Coadmin Name', player.coadmin_name || '—')}
      ${infoRow('Coadmin Code', player.coadmin_code || '—')}
      ${infoRow('AppBeg Coadmin UID', player.appbeg_coadmin_uid || '—')}
    </section>

    <section class="card panel-section">
      <div class="card-title">Registration</div>
      ${infoRow('Status', statusBadge(player.registration_status))}
      ${progressBar(player.registration_progress)}
      ${progressChecklist(player.registration_progress)}
      ${infoRow('AppBeg Username', player.appbeg_username || '—')}
      ${infoRow('Payment Tag', player.payment_tag || '—')}
      ${infoRow('Method', player.registration_method || '—')}
      ${infoRow('Registered At', helpers.fmtDateTime ? helpers.fmtDateTime(player.registered_at) : (player.registered_at || '—'))}
      ${infoRow('Reviewed By', player.info_reviewed_by || '—')}
    </section>

    <section class="card panel-section">
      <div class="card-title">Actions</div>
      <div class="action-grid">
        <button type="button" class="button secondary" data-panel-action="register">Register</button>
        <button type="button" class="button secondary" data-panel-action="edit">Edit Registration</button>
        <button type="button" class="button secondary" data-panel-action="approve">Approve</button>
        <button type="button" class="button secondary" data-panel-action="suspend">Suspend</button>
        <button type="button" class="button secondary" data-panel-action="open-chat">Open Chat</button>
        <button class="button secondary" data-panel-action="copy" data-copy-value="${escapeHtml(player.telegram_id)}">Copy Telegram ID</button>
        <button class="button secondary" data-panel-action="copy" data-copy-value="${escapeHtml(player.appbeg_username || '')}">Copy AppBeg Username</button>
        <button class="button secondary" data-panel-action="copy" data-copy-value="${escapeHtml(player.payment_tag || '')}">Copy Payment Tag</button>
      </div>
    </section>

    <section class="card panel-section">
      <div class="card-title">Timeline</div>
      <div class="timeline">${timelineItems(timeline, helpers)}</div>
    </section>
  `;
}

function infoRow(label, value) {
  return `<div class="info-row"><span>${label}</span><strong>${typeof value === 'string' && value.includes('status-badge') ? value : escapeHtml(String(value ?? '—'))}</strong></div>`;
}

function timelineItems(timeline, helpers) {
  if (!timeline.length) return '<div class="subtle">No registration activity yet.</div>';
  return timeline.slice(0, 30).map((event) => `
    <article class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="strong">${escapeHtml(event.title || event.event_type)}</div>
        <div class="subtle">${escapeHtml(event.actor_name || 'System')} · ${helpers.fmtDateTime ? helpers.fmtDateTime(event.created_at) : event.created_at}</div>
        ${event.body ? `<div class="timeline-body">${escapeHtml(event.body)}</div>` : ''}
      </div>
    </article>
  `).join('');
}

function playerSkeletonRows() {
  return Array.from({ length: 8 }).map(() => `
    <div class="players-grid-row skeleton-row">
      ${Array.from({ length: 9 }).map(() => '<div class="skeleton-block"></div>').join('')}
    </div>
  `).join('');
}

function playerDetailSkeleton() {
  return `
    <section class="card skeleton-card"><div class="skeleton-block tall"></div></section>
    <section class="card skeleton-card"><div class="skeleton-block"></div><div class="skeleton-block"></div><div class="skeleton-block"></div></section>
  `;
}
