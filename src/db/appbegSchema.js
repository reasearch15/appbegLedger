const PLAYER_TABLE_CANDIDATES = ['players_cache', 'players'];
const BALANCE_TABLE_CANDIDATES = ['user_balance_snapshots_cache', 'player_balance_cache', 'user_balances'];
const GAME_TABLE_CANDIDATES = ['player_game_logins_cache', 'game_usernames', 'player_games'];

const COLUMN_CANDIDATES = {
  playerId: ['player_id', 'user_id', 'id', 'uid', 'player_uid'],
  displayName: ['display_name', 'player_name', 'name', 'full_name'],
  username: ['username', 'login_username', 'login', 'player_username'],
  playerUid: ['player_uid', 'uid', 'external_uid', 'appbeg_uid'],
  coadmin: ['coadmin_name', 'assigned_coadmin', 'coadmin', 'coadmin_code', 'coadmin_id'],
  createdBy: ['created_by', 'created_by_name', 'creator_name', 'registered_by', 'created_by_user'],
  source: ['registration_source', 'source', 'origin', 'registration_info'],
  status: ['status', 'player_status', 'state'],
  lastActivity: ['last_activity', 'last_seen', 'last_active_at', 'last_login_at'],
  createdAt: ['created_at', 'registered_at'],
  updatedAt: ['updated_at'],
  coinBalance: ['coin_balance', 'coins', 'coin', 'balance_coin', 'available_coins'],
  cashBalance: ['cash_balance', 'cash', 'balance_cash', 'available_cash'],
  nprBalance: ['npr_balance', 'cash_box_balance', 'cashbox_balance', 'npr', 'cash_box'],
  gameUsername: ['game_username', 'username', 'login', 'game_login'],
  gameName: ['game_name', 'game', 'game_title', 'game_id']
};

function pickColumn(columns, candidates) {
  for (const name of candidates) {
    if (columns.has(name)) return name;
  }
  return null;
}

async function tableColumns(pool, tableName) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return new Set(result.rows.map((row) => row.column_name));
}

async function findExistingTable(pool, candidates) {
  if (!candidates.length) return null;
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
  `, [candidates]);
  const found = new Set(result.rows.map((row) => row.table_name));
  return candidates.find((name) => found.has(name)) || null;
}

export async function discoverAppBegSchema(pool) {
  const playersTable = await findExistingTable(pool, PLAYER_TABLE_CANDIDATES);
  if (!playersTable) {
    throw new Error('AppBeg database is missing a players table (expected players_cache or players).');
  }

  const balancesTable = await findExistingTable(pool, BALANCE_TABLE_CANDIDATES);
  const gamesTable = await findExistingTable(pool, GAME_TABLE_CANDIDATES);

  const playerColumns = await tableColumns(pool, playersTable);
  const balanceColumns = balancesTable ? await tableColumns(pool, balancesTable) : new Set();
  const gameColumns = gamesTable ? await tableColumns(pool, gamesTable) : new Set();

  const playerId = pickColumn(playerColumns, COLUMN_CANDIDATES.playerId);
  if (!playerId) {
    throw new Error(`Could not resolve a player id column on ${playersTable}.`);
  }

  const balancePlayerId = balancesTable
    ? pickColumn(balanceColumns, COLUMN_CANDIDATES.playerId)
    : null;

  const gamePlayerId = gamesTable
    ? pickColumn(gameColumns, COLUMN_CANDIDATES.playerId)
    : null;

  return {
    playersTable,
    balancesTable,
    gamesTable,
    columns: {
      playerId,
      displayName: pickColumn(playerColumns, COLUMN_CANDIDATES.displayName),
      username: pickColumn(playerColumns, COLUMN_CANDIDATES.username),
      playerUid: pickColumn(playerColumns, COLUMN_CANDIDATES.playerUid) || playerId,
      coadmin: pickColumn(playerColumns, COLUMN_CANDIDATES.coadmin),
      createdBy: pickColumn(playerColumns, COLUMN_CANDIDATES.createdBy),
      source: pickColumn(playerColumns, COLUMN_CANDIDATES.source),
      status: pickColumn(playerColumns, COLUMN_CANDIDATES.status),
      lastActivity: pickColumn(playerColumns, COLUMN_CANDIDATES.lastActivity),
      createdAt: pickColumn(playerColumns, COLUMN_CANDIDATES.createdAt),
      updatedAt: pickColumn(playerColumns, COLUMN_CANDIDATES.updatedAt),
      balancePlayerId,
      coinBalance: pickColumn(balanceColumns, COLUMN_CANDIDATES.coinBalance),
      cashBalance: pickColumn(balanceColumns, COLUMN_CANDIDATES.cashBalance),
      nprBalance: pickColumn(balanceColumns, COLUMN_CANDIDATES.nprBalance),
      gamePlayerId,
      gameUsername: pickColumn(gameColumns, COLUMN_CANDIDATES.gameUsername),
      gameName: pickColumn(gameColumns, COLUMN_CANDIDATES.gameName)
    }
  };
}

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
