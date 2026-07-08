/** Set to true to re-enable Telegram profile photo rendering in the UI. */
export const PROFILE_PHOTOS_ENABLED = false;

const AVATAR_COLORS = [
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6'
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function avatarSeed(contact) {
  const id = Number(contact?.telegram_id ?? contact?.id ?? 0);
  return Math.abs(id) || 1;
}

export function avatarColor(contact) {
  return AVATAR_COLORS[avatarSeed(contact) % AVATAR_COLORS.length];
}

export function avatarLabel(contact) {
  const displayName = String(contact?.display_name || '').trim();
  if (displayName && !['unknown', '?', 'telegram user'].includes(displayName.toLowerCase())) {
    const parts = displayName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
    }
    if (parts[0]) {
      return parts[0].slice(0, 2).toUpperCase();
    }
  }

  const username = String(contact?.username || '').replace(/^@+/, '').trim();
  if (username) {
    return username[0].toUpperCase();
  }

  return null;
}

export function renderAvatar(contact, size = 'md') {
  if (PROFILE_PHOTOS_ENABLED && contact?.profile_photo_url) {
    return `<img class="avatar ${size}" src="${escapeHtml(contact.profile_photo_url)}" alt="" />`;
  }

  const label = avatarLabel(contact);
  const color = avatarColor(contact);
  const content = label
    ? escapeHtml(label)
    : '<span class="avatar-icon" aria-hidden="true">&#128100;</span>';

  return `<div class="avatar ${size}" style="--avatar-bg:${color}">${content}</div>`;
}
