-- AppBeg Ledger PostgreSQL schema
-- Keep timestamp fields as TEXT for query compatibility with the existing store layer.

CREATE TABLE IF NOT EXISTS telegram_users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  language_code TEXT,
  phone_number TEXT,
  presence_status TEXT,
  last_online_at TEXT,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  profile_photo_file_id TEXT,
  profile_photo_url TEXT,
  registration_status TEXT NOT NULL DEFAULT 'New'
    CHECK (registration_status IN ('New', 'Collecting Info', 'Pending', 'Pending Verification', 'Registered', 'Suspended', 'Archived')),
  staff_assignee_id TEXT,
  appbeg_account_id TEXT,
  appbeg_link_status TEXT,
  payment_profile_status TEXT,
  verification_status TEXT,
  registered_at TEXT,
  suspended_at TEXT,
  archived_at TEXT,
  telegram_sync_source TEXT,
  telegram_source_account_id TEXT,
  telegram_source_account_username TEXT,
  registration_method TEXT,
  bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bot_paused BOOLEAN NOT NULL DEFAULT FALSE,
  needs_staff_review BOOLEAN NOT NULL DEFAULT FALSE,
  bot_paused_at TEXT,
  bot_paused_by TEXT,
  staff_review_reason TEXT,
  staff_review_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram_private',
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Waiting', 'Closed')),
  assigned_staff_name TEXT,
  assigned_at TEXT,
  last_read_message_id BIGINT,
  last_read_at TEXT,
  registration_context_json TEXT,
  payment_context_json TEXT,
  appbeg_context_json TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  UNIQUE (telegram_user_id, channel)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  telegram_message_id BIGINT,
  source TEXT NOT NULL DEFAULT 'bot_api',
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('telegram_user', 'bot', 'staff', 'system')),
  message_type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  payload_json TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE REFERENCES telegram_users(id) ON DELETE CASCADE,
  current_screen TEXT NOT NULL DEFAULT 'Home',
  workflow_key TEXT,
  workflow_step TEXT,
  state_stack_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS internal_notes (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  note_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS telegram_user_tags (
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  PRIMARY KEY (telegram_user_id, tag_id)
);

CREATE TABLE IF NOT EXISTS activity_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  actor_name TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  keywords_json TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'contains', 'starts_with')),
  contact_status_condition TEXT NOT NULL DEFAULT 'any',
  response_type TEXT NOT NULL CHECK (response_type IN ('text', 'menu', 'start_flow')),
  response_message TEXT,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  flow_key TEXT,
  intent_key TEXT,
  conversation_status TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS contact_automation_state (
  telegram_user_id BIGINT PRIMARY KEY REFERENCES telegram_users(id) ON DELETE CASCADE,
  current_flow TEXT,
  current_step TEXT,
  registration_info_json TEXT NOT NULL DEFAULT '{}',
  intents_json TEXT NOT NULL DEFAULT '{}',
  last_matched_keyword TEXT,
  last_rule_id BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL,
  last_automation_response TEXT,
  last_automation_at TEXT,
  last_auto_welcome_at TEXT,
  info_reviewed_at TEXT,
  info_reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  incoming_telegram_message_id BIGINT,
  matched_keyword TEXT,
  rule_id BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL,
  rule_name TEXT,
  action_taken TEXT NOT NULL,
  response_sent TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS telegram_account_sync_checkpoints (
  telegram_user_id BIGINT PRIMARY KEY,
  last_synced_message_id BIGINT NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS telegram_account_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disabled',
  last_started_at TEXT,
  last_connected_at TEXT,
  last_import_completed_at TEXT,
  last_error TEXT,
  account_user_id BIGINT,
  account_username TEXT,
  imported_contacts INTEGER NOT NULL DEFAULT 0,
  imported_messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_message_id BIGINT NOT NULL,
  telegram_group_id BIGINT NOT NULL,
  telegram_group_title TEXT,
  sender_id BIGINT,
  sender_name TEXT,
  sender_username TEXT,
  message_text TEXT,
  raw_payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'New'
    CHECK (processing_status IN ('New', 'Parsed', 'Matched', 'Completed', 'Failed')),
  parsed_recipient_tag TEXT,
  parsed_recipient_tag_normalized TEXT,
  parsed_amount DOUBLE PRECISION,
  parsed_sender_name TEXT,
  parsed_payment_datetime TEXT,
  parsed_total_in DOUBLE PRECISION,
  parsed_total_out DOUBLE PRECISION,
  parse_error TEXT,
  routing_status TEXT NOT NULL DEFAULT 'unrouted',
  routing_owner TEXT,
  contact_id BIGINT REFERENCES telegram_users(id) ON DELETE SET NULL,
  deposit_event_id BIGINT,
  teleledger_payment_id TEXT,
  teleledger_sync_status TEXT,
  idempotency_key TEXT,
  routed_at TEXT,
  handled_by TEXT,
  is_edited BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  message_date TEXT NOT NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  UNIQUE (telegram_group_id, telegram_message_id)
);

CREATE TABLE IF NOT EXISTS deposit_events (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  payment_tag_normalized TEXT NOT NULL,
  payment_tag_display TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_by TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  notes TEXT,
  linked_payment_event_id BIGINT REFERENCES payment_events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS payment_routing_logs (
  id BIGSERIAL PRIMARY KEY,
  payment_event_id BIGINT NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS payment_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disabled',
  last_started_at TEXT,
  last_connected_at TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_error TEXT,
  account_user_id BIGINT,
  account_username TEXT,
  telegram_group_id BIGINT,
  telegram_group_title TEXT,
  last_synced_message_id BIGINT NOT NULL DEFAULT 0,
  imported_messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS payment_listener_logs (
  id BIGSERIAL PRIMARY KEY,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS account_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS registration_info_history (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS outgoing_message_requests (
  client_request_id TEXT NOT NULL,
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  response_json TEXT,
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  completed_at TEXT,
  PRIMARY KEY (client_request_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS telegram_outbound_messages (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error_text TEXT,
  telegram_message_id BIGINT,
  local_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  client_request_id TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  sent_at TEXT
);

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

CREATE TABLE IF NOT EXISTS coadmin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  coadmin_name TEXT,
  coadmin_code TEXT,
  appbeg_coadmin_uid TEXT,
  telegram_account_username TEXT,
  telegram_account_id TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS settings_audit_log (
  id BIGSERIAL PRIMARY KEY,
  settings_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_last_seen ON telegram_users(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_users_status ON telegram_users(registration_status);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status_assignee ON conversations(status, assigned_staff_name);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent ON messages(conversation_id, sent_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_source_telegram
  ON messages(source, conversation_id, telegram_message_id, direction)
  WHERE telegram_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_sessions_user ON bot_sessions(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_created ON internal_notes(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_events(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_user_created ON automation_logs(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled_priority ON automation_rules(enabled, priority ASC);
CREATE INDEX IF NOT EXISTS idx_telegram_account_sync_checkpoints_updated ON telegram_account_sync_checkpoints(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_message_date ON payment_events(message_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(processing_status, message_date DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_routing_status ON payment_events(routing_status, message_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_idempotency_key
  ON payment_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_events_tag_status ON deposit_events(payment_tag_normalized, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_routing_logs_payment ON payment_routing_logs(payment_event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_listener_logs_created ON payment_listener_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_sync_logs_created ON account_sync_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_registration_info_history_user_created ON registration_info_history(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created ON settings_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_outbound_status_created ON telegram_outbound_messages(status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_telegram_outbound_contact_created ON telegram_outbound_messages(contact_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_outbound_client_request
  ON telegram_outbound_messages(client_request_id, contact_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_jobs_status_created ON bot_jobs(status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_created ON bot_jobs(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_telegram_message ON bot_jobs(contact_id, job_type, incoming_telegram_message_id);

INSERT INTO telegram_account_sync_state (id, status, updated_at)
VALUES (1, 'disabled', NOW()::TEXT)
ON CONFLICT (id) DO NOTHING;

INSERT INTO payment_sync_state (id, status, updated_at)
VALUES (1, 'disabled', NOW()::TEXT)
ON CONFLICT (id) DO NOTHING;
