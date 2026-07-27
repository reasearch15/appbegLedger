import pg from 'pg';
import { resolveAppBegDatabaseConfig } from './appbegConfig.js';

const { Pool } = pg;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CSV_ROWS = 5000;
const SORTABLE = new Set(['username', 'coin', 'cash', 'created_at', 'updated_at']);

const REQUIRED_COLUMNS = [
  'username',
  'email',
  'role',
  'status',
  'coadmin_uid',
  'created_by',
  'coin',
  'cash',
  'created_at',
  'updated_at',
  'source'
];

const OPTIONAL_COLUMNS = [
  { name: 'cash_box_npr', sqlType: 'numeric' },
  { name: 'promo_locked_coins', sqlType: 'numeric' },
  { name: 'referral_bonus_coins', sqlType: 'numeric' },
  { name: 'mirrored_at', sqlType: 'timestamptz' }
];

const UID_COLUMN_CANDIDATES = ['uid', 'firebase_id'];
const FINANCIAL_TABLE = 'financial_events_cache';
const FINANCIAL_COLUMN_CANDIDATES = {
  playerUid: ['player_uid', 'appbeg_player_uid', 'uid'],
  type: ['event_type', 'type'],
  amount: ['amount'],
  amountCents: ['amount_cents'],
  status: ['status'],
  activityAt: ['completed_at', 'created_at']
};
const FINANCIAL_DEDUPE_COLUMN_CANDIDATES = ['external_reference', 'idempotency_key'];
const FINANCIAL_IN_TYPES = ['deposit', 'recharge'];
const FINANCIAL_OUT_TYPES = ['cashout', 'redeem'];
const FINANCIAL_COMPLETED_STATUSES = ['completed'];
const FINANCIAL_QUERY_CHUNK_SIZE = 500;

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function colExpr(alias, columnName) {
  return `${alias}.${quoteIdent(columnName)}`;
}

async function loadPlayersCacheColumns(pool) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'players_cache'
    ORDER BY ordinal_position
  `);
  return new Set(result.rows.map((row) => row.column_name));
}

async function loadTableColumns(pool, tableName) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return new Set(result.rows.map((row) => row.column_name));
}

async function findExistingTable(pool, candidates) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
  `, [candidates]);
  const found = new Set(result.rows.map((row) => row.table_name));
  return candidates.find((name) => found.has(name)) || null;
}

function pickColumn(columns, candidates) {
  return candidates.find((name) => columns.has(name)) || null;
}

function buildQueryPlan(columns) {
  const uidColumn = UID_COLUMN_CANDIDATES.find((name) => columns.has(name));
  if (!uidColumn) {
    throw new Error('players_cache is missing a uid column (expected uid or firebase_id).');
  }

  const missingRequired = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missingRequired.length) {
    throw new Error(`players_cache is missing required columns: ${missingRequired.join(', ')}`);
  }

  const selectParts = [
    `${colExpr('p', uidColumn)} AS uid`,
    ...REQUIRED_COLUMNS.map((name) => colExpr('p', name))
  ];

  const optionalPresent = {};
  for (const optional of OPTIONAL_COLUMNS) {
    optionalPresent[optional.name] = columns.has(optional.name);
    selectParts.push(
      optionalPresent[optional.name]
        ? colExpr('p', optional.name)
        : `NULL::${optional.sqlType} AS ${quoteIdent(optional.name)}`
    );
  }

  return {
    columns,
    uidColumn,
    hasDeletedAt: columns.has('deleted_at'),
    optionalPresent,
    selectSql: selectParts.join(',\n      ')
  };
}

async function buildFinancialPlan(pool) {
  const table = await findExistingTable(pool, [FINANCIAL_TABLE]);
  if (!table) {
    return { configured: false, reason: 'AppBeg financial events cache table was not found.' };
  }

  const columns = await loadTableColumns(pool, table);
  const playerUid = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.playerUid);
  const type = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.type);
  const amountCents = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.amountCents);
  const amount = amountCents ? null : pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.amount);
  const status = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.status);
  const activityAt = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.activityAt);

  const missing = [];
  if (!playerUid) missing.push('player uid');
  if (!type) missing.push('event type');
  if (!amount && !amountCents) missing.push('amount');
  if (!status) missing.push('status');

  if (missing.length) {
    return {
      configured: false,
      reason: `AppBeg financial events cache is missing required ${missing.join(', ')} column(s).`
    };
  }

  return {
    configured: true,
    table,
    columns: {
      playerUid,
      type,
      amount,
      amountCents,
      status,
      activityAt,
      dedupe: pickColumn(columns, FINANCIAL_DEDUPE_COLUMN_CANDIDATES)
    }
  };
}

function toPublicPlayer(row) {
  return {
    id: row.uid,
    uid: row.uid ?? null,
    player_uid: row.uid ?? null,
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

function buildBaseWhere(plan, { showTestData = false } = {}) {
  const clauses = ["p.role = 'player'"];

  if (plan.hasDeletedAt) {
    clauses.push('p.deleted_at IS NULL');
  }

  if (!showTestData) {
    clauses.push(`(${colExpr('p', plan.uidColumn)} IS NULL OR ${colExpr('p', plan.uidColumn)}::text NOT LIKE 'codex_%')`);
    clauses.push("(p.username IS NULL OR p.username NOT LIKE 'codex_%')");
    clauses.push("(p.email IS NULL OR p.email NOT LIKE '%@example.test')");
    clauses.push("(p.source IS NULL OR p.source NOT LIKE 'codex_%')");
  }

  return clauses;
}

function buildWhere(plan, { query, status, coadmin, showTestData = false }) {
  const clauses = buildBaseWhere(plan, { showTestData });
  const params = [];
  let index = 1;

  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery) {
    const pattern = `%${trimmedQuery}%`;
    clauses.push(`(
      p.username ILIKE $${index}
      OR p.email ILIKE $${index}
      OR ${colExpr('p', plan.uidColumn)}::text ILIKE $${index}
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

function zeroFinancialRow(uid) {
  return {
    uid,
    total_in: 0,
    total_out: 0,
    net: 0,
    last_activity: null
  };
}

function normalizeFinancialRow(row) {
  const totalIn = Number(row?.total_in || 0);
  const totalOut = Number(row?.total_out || 0);
  return {
    uid: row?.uid == null ? null : String(row.uid),
    total_in: Number.isFinite(totalIn) ? totalIn : 0,
    total_out: Number.isFinite(totalOut) ? totalOut : 0,
    net: Number.isFinite(totalIn - totalOut) ? totalIn - totalOut : 0,
    last_activity: row?.last_activity || null
  };
}

function summarizeFinancialRows(rows) {
  const summary = rows.reduce((acc, row) => {
    acc.total_in += Number(row.total_in || 0);
    acc.total_out += Number(row.total_out || 0);
    if (row.last_activity && (!acc.last_activity || new Date(row.last_activity) > new Date(acc.last_activity))) {
      acc.last_activity = row.last_activity;
    }
    return acc;
  }, { total_in: 0, total_out: 0, net: 0, last_activity: null });
  summary.net = summary.total_in - summary.total_out;
  return summary;
}

function quotedList(values) {
  return values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ');
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

  let plan;
  let financialPlan;
  try {
    await pool.query('SELECT 1');
    const columns = await loadPlayersCacheColumns(pool);
    plan = buildQueryPlan(columns);
    financialPlan = await buildFinancialPlan(pool);
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

    const { whereSql, params, nextIndex } = buildWhere(plan, {
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
      ${plan.selectSql}
      ${baseFromSql()}
      ${whereSql}
      ORDER BY ${orderExpr} ${sortDir} NULLS LAST, ${colExpr('p', plan.uidColumn)} DESC
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
      showTestData: includeTestData,
      columns: {
        optional: plan.optionalPresent
      }
    };
  }

  async function getFilterOptions({ showTestData = false } = {}) {
    const includeTestData = showTestData === true || showTestData === 'true' || showTestData === '1';
    const { whereSql, params } = buildWhere(plan, { showTestData: includeTestData });

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

  async function getFinancialReportForPlayerUids(playerUids = []) {
    const uids = [...new Set((Array.isArray(playerUids) ? playerUids : [])
      .map((uid) => String(uid || '').trim())
      .filter(Boolean))];

    if (!financialPlan?.configured) {
      const players = uids.map(zeroFinancialRow);
      return {
        configured: false,
        reason: financialPlan?.reason || 'AppBeg financial reporting is not configured.',
        players,
        summary: summarizeFinancialRows(players)
      };
    }

    if (!uids.length) {
      return {
        configured: true,
        players: [],
        summary: summarizeFinancialRows([])
      };
    }

    const cols = financialPlan.columns;
    const amountExpr = cols.amountCents
      ? `(ABS(COALESCE(f.${quoteIdent(cols.amountCents)}, 0)::numeric) / 100.0)`
      : `ABS(COALESCE(f.${quoteIdent(cols.amount)}, 0)::numeric)`;
    const typeExpr = `LOWER(COALESCE(f.${quoteIdent(cols.type)}, '')::text)`;
    const statusExpr = `LOWER(COALESCE(f.${quoteIdent(cols.status)}, '')::text)`;
    const activityExpr = cols.activityAt ? `f.${quoteIdent(cols.activityAt)}::text` : 'NULL::text';
    const inTypes = quotedList(FINANCIAL_IN_TYPES);
    const outTypes = quotedList(FINANCIAL_OUT_TYPES);
    const completedStatuses = quotedList(FINANCIAL_COMPLETED_STATUSES);

    const dedupeKeyExpr = cols.dedupe
      ? `COALESCE(NULLIF(f.${quoteIdent(cols.dedupe)}::text, ''), f.ctid::text)`
      : 'f.ctid::text';

    const players = [];
    for (const chunk of chunkArray(uids, FINANCIAL_QUERY_CHUNK_SIZE)) {
      const result = await pool.query(`
      WITH requested(uid) AS (
        SELECT unnest($1::text[]) AS uid
      ),
      included AS (
        SELECT DISTINCT ON (f.${quoteIdent(cols.playerUid)}::text, ${typeExpr}, ${dedupeKeyExpr})
          f.${quoteIdent(cols.playerUid)}::text AS uid,
          ${typeExpr} AS event_type,
          ${amountExpr} AS amount,
          ${activityExpr} AS activity_at,
          ${dedupeKeyExpr} AS dedupe_key
        FROM ${quoteIdent(financialPlan.table)} f
        JOIN requested r ON f.${quoteIdent(cols.playerUid)}::text = r.uid
        WHERE ${statusExpr} IN (${completedStatuses})
          AND ${typeExpr} IN (${inTypes}, ${outTypes})
        ORDER BY f.${quoteIdent(cols.playerUid)}::text, ${typeExpr}, ${dedupeKeyExpr}, ${activityExpr} DESC NULLS LAST
      )
      SELECT
        r.uid,
        COALESCE(SUM(CASE WHEN i.event_type IN (${inTypes}) THEN i.amount ELSE 0 END), 0)::double precision AS total_in,
        COALESCE(SUM(CASE WHEN i.event_type IN (${outTypes}) THEN i.amount ELSE 0 END), 0)::double precision AS total_out,
        MAX(i.activity_at) AS last_activity
      FROM requested r
      LEFT JOIN included i ON i.uid = r.uid
      GROUP BY r.uid
    `, [chunk]);
      const byUid = new Map(result.rows.map((row) => [String(row.uid), normalizeFinancialRow(row)]));
      players.push(...chunk.map((uid) => byUid.get(uid) || zeroFinancialRow(uid)));
    }
    return {
      configured: true,
      source: financialPlan.table,
      players,
      summary: summarizeFinancialRows(players)
    };
  }

  async function getPlayerByUid(uid) {
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) return null;
    const { whereSql, params } = buildWhere(plan, {});
    const sql = `
      SELECT
      ${plan.selectSql}
      ${baseFromSql()}
      ${whereSql}
        AND ${colExpr('p', plan.uidColumn)}::text = $${params.length + 1}
      LIMIT 1
    `;
    const result = await pool.query(sql, [...params, normalizedUid]);
    return result.rows[0] ? toPublicPlayer(result.rows[0]) : null;
  }

  async function getPlayerByUsername(username) {
    const normalized = String(username || '').trim();
    if (!normalized) return null;
    const { whereSql, params } = buildWhere(plan, {});
    const sql = `
      SELECT
      ${plan.selectSql}
      ${baseFromSql()}
      ${whereSql}
        AND LOWER(${colExpr('p', 'username')}::text) = LOWER($${params.length + 1})
      LIMIT 1
    `;
    const result = await pool.query(sql, [...params, normalized]);
    return result.rows[0] ? toPublicPlayer(result.rows[0]) : null;
  }

  return {
    configured: true,
    plan,
    pool,
    listPlayers,
    getFilterOptions,
    getPlayerByUid,
    getPlayerByUsername,
    exportPlayersCsv,
    getFinancialReportForPlayerUids,
    async close() {
      await pool.end();
    }
  };
}
