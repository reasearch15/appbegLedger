import assert from 'node:assert/strict';
import { migratePostgres } from '../src/db/migrate-postgres.js';
import { TELEGRAM_FIRST_MIGRATION_NAME } from '../src/db/telegramFirstSchema.js';

function createFakeDriver({ baseSchemaApplied = false } = {}) {
  const calls = [];
  return {
    calls,
    dialect: 'postgres',
    async exec(sql) {
      calls.push({ type: 'exec', sql: String(sql) });
    },
    async run(sql, params = []) {
      calls.push({ type: 'run', sql: String(sql), params });
      return { changes: 1, lastInsertRowid: 1 };
    },
    async get(sql, params = []) {
      calls.push({ type: 'get', sql: String(sql), params });
      if (params?.[0] === 'base_schema_v1' || String(sql).includes('base_schema_v1')) {
        return baseSchemaApplied ? { ok: 1 } : null;
      }
      return null;
    }
  };
}

function joinedSql(driver) {
  return driver.calls.map((call) => `${call.type}:${call.sql}`).join('\n');
}

function assertTelegramFirstApplied(driver) {
  const sql = joinedSql(driver);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_roles/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_identities/i);
  assert.match(sql, /royal_vip_hub_storefront_message_id/);
  assert.match(sql, /royal_vip_hub_storefront_synced_at/);
  assert.match(sql, /royal_vip_hub_storefront_error/);
  assert.match(sql, /royal_vip_hub_storefront_pinned/);
  assert.match(sql, /staff_control_center_message_id/);
  assert.match(sql, /staff_control_center_synced_at/);
  assert.match(sql, /staff_control_center_error/);
  assert.match(sql, /staff_control_center_pinned/);
  assert.match(sql, /idx_one_active_deposit_window_per_requester/);
  assert.match(sql, /idx_operational_roles_active_user/);
  const telegramFirstInsert = driver.calls.find((call) => (
    call.type === 'run'
    && /INSERT INTO schema_migrations/i.test(call.sql)
    && call.params?.[0] === TELEGRAM_FIRST_MIGRATION_NAME
  ));
  assert.ok(telegramFirstInsert, 'telegram_first_royal_vip_v1 must be recorded');
}

function assertNoDestructiveSql(driver) {
  for (const call of driver.calls) {
    const sql = String(call.sql || '').replace(/\s+/g, ' ').trim();
    assert.equal(/^\s*DELETE\b/i.test(sql), false, `unexpected DELETE: ${sql.slice(0, 120)}`);
    assert.equal(/^\s*DROP TABLE\b/i.test(sql), false, `unexpected DROP TABLE: ${sql.slice(0, 120)}`);
    assert.equal(/^\s*TRUNCATE\b/i.test(sql), false, `unexpected TRUNCATE: ${sql.slice(0, 120)}`);
  }
}

async function run() {
  const empty = createFakeDriver({ baseSchemaApplied: false });
  await migratePostgres(empty);
  assertTelegramFirstApplied(empty);
  assert.ok(empty.calls.some((call) => (
    call.type === 'run'
    && /INSERT INTO schema_migrations/i.test(call.sql)
    && call.params?.[0] === 'base_schema_v1'
  )));
  assert.ok(empty.calls.some((call) => call.type === 'run' && /INSERT INTO tags /i.test(call.sql)));
  assertNoDestructiveSql(empty);
  console.log('ok 10: empty DB applies base schema then Telegram-first schema');

  const existingBase = createFakeDriver({ baseSchemaApplied: true });
  await migratePostgres(existingBase);
  assertTelegramFirstApplied(existingBase);
  assert.equal(existingBase.calls.some((call) => (
    call.type === 'run'
    && /INSERT INTO schema_migrations/i.test(call.sql)
    && call.params?.[0] === 'base_schema_v1'
  )), false);
  assert.equal(existingBase.calls.some((call) => call.type === 'run' && /INSERT INTO tags /i.test(call.sql)), false);
  assertNoDestructiveSql(existingBase);
  console.log('ok 11/13-16: existing base_schema_v1 still applies Telegram-first Hub/roles/identities');

  const again = createFakeDriver({ baseSchemaApplied: true });
  await migratePostgres(again);
  await migratePostgres(again);
  const telegramFirstRuns = again.calls.filter((call) => (
    call.type === 'run'
    && /INSERT INTO schema_migrations/i.test(call.sql)
    && call.params?.[0] === TELEGRAM_FIRST_MIGRATION_NAME
  ));
  assert.equal(telegramFirstRuns.length, 2);
  assert.match(telegramFirstRuns[0].sql, /ON CONFLICT/i);
  assertNoDestructiveSql(again);
  console.log('ok 12/17-18: rerun is idempotent and does not delete or rewrite rows');

  console.log('All Telegram-first Postgres migration-control tests passed.');
  console.log('Limitation: no live Postgres harness; SQL application was verified via migratePostgres() driver calls.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
