import 'dotenv/config';
import { createDataStore } from '../src/db/index.js';
import { resolveDatabaseConfig } from '../src/db/config.js';

const config = resolveDatabaseConfig();
const store = await createDataStore(config);

const stats = await store.getPaymentStats();
console.log('getPaymentStats:', stats);
console.log('messagesToday type:', typeof stats.messagesToday, 'value:', stats.messagesToday);
console.log('totalMessages type:', typeof stats.totalMessages, 'value:', stats.totalMessages);

const all = await store.listPaymentEvents({ limit: 500, status: 'All', routingStatus: 'All' });
console.log('listPaymentEvents All:', all.length);

const parsed = await store.listPaymentEvents({ limit: 500, status: 'Parsed', routingStatus: 'All' });
console.log('listPaymentEvents Parsed:', parsed.length);

const frozen = await store.listPaymentEvents({ limit: 500, routingStatus: 'manual_review' });
console.log('listPaymentEvents manual_review:', frozen.length);
