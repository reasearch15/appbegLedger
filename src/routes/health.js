import { resolveDatabaseConfig } from '../db/config.js';
import { CONVERSATION_STATUSES, DEFAULT_TAGS, REGISTRATION_STATUSES } from '../db/index.js';
import { listenerRoles } from '../config/listeners.js';

async function runCheck(name, fn) {
  try {
    const value = await fn();
    return { ok: true, name, ...value };
  } catch (error) {
    return {
      ok: false,
      name,
      error: error.message || String(error)
    };
  }
}

export function registerHealthRoutes(app, { store }) {
  app.get('/api/health', async (req, res) => {
    const dbConfig = resolveDatabaseConfig();
    const [contacts, messages, players, payments, checkpoints, syncStateCheckpoints] = await Promise.all([
      store.db.prepare('SELECT COUNT(*) AS count FROM telegram_users').get().then((row) => row?.count ?? 0),
      store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().then((row) => row?.count ?? 0),
      store.listPlayers({ status: 'All', query: '' }).then((rows) => rows.length),
      store.db.prepare('SELECT COUNT(*) AS count FROM payment_events').get().then((row) => row?.count ?? 0),
      store.db.prepare('SELECT COUNT(*) AS count FROM telegram_account_sync_checkpoints').get().then((row) => row?.count ?? 0),
      store.db.prepare("SELECT COUNT(*) AS count FROM sync_state WHERE key LIKE 'business_account:checkpoint:%'").get().then((row) => row?.count ?? 0)
    ]);

    res.json({
      ok: true,
      database: {
        dialect: dbConfig.dialect,
        path: dbConfig.databasePath || null,
        host: dbConfig.databaseUrl ? (() => {
          try { return new URL(dbConfig.databaseUrl).hostname; } catch { return 'postgres'; }
        })() : null
      },
      counts: {
        contacts: Number(contacts),
        messages: Number(messages),
        players: Number(players),
        paymentEvents: Number(payments),
        syncCheckpoints: Number(checkpoints),
        syncStateCheckpoints: Number(syncStateCheckpoints)
      },
      telegramListenerEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      conversationStatuses: CONVERSATION_STATUSES,
      registrationStatuses: REGISTRATION_STATUSES,
      defaultTags: DEFAULT_TAGS,
      listenerRoles
    });
  });

  app.get('/api/health/full', async (req, res) => {
    const dbConfig = resolveDatabaseConfig();
    const checks = {};

    checks.database = await runCheck('database', async () => {
      await store.db.prepare('SELECT 1 AS ok').get();
      const contacts = Number((await store.db.prepare('SELECT COUNT(*) AS count FROM telegram_users').get())?.count ?? 0);
      const messages = Number((await store.db.prepare('SELECT COUNT(*) AS count FROM messages').get())?.count ?? 0);
      return {
        dialect: dbConfig.dialect,
        host: dbConfig.databaseUrl ? (() => {
          try { return new URL(dbConfig.databaseUrl).hostname; } catch { return 'postgres'; }
        })() : null,
        contacts,
        messages
      };
    });

    checks.quickReplies = await runCheck('quickReplies', async () => {
      const quickReplies = await store.listQuickReplies();
      return { count: quickReplies.length };
    });

    checks.coadminSettings = await runCheck('coadminSettings', async () => {
      const settings = await store.getCoadminSettings();
      return {
        hasName: Boolean(settings?.coadmin_name),
        hasCode: Boolean(settings?.coadmin_code),
        telegramAccountUsername: settings?.telegram_account_username || null
      };
    });

    checks.accountSync = await runCheck('accountSync', async () => {
      const sync = await store.getTelegramAccountSyncState();
      const checkpoints = Number(
        (await store.db.prepare('SELECT COUNT(*) AS count FROM telegram_account_sync_checkpoints').get())?.count ?? 0
      );
      const syncStateCheckpoints = Number(
        (await store.db.prepare("SELECT COUNT(*) AS count FROM sync_state WHERE key LIKE 'business_account:checkpoint:%'").get())?.count ?? 0
      );
      const latestCheckpoints = await store.db.prepare(`
        SELECT telegram_user_id, last_synced_message_id, last_sync_at
        FROM telegram_account_sync_checkpoints
        ORDER BY updated_at DESC
        LIMIT 5
      `).all();
      return {
        status: sync?.status || null,
        importedContacts: sync?.imported_contacts ?? 0,
        importedMessages: sync?.imported_messages ?? 0,
        checkpoints,
        syncStateCheckpoints,
        latestCheckpoints
      };
    });

    checks.paymentSync = await runCheck('paymentSync', async () => {
      const sync = await store.getPaymentSyncState();
      return {
        status: sync?.status || null,
        lastSyncedMessageId: sync?.last_synced_message_id ?? 0
      };
    });

    const ok = Object.values(checks).every((check) => check.ok);
    res.status(ok ? 200 : 503).json({
      ok,
      timestamp: new Date().toISOString(),
      database: dbConfig.dialect,
      checks
    });
  });
}
