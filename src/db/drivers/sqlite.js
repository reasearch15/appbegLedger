import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class SqliteDriver {
  constructor(databasePath) {
    this.dialect = 'sqlite';
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async connect() {
    return this;
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => Promise.resolve(statement.run(...normalizeParams(params))),
      get: (...params) => Promise.resolve(statement.get(...normalizeParams(params)) ?? null),
      all: (...params) => Promise.resolve(statement.all(...normalizeParams(params)))
    };
  }

  async run(sql, params = []) {
    return this.prepare(sql).run(...toParamList(params));
  }

  async get(sql, params = []) {
    return this.prepare(sql).get(...toParamList(params));
  }

  async all(sql, params = []) {
    return this.prepare(sql).all(...toParamList(params));
  }

  async exec(sql) {
    this.db.exec(sql);
  }

  async close() {
    this.db.close();
  }
}

function normalizeParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    return [params[0]];
  }
  return params;
}

function toParamList(params) {
  if (Array.isArray(params)) return params;
  if (params && typeof params === 'object') return [params];
  return [];
}
