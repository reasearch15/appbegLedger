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
  amount: ['amount_npr', 'amountNpr', 'amount'],
  amountCents: ['amount_cents'],
  status: ['status', 'event_status', 'state'],
  activityAt: ['completed_at', 'created_at', 'createdAt'],
  source: ['source'],
  sourceFlow: ['source_flow', 'sourceFlow'],
  paymentEventId: ['payment_event_id', 'paymentEventId'],
  actorUid: ['actor_uid', 'actorUid'],
  actorRole: ['actor_role', 'actorRole'],
  cashoutTaskId: ['cashout_task_id', 'cashoutTaskId'],
  requestId: ['request_id', 'requestId'],
  firebaseId: ['firebase_id'],
  reversedAt: ['reversed_at', 'reversedAt'],
  refundedAt: ['refunded_at', 'refundedAt'],
  deletedAt: ['deleted_at', 'deletedAt'],
  meta: ['meta']
};
const FINANCIAL_DEDUPE_COLUMN_CANDIDATES = ['external_reference', 'externalReference', 'idempotency_key', 'payment_event_id', 'paymentEventId', 'firebase_id', 'id'];
const FINANCIAL_IN_TYPES = ['deposit', 'recharge'];
const FINANCIAL_OUT_TYPES = ['cashout', 'redeem'];
const FINANCIAL_LEDGER_CREDIT_TYPES = ['coadmin_coin_add', 'ledger_deposit_credit'];
const FINANCIAL_LEDGER_SOURCE_FLOWS = ['registration_initial_deposit', 'registered_user_deposit'];
const FINANCIAL_COMPLETED_STATUSES = ['completed'];
const FINANCIAL_QUERY_CHUNK_SIZE = 500;
const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Kathmandu';

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

function logFinancialTrace(event, metadata = {}) {
  console.log('[appbeg-financial]', JSON.stringify({ event, ...metadata }));
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
    logFinancialTrace('financial_cache_schema_validation', {
      configured: false,
      reason: 'table_missing',
      table: FINANCIAL_TABLE
    });
    return { configured: false, reason: 'AppBeg financial events cache table was not found.' };
  }

  const columns = await loadTableColumns(pool, table);
  const playerUid = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.playerUid);
  const type = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.type);
  const amountCents = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.amountCents);
  const amount = amountCents ? null : pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.amount);
  const status = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.status);
  const activityAt = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.activityAt);
  const source = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.source);
  const sourceFlow = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.sourceFlow);
  const paymentEventId = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.paymentEventId);
  const actorUid = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.actorUid);
  const actorRole = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.actorRole);
  const cashoutTaskId = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.cashoutTaskId);
  const requestId = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.requestId);
  const firebaseId = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.firebaseId);
  const reversedAt = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.reversedAt);
  const refundedAt = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.refundedAt);
  const deletedAt = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.deletedAt);
  const meta = pickColumn(columns, FINANCIAL_COLUMN_CANDIDATES.meta);

  const missing = [];
  if (!playerUid) missing.push('player uid');
  if (!type) missing.push('event type');
  if (!amount && !amountCents) missing.push('amount');

  if (missing.length) {
    logFinancialTrace('financial_cache_schema_validation', {
      configured: false,
      table,
      missing_columns: missing,
      present_columns: columns.size
    });
    return {
      configured: false,
      reason: `AppBeg financial events cache is missing required ${missing.join(', ')} column(s).`
    };
  }

  logFinancialTrace('financial_cache_schema_validation', {
    configured: true,
    table,
    columns: {
      player_uid: playerUid,
      type,
      amount: amountCents || amount,
      status: status || null,
      activity_at: activityAt || null,
      source: source || null,
      source_flow: sourceFlow || null,
      payment_event_id: paymentEventId || null,
      actor_uid: actorUid || null,
      actor_role: actorRole || null,
      cashout_task_id: cashoutTaskId || null,
      request_id: requestId || null,
      firebase_id: firebaseId || null,
      reversed_at: reversedAt || null,
      refunded_at: refundedAt || null,
      deleted_at: deletedAt || null,
      meta: meta || null,
      dedupe: pickColumn(columns, FINANCIAL_DEDUPE_COLUMN_CANDIDATES) || null
    },
    status_required: false
  });

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
      source,
      sourceFlow,
      paymentEventId,
      actorUid,
      actorRole,
      cashoutTaskId,
      requestId,
      firebaseId,
      reversedAt,
      refundedAt,
      deletedAt,
      meta,
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
    last_activity: null,
    active_today: false
  };
}

function summarizeFinancialRows(rows) {
  const summary = rows.reduce((acc, row) => {
    acc.total_in += Number(row.total_in || 0);
    acc.total_out += Number(row.total_out || 0);
    if (row.last_activity && (!acc.last_activity || new Date(row.last_activity) > new Date(acc.last_activity))) {
      acc.last_activity = row.last_activity;
    }
    if (row.active_today) {
      acc.active_today = true;
    }
    return acc;
  }, { total_in: 0, total_out: 0, net: 0, last_activity: null, active_today: false });
  summary.net = summary.total_in - summary.total_out;
  return summary;
}

function parseActivityInstant(value, timeZone) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/(Z|[+-][0-9]{2}:?[0-9]{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    return zonedWallTimeToUtc({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] || 0),
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0)
    }, timeZone);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isCompletedFinancialEvent(row) {
  const status = String(row.status || '').trim().toLowerCase();
  return !status || FINANCIAL_COMPLETED_STATUSES.includes(status);
}

function metaValue(row, key) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return String(row?.[`meta_${key}`] ?? meta[key] ?? '').trim();
}

function isLedgerCreditIn(row) {
  const type = String(row.event_type || '').trim().toLowerCase();
  if (!FINANCIAL_LEDGER_CREDIT_TYPES.includes(type)) return false;
  const source = String(row.source || '').trim().toLowerCase();
  if (source === 'authority_ledger_deposit_credit') return true;
  const actorUid = String(row.actor_uid || '').trim().toLowerCase();
  const actorRole = String(row.actor_role || '').trim().toLowerCase();
  if (actorUid === 'appbeg_ledger' && actorRole === 'ledger') return true;
  const sourceFlow = String(row.source_flow || metaValue(row, 'sourceFlow')).trim().toLowerCase();
  const metaPaymentEventId = metaValue(row, 'paymentEventId');
  const metaExternalReference = metaValue(row, 'externalReference');
  if (FINANCIAL_LEDGER_SOURCE_FLOWS.includes(sourceFlow) && (metaPaymentEventId || metaExternalReference)) return true;
  if (type === 'ledger_deposit_credit') return false;
  if (FINANCIAL_LEDGER_SOURCE_FLOWS.includes(sourceFlow)) return true;
  const paymentEventId = String(row.payment_event_id || '').trim();
  const dedupeKey = String(row.dedupe_key || '').trim();
  return source === 'appbeg_ledger'
    && (Boolean(paymentEventId) || dedupeKey.startsWith('appbegledger-payment-event:'));
}

function hasCashoutReversalEvidence(row) {
  return Boolean(
    String(row.reversed_at || '').trim()
    || String(row.refunded_at || '').trim()
    || String(row.deleted_at || '').trim()
    || metaValue(row, 'reversedAt')
    || metaValue(row, 'refundedAt')
    || metaValue(row, 'deletedAt')
  );
}

function cashoutReference(row) {
  return String(row.cashout_task_id || '').trim()
    || metaValue(row, 'cashoutTaskId')
    || String(row.request_id || '').trim()
    || metaValue(row, 'requestId');
}

function isFinalCashoutOut(row) {
  const type = String(row.event_type || '').trim().toLowerCase();
  if (type !== 'cashout') return false;
  if (hasCashoutReversalEvidence(row)) return false;
  return Boolean(cashoutReference(row));
}

function financialDedupeKey(row, fallback) {
  return cashoutReference(row)
    || metaValue(row, 'externalReference')
    || metaValue(row, 'paymentEventId')
    || String(row.firebase_id || '').trim()
    || String(row.dedupe_key || '').trim()
    || fallback;
}

function aggregateFinancialEventsForUids(uids, rows, { activeBounds, timeZone } = {}) {
  const byUid = new Map(uids.map((uid) => [uid, zeroFinancialRow(uid)]));
  const seen = new Set();
  const counts = {
    scanned: rows.length,
    included: 0,
    excluded_status: 0,
    excluded_type: 0,
    deduped: 0
  };

  for (const row of rows) {
    const uid = String(row.uid || '').trim();
    if (!byUid.has(uid)) continue;
    const type = String(row.event_type || '').trim().toLowerCase();
    if (!isCompletedFinancialEvent(row)) {
      counts.excluded_status += 1;
      continue;
    }
    const isIn = FINANCIAL_IN_TYPES.includes(type) || isLedgerCreditIn(row);
    const isOut = type === 'cashout'
      ? isFinalCashoutOut(row)
      : FINANCIAL_OUT_TYPES.includes(type);
    if (!isIn && !isOut) {
      counts.excluded_type += 1;
      continue;
    }
    const dedupeKey = financialDedupeKey(row, `row-${counts.scanned}-${counts.included}`);
    const key = `${uid}:${type}:${dedupeKey}`;
    if (seen.has(key)) {
      counts.deduped += 1;
      continue;
    }
    seen.add(key);

    const player = byUid.get(uid);
    const amount = Math.abs(Number(row.amount_npr ?? row.amountNpr ?? row.amount ?? 0));
    if (Number.isFinite(amount)) {
      if (isIn) player.total_in += amount;
      if (isOut) player.total_out += amount;
    }
    const activity = parseActivityInstant(row.activity_at, timeZone);
    if (activity) {
      const iso = activity.toISOString();
      if (!player.last_activity || activity > new Date(player.last_activity)) {
        player.last_activity = iso;
      }
      if (activeBounds && activity >= activeBounds.start && activity < activeBounds.end) {
        player.active_today = true;
      }
    }
    player.net = player.total_in - player.total_out;
    counts.included += 1;
  }

  return { players: uids.map((uid) => byUid.get(uid) || zeroFinancialRow(uid)), counts };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function timeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function timeZoneOffsetMs(timeZone, date) {
  const parts = timeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedWallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - timeZoneOffsetMs(timeZone, new Date(utcMs));
  }
  return new Date(utcMs);
}

function businessDayBounds(now = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  let safeZone = String(timeZone || DEFAULT_BUSINESS_TIME_ZONE);
  let parts;
  try {
    parts = timeZoneParts(now, safeZone);
  } catch (_error) {
    safeZone = DEFAULT_BUSINESS_TIME_ZONE;
    parts = timeZoneParts(now, DEFAULT_BUSINESS_TIME_ZONE);
  }
  const start = zonedWallTimeToUtc(parts, safeZone);
  const end = zonedWallTimeToUtc({ ...parts, day: parts.day + 1 }, safeZone);
  return {
    timeZone: safeZone,
    start,
    end
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

  async function getFinancialReportForPlayerUids(playerUids = [], {
    today = new Date(),
    timeZone = env.VENDOR_DASHBOARD_TIME_ZONE || env.TZ || DEFAULT_BUSINESS_TIME_ZONE
  } = {}) {
    const uids = [...new Set((Array.isArray(playerUids) ? playerUids : [])
      .map((uid) => String(uid || '').trim())
      .filter(Boolean))];

    if (!financialPlan?.configured) {
      const players = uids.map(zeroFinancialRow);
      logFinancialTrace('vendor_totals_query', {
        configured: false,
        requested_players: uids.length,
        reason: financialPlan?.reason || 'AppBeg financial reporting is not configured.'
      });
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
    const activityExpr = cols.activityAt ? `f.${quoteIdent(cols.activityAt)}::text` : 'NULL::text';
    const statusExpr = cols.status ? `f.${quoteIdent(cols.status)}::text` : 'NULL::text';
    const sourceExpr = cols.source ? `f.${quoteIdent(cols.source)}::text` : 'NULL::text';
    const sourceFlowExpr = cols.sourceFlow ? `f.${quoteIdent(cols.sourceFlow)}::text` : 'NULL::text';
    const paymentEventExpr = cols.paymentEventId ? `f.${quoteIdent(cols.paymentEventId)}::text` : 'NULL::text';
    const actorUidExpr = cols.actorUid ? `f.${quoteIdent(cols.actorUid)}::text` : 'NULL::text';
    const actorRoleExpr = cols.actorRole ? `f.${quoteIdent(cols.actorRole)}::text` : 'NULL::text';
    const cashoutTaskExpr = cols.cashoutTaskId ? `f.${quoteIdent(cols.cashoutTaskId)}::text` : 'NULL::text';
    const requestIdExpr = cols.requestId ? `f.${quoteIdent(cols.requestId)}::text` : 'NULL::text';
    const firebaseIdExpr = cols.firebaseId ? `f.${quoteIdent(cols.firebaseId)}::text` : 'NULL::text';
    const reversedAtExpr = cols.reversedAt ? `f.${quoteIdent(cols.reversedAt)}::text` : 'NULL::text';
    const refundedAtExpr = cols.refundedAt ? `f.${quoteIdent(cols.refundedAt)}::text` : 'NULL::text';
    const deletedAtExpr = cols.deletedAt ? `f.${quoteIdent(cols.deletedAt)}::text` : 'NULL::text';
    const metaExpr = cols.meta ? `f.${quoteIdent(cols.meta)}` : 'NULL::jsonb';
    const metaSourceFlowExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'sourceFlow'` : 'NULL::text';
    const metaPaymentEventExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'paymentEventId'` : 'NULL::text';
    const metaExternalRefExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'externalReference'` : 'NULL::text';
    const metaCashoutTaskExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'cashoutTaskId'` : 'NULL::text';
    const metaRequestIdExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'requestId'` : 'NULL::text';
    const metaReversedAtExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'reversedAt'` : 'NULL::text';
    const metaRefundedAtExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'refundedAt'` : 'NULL::text';
    const metaDeletedAtExpr = cols.meta ? `f.${quoteIdent(cols.meta)} ->> 'deletedAt'` : 'NULL::text';
    const dedupeTextExpr = cols.dedupe ? `NULLIF(f.${quoteIdent(cols.dedupe)}::text, '')` : 'NULL::text';
    const activeDay = Number.isNaN(new Date(today).getTime()) ? new Date() : new Date(today);
    const activeBounds = businessDayBounds(activeDay, timeZone);

    const dedupeKeyExpr = `COALESCE(NULLIF(${cashoutTaskExpr}, ''), NULLIF(${metaCashoutTaskExpr}, ''), NULLIF(${requestIdExpr}, ''), NULLIF(${metaRequestIdExpr}, ''), NULLIF(${metaExternalRefExpr}, ''), NULLIF(${metaPaymentEventExpr}, ''), NULLIF(${firebaseIdExpr}, ''), ${dedupeTextExpr}, ${paymentEventExpr}, f.ctid::text)`;
    logFinancialTrace('vendor_totals_query', {
      configured: true,
      source: financialPlan.table,
      requested_players: uids.length,
      status_column: cols.status || null,
      source_flow_column: cols.sourceFlow || null,
      meta_column: cols.meta || null
    });

    const players = [];
    const totalsCounts = {
      scanned: 0,
      included: 0,
      excluded_status: 0,
      excluded_type: 0,
      deduped: 0
    };
    for (const chunk of chunkArray(uids, FINANCIAL_QUERY_CHUNK_SIZE)) {
      const result = await pool.query(`
      WITH requested(uid) AS (
        SELECT unnest($1::text[]) AS uid
      )
      SELECT
          f.${quoteIdent(cols.playerUid)}::text AS uid,
          LOWER(COALESCE(f.${quoteIdent(cols.type)}, '')::text) AS event_type,
          ${amountExpr} AS amount,
          ${statusExpr} AS status,
          ${activityExpr} AS activity_at,
          ${sourceExpr} AS source,
          ${sourceFlowExpr} AS source_flow,
          ${paymentEventExpr} AS payment_event_id,
          ${actorUidExpr} AS actor_uid,
          ${actorRoleExpr} AS actor_role,
          ${cashoutTaskExpr} AS cashout_task_id,
          ${requestIdExpr} AS request_id,
          ${firebaseIdExpr} AS firebase_id,
          ${reversedAtExpr} AS reversed_at,
          ${refundedAtExpr} AS refunded_at,
          ${deletedAtExpr} AS deleted_at,
          ${metaExpr} AS meta,
          ${metaSourceFlowExpr} AS "meta_sourceFlow",
          ${metaPaymentEventExpr} AS "meta_paymentEventId",
          ${metaExternalRefExpr} AS "meta_externalReference",
          ${metaCashoutTaskExpr} AS "meta_cashoutTaskId",
          ${metaRequestIdExpr} AS "meta_requestId",
          ${metaReversedAtExpr} AS "meta_reversedAt",
          ${metaRefundedAtExpr} AS "meta_refundedAt",
          ${metaDeletedAtExpr} AS "meta_deletedAt",
          ${dedupeKeyExpr} AS dedupe_key
        FROM ${quoteIdent(financialPlan.table)} f
        JOIN requested r ON f.${quoteIdent(cols.playerUid)}::text = r.uid
    `, [chunk]);
      const chunkReport = aggregateFinancialEventsForUids(chunk, result.rows, {
        activeBounds,
        timeZone: activeBounds.timeZone
      });
      for (const key of Object.keys(totalsCounts)) {
        totalsCounts[key] += Number(chunkReport.counts[key] || 0);
      }
      players.push(...chunkReport.players);
    }
    const summary = summarizeFinancialRows(players);
    logFinancialTrace('event_inclusion_counts', {
      source: financialPlan.table,
      requested_players: uids.length,
      scanned: totalsCounts.scanned,
      included: totalsCounts.included,
      excluded_status: totalsCounts.excluded_status,
      excluded_type: totalsCounts.excluded_type,
      deduped: totalsCounts.deduped,
      total_in: summary.total_in,
      total_out: summary.total_out
    });
    return {
      configured: true,
      source: financialPlan.table,
      activeDay: {
        timeZone: activeBounds.timeZone,
        start: activeBounds.start.toISOString(),
        end: activeBounds.end.toISOString()
      },
      players,
      summary
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

export const appBegFinancialTesting = {
  buildFinancialPlan,
  aggregateFinancialEventsForUids,
  businessDayBounds
};
