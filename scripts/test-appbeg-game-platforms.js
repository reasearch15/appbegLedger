import assert from 'node:assert/strict';
import {
  emptyGameUsernameFields,
  gameUsernameColumnKey,
  normalizeGameName,
  pivotGameUsernames,
  ROYALVIP_GAME_PLATFORMS
} from '../src/db/appbegGamePlatforms.js';

assert.equal(normalizeGameName('Orion Stars'), 'orion_stars');
assert.equal(normalizeGameName('VB Link'), 'vb_link');
assert.equal(normalizeGameName('Juwa2'), 'juwa2');
assert.equal(ROYALVIP_GAME_PLATFORMS.length, 11);
assert.equal(gameUsernameColumnKey('orion_stars'), 'game_orion_stars');

const empty = emptyGameUsernameFields();
assert.equal(empty.game_orion_stars, null);
assert.equal(empty.game_fire_kirin, null);

const pivoted = pivotGameUsernames([
  { normalized_game_name: 'orion_stars', game_username: 'Orion_99' },
  { normalized_game_name: 'fire_kirin', game_username: '  ' },
  { normalized_game_name: 'unknown_game', game_username: 'SkipMe' },
  { normalized_game_name: 'juwa', game_username: 'JuwaPlayer1' }
]);

assert.equal(pivoted.game_orion_stars, 'Orion_99');
assert.equal(pivoted.game_fire_kirin, null);
assert.equal(pivoted.game_juwa, 'JuwaPlayer1');
assert.equal(pivoted.game_unknown_game, undefined);
assert.equal(Object.keys(pivoted).length, ROYALVIP_GAME_PLATFORMS.length);

console.log('appbeg-game-platforms: ok');
