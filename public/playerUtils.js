export function statusSlug(status) {
  return String(status || 'unknown').trim().toLowerCase().replace(/\s+/g, '-');
}

export function statusBadge(status, extraClass = '') {
  const slug = statusSlug(status);
  const labels = {
    new: 'New',
    'collecting-info': 'Collecting Info',
    pending: 'Pending',
    'pending-verification': 'Pending Verification',
    registered: 'Registered',
    suspended: 'Suspended',
    archived: 'Archived'
  };
  const label = labels[slug] || status || 'Unknown';
  return `<span class="status-badge status-${slug} ${extraClass}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

export function attentionBadge(count = 0) {
  if (!count) return '';
  return `<span class="attention-badge" title="Needs attention">${Number(count)}</span>`;
}

export function progressBar(progress, { compact = false } = {}) {
  const percent = Number(progress?.percent || 0);
  const filled = Math.max(0, Math.min(8, Math.round(percent / 12.5)));
  const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);
  if (compact) {
    return `
      <div class="progress-compact" title="Registration ${percent}% complete">
        <div class="progress-line"><span style="width:${percent}%"></span></div>
        <span class="progress-percent">${percent}%</span>
      </div>
    `;
  }
  return `
    <div class="progress-block">
      <div class="progress-label">Registration Progress</div>
      <div class="progress-bar-text">${bar} ${percent}%</div>
      <div class="progress-line"><span style="width:${percent}%"></span></div>
    </div>
  `;
}

export function progressChecklist(progress) {
  const steps = progress?.steps || [];
  return `
    <div class="progress-checklist">
      ${steps.map((step) => `
        <div class="progress-step ${step.done ? 'done' : 'pending'}">
          <span class="progress-mark">${step.done ? '✓' : '✗'}</span>
          <span>${escapeHtml(step.label)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export const PLAYER_ROW_HEIGHT = 76;

export function getVisibleRange(scrollTop, viewportHeight, total, rowHeight = PLAYER_ROW_HEIGHT) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 16;
  const end = Math.min(total, start + visibleCount);
  return { start, end };
}
