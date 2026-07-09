export function resolveAppBegDatabaseConfig(env = process.env) {
  const databaseUrl = String(env.APPBEG_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    return { configured: false, databaseUrl: null };
  }

  return {
    configured: true,
    databaseUrl,
    ssl: env.APPBEG_DATABASE_SSL === 'true' || env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined
  };
}
