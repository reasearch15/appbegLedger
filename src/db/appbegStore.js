import pg from 'pg';
import { resolveAppBegDatabaseConfig } from './appbegConfig.js';
import { discoverAppBegSchema, quoteIdent } from './appbegSchema.js';

const { Pool } = pg;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CSV_ROWS = 5000;
const SORTABLE = new Set(['created_at', 'updated_at', 'name', 'coin_balance', 'cash_balance', 'last_activity']);

function sqlExpr(tableAlias, columnName, fallback = 'NULL') {
  return columnName ? `${tableAlias}.${quoteIdent(columnName)}` : fallback;
}

function toPublicPlayer(row) {
  return {
    id: row.player_row_id,
    display_name: row.display_name ?? null,
    player_uid: row.player_uid ?? null,
    username: row.username ?? null,
    coadmin: row.coadmin ?? null,
    created_by: row.created_by ?? null,
    source: row.source ?? null,
    coin_balance: row.coin_balance ?? null,
    cash_balance: row.cash_balance ?? null,
    npr_balance: row.npr_balance ?? null,
    game_usernames: row.game_usernames ?? null,
    game_names: row.game_names ?? null,
    status: row.status ?? null,
    last_activity: row.last_activity ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null
  };
}

function buildSelectParts(schema) {
  const { playersTable, balancesTable, gamesTable, columns: c } = schema;
  const p = 'p';
  const select = [
    `${sqlExpr(p, c.playerId)} AS player_row_id`,
    `${sqlExpr(p, c.displayName)} AS display_name`,
    `${sqlExpr(p, c.playerUid)} AS player_uid`,
    `${sqlExpr(p, c.username)} AS username`,
    `${sqlExpr(p, c.coadmin)} AS coadmin`,
    `${sqlExpr(p, c.createdBy)} AS created_by`,
    `${sqlExpr(p, c.source)} AS source`,
    `${sqlExpr(p, c.status)} AS status`,
    `${sqlExpr(p, c.lastActivity)} AS last_activity`,
    `${sqlExpr(p, c.createdAt)} AS created_at`,
    `${sqlExpr(p, c.updatedAt)} AS updated_at`
  ];

  if (balancesTable && c.balancePlayerId) {
    const b = 'b';
    select.push(`${sqlExpr(b, c.coinBalance)} AS coin_balance`);
    select.push(`${sqlExpr(b, c.cashBalance)} AS cash_balance`);
    select.push(`${sqlExpr(b, c.nprBalance)} AS npr_balance`);
  } else {
    select.push('NULL::text AS coin_balance', 'NULL::text AS cash_balance', 'NULL::text AS npr_balance');
  }

  if (gamesTable && c.gamePlayerId && c.gameUsername) {
    select.push('gl.game_usernames');
    select.push('gl.game_names');
  } else {
    select.push('NULL::text AS game_usernames', 'NULL::text AS game_names');
  }

  let fromSql = `FROM ${quoteIdent(playersTable)} ${p}`;
  const joins = [];

  if (balancesTable && c.balancePlayerId) {
    joins.push(`
      LEFT JOIN ${quoteIdent(balancesTable)} b
        ON ${sqlExpr('b', c.balancePlayerId)}::text = ${sqlExpr(p, c.playerId)}::text
    `);
  }

  if (gamesTable && c.gamePlayerId && c.gameUsername) {
    const gameNameExpr = c.gameName
      ? `string_agg(DISTINCT ${sqlExpr('g', c.gameName)}::text, ', ' ORDER BY ${sqlExpr('g', c.gameName)}::text)`
      : 'NULL::text';
    joins.push(`
      LEFT JOIN LATERAL (
        SELECT
          string_agg(DISTINCT ${sqlExpr('g', c.gameUsername)}::text, ', ' ORDER BY ${sqlExpr('g', c.gameUsername)}::text) AS game_usernames,
          ${gameNameExpr} AS game_names
        FROM ${quoteIdent(gamesTable)} g
        WHERE ${sqlExpr('g', c.gamePlayerId)}::text = ${sqlExpr(p, c.playerId)}::text
      ) gl ON TRUE
    `);
  }

  return { selectSql: select.join(',\n      '), fromSql, joinsSql: joins.join('\n') };
}

function resolveSort(schema, sortBy) {
  const { columns: c } = schema;
  switch (sortBy) {
    case 'name':
      return c.displayName ? sqlExpr('p', c.displayName) : sqlExpr('p', c.playerId);
    case 'coin_balance':
      return c.coinBalance ? sqlExpr('b', c.coinBalance) : (c.createdAt ? sqlExpr('p', c.createdAt) : sqlExpr('p', c.playerId));
    case 'cash_balance':
      return c.cashBalance ? sqlExpr('b', c.cashBalance) : (c.createdAt ? sqlExpr('p', c.createdAt) : sqlExpr('p', c.playerId));
    case 'updated_at':
      return c.updatedAt ? sqlExpr('p', c.updatedAt) : (c.createdAt ? sqlExpr('p', c.createdAt) : sqlExpr('p', c.playerId));
    case 'last_activity':
      return c.lastActivity ? sqlExpr('p', c.lastActivity) : (c.updatedAt ? sqlExpr('p', c.updatedAt) : sqlExpr('p', c.playerId));
    case 'created_at':
    default:
      return c.createdAt ? sqlExpr('p', c.createdAt) : sqlExpr('p', c.playerId);
  }
}

function buildWhere(schema, { query, status, coadmin }) {
  const clauses = [];
  const params = [];
  let index = 1;

  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery) {
    const searchParts = [];
    const { columns: c } = schema;
    const pattern = `%${trimmedQuery}%`;
    if (c.displayName) {
      searchParts.push(`${sqlExpr('p', c.displayName)}::text ILIKE $${index}`);
      params.push(pattern);
      index += 1;
    }
    if (c.username) {
      searchParts.push(`${sqlExpr('p', c.username)}::text ILIKE $${index}`);
      params.push(pattern);
      index += 1;
    }
    if (c.playerUid) {
      searchParts.push(`${sqlExpr('p', c.playerUid)}::text ILIKE $${index}`);
      params.push(pattern);
      index += 1;
    }
    if (c.playerId && c.playerId !== c.playerUid) {
      searchParts.push(`${sqlExpr('p', c.playerId)}::text ILIKE $${index}`);
      params.push(pattern);
      index += 1;
    }
    if (schema.gamesTable && c.gamePlayerId && c.gameUsername) {
      searchParts.push(`EXISTS (
        SELECT 1
        FROM ${quoteIdent(schema.gamesTable)} sg
        WHERE ${sqlExpr('sg', c.gamePlayerId)}::text = ${sqlExpr('p', c.playerId)}::text
          AND ${sqlExpr('sg', c.gameUsername)}::text ILIKE $${index}
      )`);
      params.push(pattern);
      index += 1;
    }
    if (searchParts.length) clauses.push(`(${searchParts.join(' OR ')})`);
  }

  if (status && schema.columns.status) {
    clauses.push(`${sqlExpr('p', schema.columns.status)}::text = $${index}`);
    params.push(status);
    index += 1;
  }

  if (coadmin && schema.columns.coadmin) {
    clauses.push(`${sqlExpr('p', schema.columns.coadmin)}::text = $${index}`);
    params.push(coadmin);
    index += 1;
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    nextIndex: index
  };
}

export async function createAppBegStore(env = process.env) {
  const config = resolveAppBegDatabaseConfig(env);
  if (!config.configured) {
    return {
      configured: false,
      async listPlayers() {
        const error = new Error('AppBeg database is not configured.');
        error.code = 'APPBEG_NOT_CONFIGURED';
        throw error;
      },
      async getFilterOptions() {
        const error = new Error('AppBeg database is not configured.');
        error.code = 'APPBEG_NOT_CONFIGURED';
        throw error;
      }
    };
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: Number(env.APPBEG_DATABASE_POOL_SIZE || 5),
    ssl: config.ssl
  });

  let schema;
  try {
    await pool.query('SELECT 1');
    schema = await discoverAppBegSchema(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  const queryParts = buildSelectParts(schema);

  async function listPlayers({
    page = 1,
    limit = DEFAULT_LIMIT,
    query = '',
    sort = 'created_at',
    dir = 'desc',
    status = '',
    coadmin = ''
  } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const sortBy = SORTABLE.has(sort) ? sort : 'created_at';
    const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = (safePage - 1) * safeLimit;

    const { whereSql, params, nextIndex } = buildWhere(schema, { query, status, coadmin });
    const orderExpr = resolveSort(schema, sortBy);

    const countSql = `
      SELECT COUNT(*)::int AS total
      ${queryParts.fromSql}
      ${queryParts.joinsSql}
      ${whereSql}
    `;
    const countResult = await pool.query(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    const dataSql = `
      SELECT
      ${queryParts.selectSql}
      ${queryParts.fromSql}
      ${queryParts.joinsSql}
      ${whereSql}
      ORDER BY ${orderExpr} ${sortDir} NULLS LAST, ${sqlExpr('p', schema.columns.playerId)} DESC
      LIMIT $${nextIndex}
      OFFSET $${nextIndex + 1}
    `;
    const dataParams = [...params, safeLimit, offset];
    const dataResult = await pool.query(dataSql, dataParams);

    return {
      players: dataResult.rows.map(toPublicPlayer),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      },
      sort: { by: sortBy, dir: sortDir.toLowerCase() }
    };
  }

  async function getFilterOptions() {
    const { columns: c } = schema;
    const statuses = c.status
      ? (await pool.query(`
          SELECT DISTINCT ${sqlExpr('p', c.status)}::text AS value
          FROM ${quoteIdent(schema.playersTable)} p
          WHERE ${sqlExpr('p', c.status)} IS NOT NULL
          ORDER BY 1
        `)).rows.map((row) => row.value).filter(Boolean)
      : [];
    const coadmins = c.coadmin
      ? (await pool.query(`
          SELECT DISTINCT ${sqlExpr('p', c.coadmin)}::text AS value
          FROM ${quoteIdent(schema.playersTable)} p
          WHERE ${sqlExpr('p', c.coadmin)} IS NOT NULL
          ORDER BY 1
        `)).rows.map((row) => row.value).filter(Boolean)
      : [];
    return { statuses, coadmins };
  }

  async function exportPlayersCsv(options = {}) {
    const result = await listPlayers({
      ...options,
      page: 1,
      limit: MAX_CSV_ROWS
    });
    return result.players;
  }

  return {
    configured: true,
    schema,
    pool,
    listPlayers,
    getFilterOptions,
    exportPlayersCsv,
    async close() {
      await pool.end();
    }
  };
}
