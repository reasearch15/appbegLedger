import 'dotenv/config';
import pg from 'pg';

const url = process.env.APPBEG_DATABASE_URL || process.env.DATABASE_URL?.replace('appbeg_ledger_db', 'appbeg');
if (!url) {
  console.error('No database URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false });
try {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log('TABLES:');
  for (const row of tables.rows) console.log(row.table_name);

  const interesting = tables.rows
    .map((r) => r.table_name)
    .filter((name) => /player|cache|game|balance|coadmin|user/i.test(name));

  for (const table of interesting) {
    const cols = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    console.log(`\nCOLUMNS ${table}:`);
    for (const col of cols.rows) console.log(`  ${col.column_name} (${col.data_type})`);
  }
} finally {
  await pool.end();
}
