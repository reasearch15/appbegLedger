import pg from 'pg';
import { resolveAppBegDatabaseConfig } from './appbegConfig.js';

const { Pool } = pg;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CSV_ROWS = 5000;
const SORTABLE = new Set(['username', 'coin', 'cash', 'created_at', 'updated_at']);

const SELECT_SQL = `
  p.firebase_id AS player_uid,
  p.firebase_id,
  p.username,
  p.email,
  p.role,
  p.status,
  p.coadmin_uid,
  p.created_by,
  p.coin,
  p.cash,
  p.cash_box_npr,
  p.promo_locked_coins,
  p.referral_bonus_coins,
  p.source,
  p.created_at,
  p.updated_at,
  p.mirrored_at,
  p.deleted_at
`;

function toPublicPlayer(row) {
  return {
    id: row.firebase_id || row.player_uid,
    player_uid: row.player_uid ?? null,
    firebase_id: row.firebase_id ?? null,
    username: row.username ?? null,
    email: row.email ?? null,
    role: row.role ?? null,
    status: row.status ?? null,
    coadmin_uid: row.coadmin_uid ?? null,
    created_by: row.created_by ?? null,
    coin: row.coin ?? null,
    cash: row.cash ?? null,
    cash_box_npr: row.cash_box_npr ?? null,
    promo_locked_coins: row.promo_locked_coins ?? null,
    referral_bonus_coins: row.referral_bonus_coins ?? null,
    source: row.source ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    mirrored_at: row.mirrored_at ?? null
  };
}

function resolveSort(sortBy) {
  switch (sortBy) {
    case 'username':
      return 'p.username';
    case 'coin':
      return 'p.coin';
    case 'cash':
      return 'p.cash';
    case 'updated_at':
      return 'p.updated_at';
    case 'created_at':
    default:
      return 'p.created_at';
  }
}

function buildBaseWhere({ showTestData = false } = {}) {
  const clauses = [
    "p.role = 'player'",
    'p.deleted_at IS NULL'
  ];

  if (!showTestData) {
    clauses.push("(p.firebase_id IS NULL OR p.firebase_id NOT LIKE 'codex_%')");
    clauses.push("(p.username IS NULL OR p.username NOT LIKE 'codex_%')");
    clauses.push("(p.email IS NULL OR p.email NOT LIKE '%@example.test')");
    clauses.push("(p.source IS NULL OR p.source NOT LIKE 'codex_%')");
  }

  return clauses;
}

function buildWhere({ query, status, coadmin, showTestData = false }) {
  const clauses = buildBaseWhere({ showTestData });
  const params = [];
  let index = 1;

  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery) {
    const pattern = `%${trimmedQuery}%`;
    clauses.push(`(
      p.username ILIKE $${index}
      OR p.email ILIKE $${index}
      OR p.firebase_id ILIKE $${index}
      OR p.coadmin_uid ILIKE $${index}
      OR p.created_by ILIKE $${index}
    )`);
    params.push(pattern);
    index += 1;
  }

  if (status) {
    clauses.push(`p.status = $${index}`);
    params.push(status);
    index += 1;
  }

  if (coadmin) {
    clauses.push(`p.coadmin_uid = $${index}`);
    params.push(coadmin);
    index += 1;
  }

  return {
    whereSql: `WHERE ${clauses.join(' AND ')}`,
    params,
    nextIndex: index
  };
}

function baseFromSql() {
  return 'FROM players_cache p';
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

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  async function listPlayers({
    page = 1,
    limit = DEFAULT_LIMIT,
    query = '',
    sort = 'created_at',
    dir = 'desc',
    status = '',
    coadmin = '',
    showTestData = false
  } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const sortBy = SORTABLE.has(sort) ? sort : 'created_at';
    const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = (safePage - 1) * safeLimit;
    const includeTestData = showTestData === true || showTestData === 'true' || showTestData === '1';

    const { whereSql, params, nextIndex } = buildWhere({
      query,
      status,
      coadmin,
      showTestData: includeTestData
    });
    const orderExpr = resolveSort(sortBy);

    const countSql = `
      SELECT COUNT(*)::int AS total
      ${baseFromSql()}
      ${whereSql}
    `;
    const countResult = await pool.query(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    const dataSql = `
      SELECT
      ${SELECT_SQL}
      ${baseFromSql()}
      ${whereSql}
      ORDER BY ${orderExpr} ${sortDir} NULLS LAST, p.firebase_id DESC
      LIMIT $${nextIndex}
      OFFSET $${nextIndex + 1}
    `;
    const dataResult = await pool.query(dataSql, [...params, safeLimit, offset]);

    return {
      players: dataResult.rows.map(toPublicPlayer),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      },
      sort: { by: sortBy, dir: sortDir.toLowerCase() },
      showTestData: includeTestData
    };
  }

  async function getFilterOptions({ showTestData = false } = {}) {
    const includeTestData = showTestData === true || showTestData === 'true' || showTestData === '1';
    const { whereSql, params } = buildWhere({ showTestData: includeTestData });

    const statuses = (await pool.query(`
      SELECT DISTINCT p.status::text AS value
      ${baseFromSql()}
      ${whereSql}
        AND p.status IS NOT NULL
      ORDER BY 1
    `, params)).rows.map((row) => row.value).filter(Boolean);

    const coadmins = (await pool.query(`
      SELECT DISTINCT p.coadmin_uid::text AS value
      ${baseFromSql()}
      ${whereSql}
        AND p.coadmin_uid IS NOT NULL
        AND p.coadmin_uid <> ''
      ORDER BY 1
    `, params)).rows.map((row) => row.value).filter(Boolean);

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
    pool,
    listPlayers,
    getFilterOptions,
    exportPlayersCsv,
    async close() {
      await pool.end();
    }
  };
}
