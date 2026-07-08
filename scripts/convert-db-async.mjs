import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '..', 'src', 'db', 'index.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace(
  "import Database from 'better-sqlite3';",
  "import { resolveDatabaseConfig } from './config.js';\nimport { createDriver } from './drivers/index.js';\nimport { migratePostgres } from './migrate-postgres.js';"
);

source = source.replace(
  /export const REGISTRATION_STATUSES[\s\S]*?\];\n\nexport function createDataStore\(databasePath\) \{[\s\S]*?const db = new Database\(resolvedPath\);[\s\S]*?migrate\(db\);/,
  `export { REGISTRATION_STATUSES, CONVERSATION_STATUSES, DEFAULT_TAGS, DEFAULT_QUICK_REPLIES, DEFAULT_AUTOMATION_RULES } from './defaults.js';\n\nexport async function createDataStore(config = resolveDatabaseConfig()) {\n  const driver = await createDriver(config);\n  const db = driver;\n  if (config.dialect === 'postgres') {\n    await migratePostgres(driver);\n  } else {\n    await migrate(driver);\n  }`
);

source = source.replace(/^function migrate\(db\) \{/m, 'async function migrate(db) {');
source = source.replace(/^function tableExists\(db, tableName\) \{/m, 'async function tableExists(db, tableName) {');
source = source.replace(/^function tableReferences\(db, tableName, referencedTable\) \{/m, 'async function tableReferences(db, tableName, referencedTable) {');
source = source.replace(/^function rebuildConversationTables\(db\) \{/m, 'async function rebuildConversationTables(db) {');
source = source.replace(/^function rebuildUserChildTables\(db\) \{/m, 'async function rebuildUserChildTables(db) {');
source = source.replace(/^function addColumnIfMissing\(db, tableName, columnName, columnType\) \{/m, 'async function addColumnIfMissing(db, tableName, columnName, columnType) {');

source = source.replace(/\bdb\.exec\(/g, 'await db.exec(');
source = source.replace(/(?<!await )db\.prepare\(([\s\S]*?)\)\.(run|get|all)\(/g, (match) => {
  if (match.includes('await ')) return match;
  return `await db.prepare(${match.slice('db.prepare('.length)}`;
});

source = source.replace(/if \(tableExists\(/g, 'if (await tableExists(');
source = source.replace(/if \(tableReferences\(/g, 'if (await tableReferences(');
source = source.replace(/tableReferences\(db,/g, 'await tableReferences(db,');
source = source.replace(/rebuildConversationTables\(db\)/g, 'await rebuildConversationTables(db)');
source = source.replace(/rebuildUserChildTables\(db\)/g, 'await rebuildUserChildTables(db)');
source = source.replace(/addColumnIfMissing\(db,/g, 'await addColumnIfMissing(db,');

const innerFunctionPattern = /^  function ([a-zA-Z0-9_]+)\(/gm;
source = source.replace(innerFunctionPattern, '  async function $1(');

source = source.replace(/export const REGISTRATION_STATUSES[\s\S]*?priority: 50\n  }\n\];\n\n/g, '');

fs.writeFileSync(target, source);
console.log('Converted src/db/index.js to async driver usage.');
