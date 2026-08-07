/**
 * Fixed RoyalVIP / AppBeg game platform columns.
 * Extend this list when AppBeg officially adds a platform.
 * Lookups always use `key` (normalized_game_name), never display labels.
 */
export const ROYALVIP_GAME_PLATFORMS = Object.freeze([
  { key: 'orion_stars', label: 'Orion Stars' },
  { key: 'fire_kirin', label: 'Fire Kirin' },
  { key: 'juwa', label: 'Juwa' },
  { key: 'juwa2', label: 'Juwa2' },
  { key: 'ultra_panda', label: 'Ultra Panda' },
  { key: 'vb_link', label: 'VB Link' },
  { key: 'mafia', label: 'Mafia' },
  { key: 'cash_frenzy', label: 'Cash Frenzy' },
  { key: 'vegas_sweeps', label: 'Vegas Sweeps' },
  { key: 'milky_way', label: 'Milky Way' },
  { key: 'game_vault', label: 'Game Vault' }
]);

/** Matches AppBeg `normalizeGameName`: lowercase + non-alnum → `_`. */
export function normalizeGameName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

export function gameUsernameColumnKey(platformKey) {
  return `game_${platformKey}`;
}

export function emptyGameUsernameFields() {
  const fields = {};
  for (const platform of ROYALVIP_GAME_PLATFORMS) {
    fields[gameUsernameColumnKey(platform.key)] = null;
  }
  return fields;
}

/**
 * Pivot login rows keyed by normalized_game_name into fixed column fields.
 * Only known platform keys are kept; unknown platforms are ignored (stable UI).
 */
export function pivotGameUsernames(loginRows = []) {
  const fields = emptyGameUsernameFields();
  const allowed = new Set(ROYALVIP_GAME_PLATFORMS.map((platform) => platform.key));

  for (const row of loginRows) {
    const normalized = String(row.normalized_game_name || '').trim();
    if (!normalized || !allowed.has(normalized)) continue;
    const username = String(row.game_username || '').trim();
    if (!username) continue;
    fields[gameUsernameColumnKey(normalized)] = username;
  }

  return fields;
}
