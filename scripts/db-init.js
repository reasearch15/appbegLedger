#!/usr/bin/env node
import 'dotenv/config';
import { resolveDatabaseConfig } from '../src/db/config.js';
import { createDriver } from '../src/db/drivers/index.js';
import { migratePostgres } from '../src/db/migrate-postgres.js';

async function main() {
  const config = resolveDatabaseConfig();
  if (config.dialect !== 'postgres') {
    console.error('DATABASE_URL is required for db:init. SQLite initializes automatically on app start.');
    process.exit(1);
  }

  const driver = await createDriver(config);
  try {
    await migratePostgres(driver);
    const tables = await driver.all(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log(`PostgreSQL schema ready (${tables.length} tables).`);
    for (const row of tables) {
      console.log(`  - ${row.table_name}`);
    }
  } finally {
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
