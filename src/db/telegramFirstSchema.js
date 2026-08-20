/**
 * Royal VIP Telegram-first schema.
 * Applied locally by SQLite migrate() and Postgres migratePostgres().
 * Do not apply to production from this process.
 */

export const TELEGRAM_FIRST_MIGRATION_NAME = 'telegram_first_royal_vip_v1';
export const ROYAL_VIP_HUB_CHANNEL_DM_MIGRATION_NAME = 'royal_vip_hub_channel_dm_v1';

export const SQLITE_TELEGRAM_FIRST_SQL = `
CREATE TABLE IF NOT EXISTS operational_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('root_admin', 'coadmin', 'staff')),
  telegram_username TEXT,
  telegram_display_name TEXT,
  granted_by_telegram_user_id TEXT,
  granted_at TEXT NOT NULL,
  revoked_by_telegram_user_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operational_roles_user
  ON operational_roles(telegram_user_id, granted_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_roles_active_user
  ON operational_roles(telegram_user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS telegram_staff_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER UNIQUE,
  telegram_user_id TEXT NOT NULL,
  staff_group_id TEXT NOT NULL,
  message_thread_id INTEGER NOT NULL,
  topic_name TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_staff_topics_thread
  ON telegram_staff_topics(staff_group_id, message_thread_id);
CREATE INDEX IF NOT EXISTS idx_telegram_staff_topics_user
  ON telegram_staff_topics(telegram_user_id);

CREATE TABLE IF NOT EXISTS payment_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_identity_player_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_identity_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'payer' CHECK (relationship IN ('payer')),
  evidence_kind TEXT NOT NULL,
  payment_event_id INTEGER,
  actor_telegram_user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (payment_identity_id) REFERENCES payment_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_identity_evidence_identity
  ON payment_identity_player_evidence(payment_identity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_identity_evidence_contact
  ON payment_identity_player_evidence(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_event_id INTEGER NOT NULL,
  payment_identity_id INTEGER,
  payer_contact_id INTEGER,
  recipient_contact_id INTEGER,
  window_id INTEGER,
  classification TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence_mode_on INTEGER NOT NULL DEFAULT 0,
  decision_type TEXT NOT NULL,
  actor_telegram_user_id TEXT,
  appbeg_status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (payment_event_id) REFERENCES payment_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_decisions_event
  ON payment_decisions(payment_event_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS operational_settings_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_telegram_user_id TEXT,
  created_at TEXT NOT NULL
);
`;

export const POSTGRES_TELEGRAM_FIRST_SQL = `
CREATE TABLE IF NOT EXISTS operational_roles (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('root_admin', 'coadmin', 'staff')),
  telegram_username TEXT,
  telegram_display_name TEXT,
  granted_by_telegram_user_id TEXT,
  granted_at TEXT NOT NULL,
  revoked_by_telegram_user_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operational_roles_user
  ON operational_roles(telegram_user_id, granted_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_roles_active_user
  ON operational_roles(telegram_user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS telegram_staff_topics (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT UNIQUE REFERENCES telegram_users(id) ON DELETE SET NULL,
  telegram_user_id TEXT NOT NULL,
  staff_group_id TEXT NOT NULL,
  message_thread_id INTEGER NOT NULL,
  topic_name TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_staff_topics_thread
  ON telegram_staff_topics(staff_group_id, message_thread_id);
CREATE INDEX IF NOT EXISTS idx_telegram_staff_topics_user
  ON telegram_staff_topics(telegram_user_id);

CREATE TABLE IF NOT EXISTS payment_identities (
  id BIGSERIAL PRIMARY KEY,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_identity_player_evidence (
  id BIGSERIAL PRIMARY KEY,
  payment_identity_id BIGINT NOT NULL REFERENCES payment_identities(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'payer' CHECK (relationship IN ('payer')),
  evidence_kind TEXT NOT NULL,
  payment_event_id BIGINT,
  actor_telegram_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_identity_evidence_identity
  ON payment_identity_player_evidence(payment_identity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_identity_evidence_contact
  ON payment_identity_player_evidence(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_decisions (
  id BIGSERIAL PRIMARY KEY,
  payment_event_id BIGINT NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
  payment_identity_id BIGINT,
  payer_contact_id BIGINT,
  recipient_contact_id BIGINT,
  window_id BIGINT,
  classification TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence_mode_on BOOLEAN NOT NULL DEFAULT FALSE,
  decision_type TEXT NOT NULL,
  actor_telegram_user_id TEXT,
  appbeg_status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_decisions_event
  ON payment_decisions(payment_event_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS operational_settings_audit (
  id BIGSERIAL PRIMARY KEY,
  settings_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_telegram_user_id TEXT,
  created_at TEXT NOT NULL
);
`;

export async function applyTelegramFirstSqlite(db) {
  await db.exec(SQLITE_TELEGRAM_FIRST_SQL);
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'confidence_mode_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'confidence_mode_updated_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'confidence_mode_updated_by', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_control_center_thread_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_group_id', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'royal_vip_hub_storefront_message_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'royal_vip_hub_storefront_synced_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'royal_vip_hub_storefront_error', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'royal_vip_hub_storefront_pinned', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_control_center_message_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_control_center_synced_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_control_center_error', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'staff_control_center_pinned', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissingSqlite(db, 'registration_payment_windows', 'requester_contact_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'registration_payment_windows', 'recipient_contact_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'registration_payment_windows', 'recipient_player_uid', 'TEXT');
  await addColumnIfMissingSqlite(db, 'registration_payment_windows', 'recipient_username', 'TEXT');
  await addColumnIfMissingSqlite(db, 'payment_events', 'payer_contact_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'payment_events', 'recipient_contact_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'payment_events', 'payment_identity_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'payment_events', 'confidence_classification', 'TEXT');
  await addColumnIfMissingSqlite(db, 'payment_events', 'credit_failed_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'payment_events', 'credit_failed_error', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'decision', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'decided_amount', 'REAL');
  await addColumnIfMissingSqlite(db, 'support_requests', 'decided_by_telegram_user_id', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'decided_by_name', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'decided_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'issuance_status', 'TEXT');
  await addColumnIfMissingSqlite(db, 'support_requests', 'issuance_error', 'TEXT');
  await addColumnIfMissingSqlite(db, 'messages', 'staff_topic_thread_id', 'INTEGER');
  await addColumnIfMissingSqlite(db, 'messages', 'staff_mirror_status', 'TEXT');
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_deposit_window_per_requester
    ON registration_payment_windows(contact_id)
    WHERE status = 'active' AND COALESCE(flow_type, 'registration') = 'deposit'
  `);
  await db.exec(`
    UPDATE registration_payment_windows
    SET requester_contact_id = COALESCE(requester_contact_id, contact_id),
        recipient_contact_id = COALESCE(recipient_contact_id, contact_id)
    WHERE requester_contact_id IS NULL OR recipient_contact_id IS NULL
  `);
  await applyRoyalVipHubChannelDmSqlite(db);
}

export async function applyTelegramFirstPostgres(driver) {
  await driver.exec(POSTGRES_TELEGRAM_FIRST_SQL);
  await driver.exec(`
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS confidence_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS confidence_mode_updated_at TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS confidence_mode_updated_by TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_control_center_thread_id INTEGER;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_group_id TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS royal_vip_hub_storefront_message_id INTEGER;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS royal_vip_hub_storefront_synced_at TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS royal_vip_hub_storefront_error TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS royal_vip_hub_storefront_pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_control_center_message_id INTEGER;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_control_center_synced_at TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_control_center_error TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS staff_control_center_pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE registration_payment_windows ADD COLUMN IF NOT EXISTS requester_contact_id BIGINT;
    ALTER TABLE registration_payment_windows ADD COLUMN IF NOT EXISTS recipient_contact_id BIGINT;
    ALTER TABLE registration_payment_windows ADD COLUMN IF NOT EXISTS recipient_player_uid TEXT;
    ALTER TABLE registration_payment_windows ADD COLUMN IF NOT EXISTS recipient_username TEXT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS payer_contact_id BIGINT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS recipient_contact_id BIGINT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS payment_identity_id BIGINT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS confidence_classification TEXT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS credit_failed_at TEXT;
    ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS credit_failed_error TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS decision TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS decided_amount NUMERIC(12, 2);
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS decided_by_telegram_user_id TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS decided_by_name TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS decided_at TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS issuance_status TEXT;
    ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS issuance_error TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS staff_topic_thread_id INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS staff_mirror_status TEXT;
    ALTER TABLE registration_payment_windows ALTER COLUMN first_deposit_amount DROP NOT NULL;
  `);
  await driver.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_deposit_window_per_requester
    ON registration_payment_windows(contact_id)
    WHERE status = 'active' AND COALESCE(flow_type, 'registration') = 'deposit'
  `);
  await driver.exec(`
    UPDATE registration_payment_windows
    SET requester_contact_id = COALESCE(requester_contact_id, contact_id),
        recipient_contact_id = COALESCE(recipient_contact_id, contact_id)
    WHERE requester_contact_id IS NULL OR recipient_contact_id IS NULL
  `);
  await driver.run(
    'INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING',
    [TELEGRAM_FIRST_MIGRATION_NAME]
  );
  await applyRoyalVipHubChannelDmPostgres(driver);
}

async function addColumnIfMissingSqlite(db, tableName, columnName, columnType) {
  const columns = (await db.prepare(`PRAGMA table_info(${tableName})`).all()).map((column) => column.name);
  if (!columns.includes(columnName)) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}

const SQLITE_CHANNEL_DM_SQL = `
CREATE TABLE IF NOT EXISTS telegram_channel_dm_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_channel_id TEXT NOT NULL,
  direct_messages_chat_id TEXT NOT NULL,
  direct_messages_topic_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  contact_id INTEGER,
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_dm_topics_user
  ON telegram_channel_dm_topics(hub_channel_id, telegram_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_dm_topics_topic
  ON telegram_channel_dm_topics(direct_messages_chat_id, direct_messages_topic_id);
`;

const POSTGRES_CHANNEL_DM_SQL = `
CREATE TABLE IF NOT EXISTS telegram_channel_dm_topics (
  id BIGSERIAL PRIMARY KEY,
  hub_channel_id TEXT NOT NULL,
  direct_messages_chat_id TEXT NOT NULL,
  direct_messages_topic_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  contact_id BIGINT REFERENCES telegram_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_dm_topics_user
  ON telegram_channel_dm_topics(hub_channel_id, telegram_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_dm_topics_topic
  ON telegram_channel_dm_topics(direct_messages_chat_id, direct_messages_topic_id);
`;

export async function applyRoyalVipHubChannelDmSqlite(db) {
  await db.exec(SQLITE_CHANNEL_DM_SQL);
  await addColumnIfMissingSqlite(db, 'operational_roles', 'telegram_channel_admin_synced_at', 'TEXT');
  await addColumnIfMissingSqlite(db, 'operational_roles', 'telegram_channel_admin_status', 'TEXT');
  await addColumnIfMissingSqlite(db, 'operational_roles', 'telegram_channel_admin_error', 'TEXT');
  await addColumnIfMissingSqlite(db, 'coadmin_settings', 'royal_vip_hub_dm_chat_id', 'TEXT');
}

export async function applyRoyalVipHubChannelDmPostgres(driver) {
  await driver.exec(POSTGRES_CHANNEL_DM_SQL);
  await driver.exec(`
    ALTER TABLE operational_roles ADD COLUMN IF NOT EXISTS telegram_channel_admin_synced_at TEXT;
    ALTER TABLE operational_roles ADD COLUMN IF NOT EXISTS telegram_channel_admin_status TEXT;
    ALTER TABLE operational_roles ADD COLUMN IF NOT EXISTS telegram_channel_admin_error TEXT;
    ALTER TABLE coadmin_settings ADD COLUMN IF NOT EXISTS royal_vip_hub_dm_chat_id TEXT;
  `);
  await driver.run(
    'INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING',
    [ROYAL_VIP_HUB_CHANNEL_DM_MIGRATION_NAME]
  );
}
