import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '..', 'src', 'server.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace(
  "import { CONVERSATION_STATUSES, createDataStore, DEFAULT_TAGS, REGISTRATION_STATUSES } from './db/index.js';",
  "import { CONVERSATION_STATUSES, createDataStore, DEFAULT_TAGS, REGISTRATION_STATUSES } from './db/index.js';\nimport { resolveDatabaseConfig } from './db/config.js';"
);

source = source.replace(
  "const databasePath = process.env.DATABASE_PATH || './data/royal-vip-coadmin.sqlite';\n\nconst app = express();\nconst server = http.createServer(app);\nconst io = new SocketIOServer(server, {\n  cors: { origin: '*' }\n});\nconst store = createDataStore(databasePath);",
  "const app = express();\nconst server = http.createServer(app);\nconst io = new SocketIOServer(server, {\n  cors: { origin: '*' }\n});\nlet store;"
);

source = source.replace(/(?<!await )store\./g, 'await store.');

source = source.replace(/app\.(get|post|patch|put|delete)\(([^;]+?)\(req, res\) =>/g, (match, method, prefix) => {
  if (match.includes('async (req, res)')) return match;
  if (!match.includes('await store.')) return match;
  return `app.${method}(${prefix}async (req, res) =>`;
});

source = source.replace(
  'globalThis.telegramBot = startTelegramListener({',
  `async function bootstrap() {
  store = await createDataStore(resolveDatabaseConfig());
  console.log(\`Database: \${resolveDatabaseConfig().dialect}\`);

  globalThis.telegramBot = startTelegramListener({`
);

source = source.replace(
  `server.listen(port, () => {
  console.log(\`Royal VIP Coadmin foundation running at http://localhost:\${port}\`);
});`,
  `server.listen(port, () => {
    console.log(\`Royal VIP Coadmin foundation running at http://localhost:\${port}\`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});`
);

fs.writeFileSync(target, source);
console.log('Updated server.js for async store.');
