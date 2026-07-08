#!/usr/bin/env node
/**
 * Verify AppBeg Ledger database connectivity and persistence-related tables.
 * Run before and after restart to confirm data is retained.
 *
 * Usage:
 *   node scripts/verify-db.js
 *   npm run db:verify
 */
import 'dotenv/config';
import { resolveDatabaseConfig } from '../src/db/config.js';
import { createDataStore } from '../src/db/index.js';

async function main() {
  const config = resolveDatabaseConfig();
  const store = await createDataStore(config);

  try {
    const settings = await store.getCoadminSettings();
    const syncState = await store.getTelegramAccountSyncState();
    const paymentSync = await store.getPaymentSyncState();
    const contacts = await store.listUsers({ status: 'All', query: '' });
    const players = await store.listPlayers({ status: 'All', query: '' });
    const messageCount = (await store.db.prepare('SELECT COUNT(*) AS count FROM messages').get())?.count ?? 0;
    const paymentCount = (await store.db.prepare('SELECT COUNT(*) AS count FROM payment_events').get())?.count ?? 0;
    const automationCount = (await store.db.prepare('SELECT COUNT(*) AS count FROM contact_automation_state').get())?.count ?? 0;
    const checkpointRows = await store.db.prepare(`
      SELECT telegram_user_id, last_synced_message_id, last_sync_at, updated_at
      FROM telegram_account_sync_checkpoints
      ORDER BY updated_at DESC
      LIMIT 5
    `).all();
    const syncStateCheckpointCount = (await store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM sync_state
      WHERE key LIKE 'business_account:checkpoint:%'
    `).get())?.count ?? 0;

    const summary = {
      ok: true,
      database: config.dialect,
      counts: {
        contacts: contacts.length,
        players: players.length,
        messages: Number(messageCount),
        paymentEvents: Number(paymentCount),
        automationStates: Number(automationCount)
      },
      coadminSettings: {
        name: settings?.coadmin_name || null,
        code: settings?.coadmin_code || null
      },
      sync: {
        accountStatus: syncState?.status || null,
        importedContacts: syncState?.imported_contacts ?? 0,
        importedMessages: syncState?.imported_messages ?? 0,
        paymentLastSyncedMessageId: paymentSync?.last_synced_message_id ?? 0,
        checkpoints: checkpointRows,
        syncStateCheckpointCount: Number(syncStateCheckpointCount)
      }
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (typeof store.db?.close === 'function') {
      await store.db.close();
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
