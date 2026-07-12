import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import Database from 'better-sqlite3';

const { Pool } = pg;

const CONTACT_TABLES = [
  'telegram_users',
  'conversations',
  'messages',
  'bot_sessions',
  'contact_automation_state',
  'bot_jobs',
  'telegram_outbound_messages',
  'activity_events',
  'automation_logs',
  'internal_notes',
  'telegram_user_tags',
  'registration_info_history',
  'staff_ai_training_examples',
  'outgoing_message_requests',
  'deposit_events',
  'registration_payment_windows'
];

const mode = process.argv.includes('--execute') ? 'execute' : 'preview';

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sqlitePath() {
  return path.resolve(process.env.DATABASE_PATH || './data/royal-vip-coadmin.sqlite');
}

async function writeBackup(backup) {
  const dir = path.resolve('data', 'backups');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `business-account-cleanup-${timestampSlug()}.json`);
  await fs.writeFile(filePath, JSON.stringify(backup, null, 2));
  return filePath;
}

function countRows(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

async function runPostgres() {
  if (!process.env.DATABASE_URL) return null;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });
  const client = await pool.connect();
  try {
    const contacts = (await client.query(
      "SELECT * FROM telegram_users WHERE telegram_sync_source = 'business_account' ORDER BY id"
    )).rows;
    const ids = contacts.map((row) => row.id);
    const params = [ids];
    const byContact = async (table, column = 'telegram_user_id') => (
      ids.length ? (await client.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::bigint[]) ORDER BY 1`, params)).rows : []
    );
    const byId = async (table, column = 'contact_id') => (
      ids.length ? (await client.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::bigint[]) ORDER BY 1`, params)).rows : []
    );
    const conversations = await byContact('conversations');
    const conversationIds = conversations.map((row) => row.id);
    const messages = conversationIds.length
      ? (await client.query('SELECT * FROM messages WHERE conversation_id = ANY($1::bigint[]) ORDER BY id', [conversationIds])).rows
      : [];
    const registrationWindows = await byId('registration_payment_windows');
    const registrationWindowIds = registrationWindows.map((row) => row.id);
    const depositEvents = await byId('deposit_events');
    const depositEventIds = depositEvents.map((row) => row.id);
    const linkedPaymentEvents = ids.length
      ? (await client.query(`
          SELECT *
          FROM payment_events
          WHERE contact_id = ANY($1::bigint[])
             OR registration_payment_window_id = ANY($2::bigint[])
             OR deposit_event_id = ANY($3::bigint[])
          ORDER BY id
        `, [ids, registrationWindowIds, depositEventIds])).rows
      : [];

    const backup = {
      generated_at: new Date().toISOString(),
      mode,
      dialect: 'postgres',
      criteria: "telegram_users.telegram_sync_source = 'business_account'",
      tables: {
        telegram_users: contacts,
        conversations,
        messages,
        bot_sessions: await byContact('bot_sessions'),
        contact_automation_state: await byContact('contact_automation_state'),
        bot_jobs: await byId('bot_jobs'),
        telegram_outbound_messages: await byId('telegram_outbound_messages'),
        activity_events: await byContact('activity_events'),
        automation_logs: await byContact('automation_logs'),
        internal_notes: await byContact('internal_notes'),
        telegram_user_tags: await byContact('telegram_user_tags'),
        registration_info_history: await byContact('registration_info_history'),
        staff_ai_training_examples: await byId('staff_ai_training_examples', 'contact_id'),
        outgoing_message_requests: await byContact('outgoing_message_requests'),
        deposit_events: depositEvents,
        registration_payment_windows: registrationWindows,
        payment_events_preserved_but_unlinked: linkedPaymentEvents
      }
    };
    const backupPath = await writeBackup(backup);
    const preview = {
      dialect: 'postgres',
      mode,
      backupPath,
      businessAccountContacts: countRows(contacts),
      conversations: countRows(conversations),
      messages: countRows(messages),
      botJobs: countRows(backup.tables.bot_jobs),
      outboundMessages: countRows(backup.tables.telegram_outbound_messages),
      automationSessionStateRecords:
        countRows(backup.tables.bot_sessions) + countRows(backup.tables.contact_automation_state) + countRows(backup.tables.automation_logs),
      paymentEventsPreservedButUnlinked: countRows(linkedPaymentEvents)
    };

    if (mode !== 'execute' || ids.length === 0) return { preview, deletion: null };

    await client.query('BEGIN');
    try {
      const deletion = {};
      const del = async (name, sql, values) => {
        const result = await client.query(sql, values);
        deletion[name] = result.rowCount;
      };

      await client.query(`
        UPDATE payment_events
        SET contact_id = NULL,
            registration_payment_window_id = NULL,
            deposit_event_id = NULL,
            updated_at = NOW()::TEXT
        WHERE contact_id = ANY($1::bigint[])
           OR registration_payment_window_id = ANY($2::bigint[])
           OR deposit_event_id = ANY($3::bigint[])
      `, [ids, registrationWindowIds, depositEventIds]);

      await del('telegram_outbound_messages', 'DELETE FROM telegram_outbound_messages WHERE contact_id = ANY($1::bigint[])', [ids]);
      await del('bot_jobs', 'DELETE FROM bot_jobs WHERE contact_id = ANY($1::bigint[])', [ids]);
      await del('staff_ai_training_examples', 'DELETE FROM staff_ai_training_examples WHERE contact_id = ANY($1::bigint[])', [ids]);
      await del('registration_payment_windows', 'DELETE FROM registration_payment_windows WHERE contact_id = ANY($1::bigint[])', [ids]);
      await del('deposit_events', 'DELETE FROM deposit_events WHERE contact_id = ANY($1::bigint[])', [ids]);
      await del('outgoing_message_requests', 'DELETE FROM outgoing_message_requests WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('registration_info_history', 'DELETE FROM registration_info_history WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('automation_logs', 'DELETE FROM automation_logs WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('activity_events', 'DELETE FROM activity_events WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('internal_notes', 'DELETE FROM internal_notes WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('telegram_user_tags', 'DELETE FROM telegram_user_tags WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('contact_automation_state', 'DELETE FROM contact_automation_state WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('bot_sessions', 'DELETE FROM bot_sessions WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('messages', 'DELETE FROM messages WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('conversations', 'DELETE FROM conversations WHERE telegram_user_id = ANY($1::bigint[])', [ids]);
      await del('telegram_users', "DELETE FROM telegram_users WHERE id = ANY($1::bigint[]) AND telegram_sync_source = 'business_account'", [ids]);

      await client.query('COMMIT');
      const verification = {
        businessAccountContactsRemaining: Number((await client.query("SELECT COUNT(*) AS count FROM telegram_users WHERE telegram_sync_source = 'business_account'")).rows[0].count),
        paymentEvents: Number((await client.query('SELECT COUNT(*) AS count FROM payment_events')).rows[0].count),
        orphanConversations: Number((await client.query('SELECT COUNT(*) AS count FROM conversations c LEFT JOIN telegram_users u ON u.id = c.telegram_user_id WHERE u.id IS NULL')).rows[0].count),
        orphanMessages: Number((await client.query('SELECT COUNT(*) AS count FROM messages m LEFT JOIN telegram_users u ON u.id = m.telegram_user_id WHERE u.id IS NULL')).rows[0].count),
        orphanBotJobs: Number((await client.query('SELECT COUNT(*) AS count FROM bot_jobs j LEFT JOIN telegram_users u ON u.id = j.contact_id WHERE u.id IS NULL')).rows[0].count)
      };
      return { preview, deletion, verification };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function runSqlite() {
  const db = new Database(sqlitePath());
  try {
    const contacts = db.prepare("SELECT * FROM telegram_users WHERE telegram_sync_source = 'business_account' ORDER BY id").all();
    const ids = contacts.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const allWhere = (table, column = 'telegram_user_id') => (
      ids.length ? db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders}) ORDER BY 1`).all(...ids) : []
    );
    const conversations = allWhere('conversations');
    const conversationIds = conversations.map((row) => row.id);
    const conversationPlaceholders = conversationIds.map(() => '?').join(',');
    const messages = conversationIds.length
      ? db.prepare(`SELECT * FROM messages WHERE conversation_id IN (${conversationPlaceholders}) ORDER BY id`).all(...conversationIds)
      : [];
    const backup = {
      generated_at: new Date().toISOString(),
      mode,
      dialect: 'sqlite',
      criteria: "telegram_users.telegram_sync_source = 'business_account'",
      tables: Object.fromEntries(CONTACT_TABLES.map((table) => [table, table === 'messages' ? messages : table === 'telegram_users' ? contacts : allWhere(table, table === 'bot_jobs' || table === 'telegram_outbound_messages' || table === 'deposit_events' || table === 'registration_payment_windows' || table === 'staff_ai_training_examples' ? 'contact_id' : 'telegram_user_id')]))
    };
    const backupPath = await writeBackup(backup);
    const preview = {
      dialect: 'sqlite',
      mode,
      backupPath,
      businessAccountContacts: contacts.length,
      conversations: conversations.length,
      messages: messages.length,
      botJobs: backup.tables.bot_jobs.length,
      outboundMessages: backup.tables.telegram_outbound_messages.length,
      automationSessionStateRecords: backup.tables.bot_sessions.length + backup.tables.contact_automation_state.length + backup.tables.automation_logs.length
    };
    if (mode !== 'execute' || !ids.length) return { preview, deletion: null };

    const deletion = {};
    db.transaction(() => {
      const del = (name, sql, values = ids) => {
        deletion[name] = db.prepare(sql).run(...values).changes;
      };
      del('telegram_outbound_messages', `DELETE FROM telegram_outbound_messages WHERE contact_id IN (${placeholders})`);
      del('bot_jobs', `DELETE FROM bot_jobs WHERE contact_id IN (${placeholders})`);
      del('staff_ai_training_examples', `DELETE FROM staff_ai_training_examples WHERE contact_id IN (${placeholders})`);
      del('registration_payment_windows', `DELETE FROM registration_payment_windows WHERE contact_id IN (${placeholders})`);
      del('deposit_events', `DELETE FROM deposit_events WHERE contact_id IN (${placeholders})`);
      del('outgoing_message_requests', `DELETE FROM outgoing_message_requests WHERE telegram_user_id IN (${placeholders})`);
      del('registration_info_history', `DELETE FROM registration_info_history WHERE telegram_user_id IN (${placeholders})`);
      del('automation_logs', `DELETE FROM automation_logs WHERE telegram_user_id IN (${placeholders})`);
      del('activity_events', `DELETE FROM activity_events WHERE telegram_user_id IN (${placeholders})`);
      del('internal_notes', `DELETE FROM internal_notes WHERE telegram_user_id IN (${placeholders})`);
      del('telegram_user_tags', `DELETE FROM telegram_user_tags WHERE telegram_user_id IN (${placeholders})`);
      del('contact_automation_state', `DELETE FROM contact_automation_state WHERE telegram_user_id IN (${placeholders})`);
      del('bot_sessions', `DELETE FROM bot_sessions WHERE telegram_user_id IN (${placeholders})`);
      del('messages', `DELETE FROM messages WHERE telegram_user_id IN (${placeholders})`);
      del('conversations', `DELETE FROM conversations WHERE telegram_user_id IN (${placeholders})`);
      del('telegram_users', `DELETE FROM telegram_users WHERE id IN (${placeholders}) AND telegram_sync_source = 'business_account'`);
    })();
    const verification = {
      businessAccountContactsRemaining: db.prepare("SELECT COUNT(*) AS count FROM telegram_users WHERE telegram_sync_source = 'business_account'").get().count,
      paymentEvents: db.prepare('SELECT COUNT(*) AS count FROM payment_events').get().count
    };
    return { preview, deletion, verification };
  } finally {
    db.close();
  }
}

const result = await (process.env.DATABASE_URL ? runPostgres() : runSqlite());
console.log(JSON.stringify(result, null, 2));
