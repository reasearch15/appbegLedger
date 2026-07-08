import pg from 'pg';
import { convertPlaceholders } from '../sql.js';

const { Pool } = pg;

export class PostgresDriver {
  constructor(databaseUrl) {
    this.dialect = 'postgres';
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_SIZE || 10),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });
  }

  async connect() {
    const client = await this.pool.connect();
    client.release();
    return this;
  }

  prepare(sql) {
    return {
      run: (...params) => this.run(sql, normalizeParams(params)),
      get: (...params) => this.get(sql, normalizeParams(params)),
      all: (...params) => this.all(sql, normalizeParams(params))
    };
  }

  async run(sql, params = []) {
    const { sql: convertedSql, params: convertedParams } = convertPlaceholders(sql, params);
    const returningSql = appendReturningIfInsert(convertedSql);
    const result = await this.pool.query(returningSql, convertedParams);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? null
    };
  }

  async get(sql, params = []) {
    const { sql: convertedSql, params: convertedParams } = convertPlaceholders(sql, params);
    const result = await this.pool.query(convertedSql, convertedParams);
    return result.rows[0] ?? null;
  }

  async all(sql, params = []) {
    const { sql: convertedSql, params: convertedParams } = convertPlaceholders(sql, params);
    const result = await this.pool.query(convertedSql, convertedParams);
    return result.rows;
  }

  async exec(sql) {
    const statements = splitSqlStatements(sql);
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      await this.pool.query(trimmed);
    }
  }

  async close() {
    await this.pool.end();
  }
}

function normalizeParams(params) {
  if (
    params.length === 1
    && params[0] != null
    && typeof params[0] === 'object'
    && !Array.isArray(params[0])
  ) {
    return params[0];
  }
  return params;
}

function appendReturningIfInsert(sql) {
  const trimmed = sql.trim();
  if (!/^insert\b/i.test(trimmed)) return sql;
  if (/\breturning\b/i.test(trimmed)) return sql;
  if (/\bon conflict\b/i.test(trimmed)) return sql;
  return `${trimmed} RETURNING id`;
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}
