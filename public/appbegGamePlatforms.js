/**
 * Fixed RoyalVIP / AppBeg game platform columns (browser copy).
 * Keep in sync with src/db/appbegGamePlatforms.js.
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

export function gameUsernameColumnKey(platformKey) {
  return `game_${platformKey}`;
}

export function buildGamePlatformColumns() {
  return ROYALVIP_GAME_PLATFORMS.map((platform) => ({
    key: gameUsernameColumnKey(platform.key),
    label: platform.label,
    game: true
  }));
}
