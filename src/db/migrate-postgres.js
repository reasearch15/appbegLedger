import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_QUICK_REPLIES,
  DEFAULT_TAGS
} from './defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'schema.postgres.sql');

export async function migratePostgres(driver) {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await driver.exec(schemaSql);
  await driver.exec(`
    ALTER TABLE telegram_outbound_messages
      ADD COLUMN IF NOT EXISTS buttons_json TEXT NOT NULL DEFAULT '[]';
  `);
  await driver.exec(`
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS bot_paused BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS needs_staff_review BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS bot_paused_at TEXT;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS bot_paused_by TEXT;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS staff_review_reason TEXT;
    ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS staff_review_at TEXT;
  `);
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS bot_jobs (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL,
      message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      incoming_telegram_message_id BIGINT,
      job_type TEXT NOT NULL DEFAULT 'inbound_message',
      input_text TEXT,
      action TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      worker_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_status_created ON bot_jobs(status, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_created ON bot_jobs(contact_id, created_at DESC);
  `);

  const applied = await driver.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', ['base_schema_v1']);
  if (applied?.ok) {
    return;
  }

  for (const tag of DEFAULT_TAGS) {
    await driver.run(
      'INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
      [tag.name, tag.color]
    );
  }

  for (const reply of DEFAULT_QUICK_REPLIES) {
    await driver.run(
      `INSERT INTO quick_replies (label, body, sort_order)
       VALUES (?, ?, ?)
       ON CONFLICT (label) DO UPDATE SET
         body = EXCLUDED.body,
         sort_order = EXCLUDED.sort_order,
         updated_at = NOW()::TEXT`,
      [reply.label, reply.body, reply.sort_order]
    );
  }

  for (const rule of DEFAULT_AUTOMATION_RULES) {
    await driver.run(
      `INSERT INTO automation_rules (
        name, keywords_json, match_type, contact_status_condition, response_type,
        response_message, buttons_json, flow_key, intent_key, conversation_status,
        enabled, priority, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW()::TEXT)
      ON CONFLICT (name) DO UPDATE SET
        keywords_json = EXCLUDED.keywords_json,
        match_type = EXCLUDED.match_type,
        contact_status_condition = EXCLUDED.contact_status_condition,
        response_type = EXCLUDED.response_type,
        response_message = EXCLUDED.response_message,
        buttons_json = EXCLUDED.buttons_json,
        flow_key = EXCLUDED.flow_key,
        intent_key = EXCLUDED.intent_key,
        conversation_status = EXCLUDED.conversation_status,
        priority = EXCLUDED.priority,
        updated_at = NOW()::TEXT`,
      [
        rule.name,
        JSON.stringify(rule.keywords),
        rule.match_type,
        rule.contact_status_condition,
        rule.response_type,
        rule.response_message,
        JSON.stringify(rule.buttons || []),
        rule.flow_key ?? null,
        rule.intent_key ?? null,
        rule.conversation_status ?? null,
        rule.priority
      ]
    );
  }

  await driver.run('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, NOW()::TEXT) ON CONFLICT (id) DO NOTHING');

  await driver.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING', ['base_schema_v1']);
}
