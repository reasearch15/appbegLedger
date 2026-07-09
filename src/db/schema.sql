PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telegram_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  language_code TEXT,
  phone_number TEXT,
  presence_status TEXT,
  last_online_at TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
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
  bot_enabled INTEGER NOT NULL DEFAULT 1,
  bot_paused INTEGER NOT NULL DEFAULT 0,
  needs_staff_review INTEGER NOT NULL DEFAULT 0,
  bot_paused_at TEXT,
  bot_paused_by TEXT,
  staff_review_reason TEXT,
  staff_review_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram_private',
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Waiting', 'Closed')),
  assigned_staff_name TEXT,
  assigned_at TEXT,
  last_read_message_id INTEGER,
  last_read_at TEXT,
  registration_context_json TEXT,
  payment_context_json TEXT,
  appbeg_context_json TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  UNIQUE (telegram_user_id, channel)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  telegram_message_id INTEGER,
  source TEXT NOT NULL DEFAULT 'bot_api',
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('telegram_user', 'bot', 'staff', 'system')),
  message_type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  payload_json TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  current_screen TEXT NOT NULL DEFAULT 'Home',
  workflow_key TEXT,
  workflow_step TEXT,
  state_stack_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS internal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  staff_name TEXT NOT NULL,
  note_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_user_tags (
  telegram_user_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, tag_id),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  actor_name TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_automation_state (
  telegram_user_id INTEGER PRIMARY KEY,
  current_flow TEXT,
  current_step TEXT,
  registration_info_json TEXT NOT NULL DEFAULT '{}',
  intents_json TEXT NOT NULL DEFAULT '{}',
  last_matched_keyword TEXT,
  last_rule_id INTEGER,
  last_automation_response TEXT,
  last_automation_at TEXT,
  last_auto_welcome_at TEXT,
  info_reviewed_at TEXT,
  info_reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (last_rule_id) REFERENCES automation_rules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  message_id INTEGER,
  incoming_telegram_message_id INTEGER,
  matched_keyword TEXT,
  rule_id INTEGER,
  rule_name TEXT,
  action_taken TEXT NOT NULL,
  response_sent TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (rule_id) REFERENCES automation_rules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_account_sync_checkpoints (
  telegram_user_id INTEGER PRIMARY KEY,
  last_synced_message_id INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_account_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disabled',
  last_started_at TEXT,
  last_connected_at TEXT,
  last_import_completed_at TEXT,
  last_error TEXT,
  account_user_id INTEGER,
  account_username TEXT,
  imported_contacts INTEGER NOT NULL DEFAULT 0,
  imported_messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_message_id INTEGER NOT NULL,
  telegram_group_id INTEGER NOT NULL,
  telegram_group_title TEXT,
  sender_id INTEGER,
  sender_name TEXT,
  sender_username TEXT,
  message_text TEXT,
  raw_payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'New'
    CHECK (processing_status IN ('New', 'Parsed', 'Matched', 'Completed', 'Failed')),
  parsed_recipient_tag TEXT,
  parsed_recipient_tag_normalized TEXT,
  parsed_amount REAL,
  parsed_sender_name TEXT,
  parsed_payment_datetime TEXT,
  parsed_total_in REAL,
  parsed_total_out REAL,
  parsed_payment_app TEXT,
  parsed_message_time TEXT,
  parse_error TEXT,
  routing_status TEXT NOT NULL DEFAULT 'unrouted',
  routing_owner TEXT,
  routing_reason TEXT,
  contact_id INTEGER REFERENCES telegram_users(id) ON DELETE SET NULL,
  deposit_event_id INTEGER,
  registration_payment_window_id INTEGER,
  teleledger_payment_id TEXT,
  teleledger_sync_status TEXT,
  idempotency_key TEXT,
  routed_at TEXT,
  handled_by TEXT,
  is_edited INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  message_date TEXT NOT NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (telegram_group_id, telegram_message_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS deposit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
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
  linked_payment_event_id INTEGER REFERENCES payment_events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_routing_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_event_id INTEGER NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disabled',
  last_started_at TEXT,
  last_connected_at TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_error TEXT,
  account_user_id INTEGER,
  account_username TEXT,
  telegram_group_id INTEGER,
  telegram_group_title TEXT,
  last_synced_message_id INTEGER NOT NULL DEFAULT 0,
  imported_messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_listener_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_info_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outgoing_message_requests (
  client_request_id TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  response_json TEXT,
  message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  PRIMARY KEY (client_request_id, telegram_user_id),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS telegram_outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  telegram_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  media_path TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error_text TEXT,
  telegram_message_id INTEGER,
  local_message_id INTEGER,
  client_request_id TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (local_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bot_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  telegram_user_id TEXT NOT NULL,
  message_id INTEGER,
  incoming_telegram_message_id INTEGER,
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS coadmin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  coadmin_name TEXT,
  coadmin_code TEXT,
  appbeg_coadmin_uid TEXT,
  telegram_account_username TEXT,
  telegram_account_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  auto_registration_bot_enabled INTEGER NOT NULL DEFAULT 1,
  auto_registration_bot_enabled_at TEXT,
  auto_registration_bot_updated_at TEXT,
  auto_registration_bot_updated_by TEXT,
  staff_ai_apprentice_mode_enabled INTEGER NOT NULL DEFAULT 1,
  staff_ai_apprentice_mode_updated_at TEXT,
  staff_ai_apprentice_mode_updated_by TEXT
);

CREATE TABLE IF NOT EXISTS staff_ai_training_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  telegram_user_id TEXT,
  incoming_message_id INTEGER,
  customer_message TEXT,
  conversation_context TEXT,
  detected_intent TEXT,
  detected_entities_json TEXT NOT NULL DEFAULT '{}',
  ai_draft_reply TEXT,
  final_staff_reply TEXT,
  staff_user_id TEXT,
  staff_username TEXT,
  was_edited INTEGER NOT NULL DEFAULT 0,
  edit_distance_percent REAL,
  staff_feedback_reason TEXT,
  outcome TEXT NOT NULL DEFAULT 'drafted',
  language TEXT,
  sentiment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (incoming_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_qr_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method_id INTEGER NOT NULL,
  label TEXT,
  file_path TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS registration_payment_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  telegram_user_id TEXT NOT NULL,
  payment_method_id INTEGER,
  payment_qr_code_id INTEGER,
  payment_display_name TEXT,
  first_deposit_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  expiry_notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE SET NULL,
  FOREIGN KEY (payment_qr_code_id) REFERENCES payment_qr_codes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_last_seen
  ON telegram_users(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_users_status
  ON telegram_users(registration_status);

CREATE INDEX IF NOT EXISTS idx_conversations_user
  ON conversations(telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent
  ON messages(conversation_id, sent_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_user
  ON bot_sessions(telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_notes_user_created
  ON internal_notes(telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_user_created
  ON activity_events(telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_logs_user_created
  ON automation_logs(telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled_priority
  ON automation_rules(enabled, priority ASC);

CREATE INDEX IF NOT EXISTS idx_telegram_account_sync_checkpoints_updated
  ON telegram_account_sync_checkpoints(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_events_message_date
  ON payment_events(message_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_events_status
  ON payment_events(processing_status, message_date DESC);

CREATE INDEX IF NOT EXISTS idx_deposit_events_tag_status
  ON deposit_events(payment_tag_normalized, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_routing_logs_payment
  ON payment_routing_logs(payment_event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_listener_logs_created
  ON payment_listener_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_sync_logs_created
  ON account_sync_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_info_history_user_created
  ON registration_info_history(telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_outbound_status_created
  ON telegram_outbound_messages(status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_telegram_outbound_contact_created
  ON telegram_outbound_messages(contact_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_outbound_client_request
  ON telegram_outbound_messages(client_request_id, contact_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_jobs_status_created
  ON bot_jobs(status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_created
  ON bot_jobs(contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_telegram_message
  ON bot_jobs(contact_id, job_type, incoming_telegram_message_id);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created
  ON settings_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_ai_training_contact_created
  ON staff_ai_training_examples(contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_ai_training_outcome_created
  ON staff_ai_training_examples(outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_methods_active_order
  ON payment_methods(is_active, display_order ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_payment_qr_codes_method_default
  ON payment_qr_codes(payment_method_id, is_active, is_default, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_payment_windows_contact_status
  ON registration_payment_windows(contact_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS ledger_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_users_username
  ON ledger_users(username);
