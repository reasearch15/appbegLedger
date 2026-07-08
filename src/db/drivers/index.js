import { resolveDatabaseConfig } from '../config.js';
import { PostgresDriver } from './postgres.js';
import { SqliteDriver } from './sqlite.js';

export async function createDriver(config = resolveDatabaseConfig()) {
  const driver = config.dialect === 'postgres'
    ? new PostgresDriver(config.databaseUrl)
    : new SqliteDriver(config.databasePath);

  await driver.connect();
  return driver;
}

export { PostgresDriver, SqliteDriver };
