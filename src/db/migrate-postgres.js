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
    ALTER TABLE telegram_outbound_messages
      ADD COLUMN IF NOT EXISTS media_path TEXT;
    ALTER TABLE telegram_outbound_messages
      ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
  `);
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_methods_active_order
      ON payment_methods(is_active, display_order ASC, id ASC);
  `);
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS payment_qr_codes (
      id BIGSERIAL PRIMARY KEY,
      payment_method_id BIGINT NOT NULL REFERENCES payment_methods(id) ON DELETE CASCADE,
      label TEXT,
      file_path TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_qr_codes_method_default
      ON payment_qr_codes(payment_method_id, is_active, is_default, updated_at DESC);
  `);
  await driver.exec(`
    ALTER TABLE registration_payment_windows
      ADD COLUMN IF NOT EXISTS payment_method_id BIGINT REFERENCES payment_methods(id) ON DELETE SET NULL;
    ALTER TABLE registration_payment_windows
      ADD COLUMN IF NOT EXISTS payment_qr_code_id BIGINT REFERENCES payment_qr_codes(id) ON DELETE SET NULL;
    ALTER TABLE registration_payment_windows
      ADD COLUMN IF NOT EXISTS payment_display_name TEXT;
    ALTER TABLE registration_payment_windows
      ADD COLUMN IF NOT EXISTS expiry_notified_at TEXT;
  `);
  await driver.exec(`
    CREATE INDEX IF NOT EXISTS idx_registration_payment_windows_contact_status
      ON registration_payment_windows(contact_id, status, expires_at DESC);
  `);

  const chimeTable = await driver.get(`
    SELECT 1 AS ok
    FROM information_schema.tables
    WHERE table_name = 'chime_qr_codes'
  `);
  if (chimeTable?.ok) {
    let chimeMethod = await driver.get("SELECT id FROM payment_methods WHERE key = 'chime'");
    if (!chimeMethod) {
      await driver.run(`
        INSERT INTO payment_methods (name, key, is_active, display_order, created_at, updated_at)
        VALUES ('Chime', 'chime', TRUE, 1, NOW()::TEXT, NOW()::TEXT)
      `);
      chimeMethod = await driver.get("SELECT id FROM payment_methods WHERE key = 'chime'");
    }
    const legacyRows = await driver.all('SELECT * FROM chime_qr_codes');
    for (const row of legacyRows) {
      const existing = await driver.get('SELECT id FROM payment_qr_codes WHERE file_path = ?', [row.file_path]);
      let newId = existing?.id;
      if (!newId) {
        const inserted = await driver.run(`
          INSERT INTO payment_qr_codes (
            payment_method_id, label, file_path, is_default, is_active, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `, [
          chimeMethod.id,
          row.label,
          row.file_path,
          row.is_default,
          row.is_active,
          row.created_at,
          row.updated_at
        ]);
        newId = inserted?.lastInsertRowid || inserted?.id;
      }
      await driver.run(`
        UPDATE registration_payment_windows
        SET payment_method_id = COALESCE(payment_method_id, ?),
            payment_qr_code_id = COALESCE(payment_qr_code_id, ?),
            payment_display_name = COALESCE(payment_display_name, chime_payment_name)
        WHERE qr_code_id = ?
      `, [chimeMethod.id, newId, row.id]);
    }
  }

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
    CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_telegram_message ON bot_jobs(contact_id, job_type, incoming_telegram_message_id);
  `);

  await driver.exec(`
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_updated_at TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_updated_by TEXT;
    CREATE TABLE IF NOT EXISTS staff_ai_training_examples (
      id BIGSERIAL PRIMARY KEY,
      contact_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
      telegram_user_id TEXT,
      incoming_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      customer_message TEXT,
      conversation_context TEXT,
      conversation_history TEXT,
      detected_intent TEXT,
      detected_entities_json TEXT NOT NULL DEFAULT '{}',
      entities_json TEXT NOT NULL DEFAULT '{}',
      ai_draft_reply TEXT,
      ai_reply TEXT,
      final_staff_reply TEXT,
      staff_reply TEXT,
      reply_used TEXT,
      staff_user_id TEXT,
      staff_username TEXT,
      was_edited BOOLEAN NOT NULL DEFAULT FALSE,
      edit_distance_percent DOUBLE PRECISION,
      staff_feedback_reason TEXT,
      outcome TEXT NOT NULL DEFAULT 'drafted',
      confidence DOUBLE PRECISION,
      language TEXT,
      sentiment TEXT,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_staff_ai_training_contact_created
      ON staff_ai_training_examples(contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_staff_ai_training_outcome_created
      ON staff_ai_training_examples(outcome, created_at DESC);
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS conversation_history TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS entities_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS ai_reply TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS staff_reply TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS reply_used TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS was_registered BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS registration_status TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS registration_step TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS payment_window_status TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS appbeg_player_uid TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS recommended_action TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS action_executed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS action_blocked_reason TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS feedback TEXT;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS ai_reply_rejected BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE staff_ai_training_examples ADD COLUMN IF NOT EXISTS normalized_customer_message TEXT;
    CREATE INDEX IF NOT EXISTS idx_staff_ai_training_normalized_message
      ON staff_ai_training_examples(normalized_customer_message);
    CREATE INDEX IF NOT EXISTS idx_staff_ai_training_approved_sent
      ON staff_ai_training_examples(approved, sent_at DESC);
    UPDATE staff_ai_training_examples
    SET approved = TRUE,
        feedback = COALESCE(feedback, reply_used, CASE WHEN was_edited = FALSE THEN 'good' ELSE 'bad' END),
        ai_reply_rejected = CASE
          WHEN COALESCE(feedback, reply_used) = 'bad' THEN TRUE
          WHEN was_edited = TRUE AND COALESCE(feedback, reply_used) IS NULL THEN TRUE
          ELSE FALSE
        END
    WHERE sent_at IS NOT NULL
      AND TRIM(COALESCE(final_staff_reply, staff_reply, '')) != ''
      AND approved = FALSE;
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

  await driver.exec(`
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS auto_registration_bot_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS auto_registration_bot_enabled_at TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS auto_registration_bot_updated_at TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS auto_registration_bot_updated_by TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_updated_at TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS staff_ai_apprentice_mode_updated_by TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS customer_support_ai_mode TEXT NOT NULL DEFAULT 'train';
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS customer_support_ai_mode_updated_at TEXT;
    ALTER TABLE coadmin_settings
      ADD COLUMN IF NOT EXISTS customer_support_ai_mode_updated_by TEXT;
    ALTER TABLE telegram_users
      ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'train';
    ALTER TABLE telegram_users
      ADD COLUMN IF NOT EXISTS ai_auto_paused BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE telegram_users
      ADD COLUMN IF NOT EXISTS ai_mode_updated_at TEXT;
    ALTER TABLE telegram_users
      ADD COLUMN IF NOT EXISTS ai_mode_updated_by TEXT;
  `);

  await driver.exec(`
    CREATE TABLE IF NOT EXISTS ledger_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_users_username ON ledger_users(username);
  `);

  await driver.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING', ['base_schema_v1']);
}
