export function resolveDatabaseConfig(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (databaseUrl) {
    return {
      dialect: 'postgres',
      databaseUrl,
      databasePath: null
    };
  }

  return {
    dialect: 'sqlite',
    databaseUrl: null,
    databasePath: env.DATABASE_PATH || './data/royal-vip-coadmin.sqlite'
  };
}
