import asyncio
import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from urllib import request

from dotenv import load_dotenv
from telethon import TelegramClient, events, Button
from telethon.tl.types import PeerUser, User, UserStatusOffline, UserStatusOnline

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

from db import (  # noqa: E402
    connect_db,
    database_url,
    is_postgres_db,
    messages_insert_sql,
    sql_greatest,
    as_db_bool,
    rollback_if_needed,
    sqlite_path,
)
SESSION_PATH = Path(os.getenv("TELEGRAM_ACCOUNT_SESSION", "./data/telegram-business.session"))
if not SESSION_PATH.is_absolute():
    SESSION_PATH = ROOT / SESSION_PATH
MEDIA_ROOT = ROOT / "data" / "media" / "business-profile-photos"
IMPORT_LIMIT = int(os.getenv("TELEGRAM_ACCOUNT_IMPORT_LIMIT_PER_DIALOG", "0"))
NODE_NOTIFY_URL = os.getenv("SYNC_NOTIFY_URL", "http://localhost:4300/api/internal/telegram-account-sync/notify")
SYNC_NOTIFY_TOKEN = os.getenv("SYNC_NOTIFY_TOKEN", "change_this_local_sync_token")
SYNC_ACCOUNT = {"id": None, "username": None}
PROFILE_PHOTOS_ENABLED = False
DEBUG = os.getenv("DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
DEBUG = os.getenv("DEBUG", "").strip().lower() in ("1", "true", "yes")
PERSONAL_PRIVATE_SYNC_DISABLED = True


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_iso(value):
    if not value:
        return now_iso()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def json_default(value):
    if isinstance(value, datetime):
        return utc_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def log_sync(db, event_type, message, level="info", metadata=None, commit=True):
    db.execute(
        """
        INSERT INTO account_sync_logs (level, event_type, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (level, event_type, message, json.dumps(metadata or {}, default=json_default), now_iso()),
    )
    if commit:
        db.commit()
    if level == "error" or event_type not in (
        "message_imported",
        "duplicate_ignored",
        "live_message_received",
        "outbound_claimed",
        "outbound_sent",
        "outbound_failed",
    ) or DEBUG:
        print(f"[account-sync:{level}] {event_type}: {message}")


def log_debug(db, event_type, message, metadata=None, commit=False):
    if DEBUG:
        log_sync(db, event_type, message, metadata=metadata, commit=commit)


def personal_private_sync_disabled_reason():
    return (
        "Personal Telegram private-chat sync is permanently disabled. "
        "Use TELEGRAM_BOT_TOKEN / the official BotFather bot for user contacts."
    )


def is_personal_private_sync_enabled():
    # Fail closed by design. This worker must never import or process PeerUser
    # private chats, even if launched directly or TELEGRAM_ACCOUNT_SYNC_ENABLED
    # is accidentally set to true.
    return False


def database_label(db):
    if is_postgres_db(db):
        try:
            return f"postgres:{database_url().split('@', 1)[-1]}"
        except Exception:
            return "postgres"
    return f"sqlite:{sqlite_path()}"


def ensure_checkpoint_storage(db):
    if is_postgres_db(db):
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_account_sync_checkpoints (
              telegram_user_id BIGINT PRIMARY KEY,
              last_synced_message_id BIGINT NOT NULL DEFAULT 0,
              last_sync_at TEXT,
              updated_at TEXT NOT NULL DEFAULT NOW()::TEXT
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_telegram_account_sync_checkpoints_updated ON telegram_account_sync_checkpoints(updated_at DESC)"
        )
    else:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_account_sync_checkpoints (
              telegram_user_id INTEGER PRIMARY KEY,
              last_synced_message_id INTEGER NOT NULL DEFAULT 0,
              last_sync_at TEXT,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_telegram_account_sync_checkpoints_updated ON telegram_account_sync_checkpoints(updated_at DESC)"
        )
    db.commit()


def checkpoint_counts(db):
    typed = db.execute("SELECT COUNT(*) AS count FROM telegram_account_sync_checkpoints").fetchone()
    mirrored = db.execute(
        "SELECT COUNT(*) AS count FROM sync_state WHERE key LIKE ?",
        ("business_account:checkpoint:%",),
    ).fetchone()
    return {
        "typed": int(typed["count"] or 0) if typed else 0,
        "sync_state": int(mirrored["count"] or 0) if mirrored else 0,
    }


def backfill_typed_checkpoints(db):
    all_rows = db.execute(
        """
        SELECT key, value
        FROM sync_state
        WHERE key LIKE ?
        """,
        ("business_account:checkpoint:%",),
    ).fetchall()
    inserted = 0
    for row in all_rows:
        try:
            telegram_id = normalize_telegram_id(str(row["key"]).rsplit(":", 1)[-1])
            message_id, last_sync_at = parse_checkpoint_value(row["value"])
        except Exception:
            continue
        if message_id <= 0:
            continue
        sync_at = last_sync_at or now_iso()
        db.execute(
            """
            INSERT INTO telegram_account_sync_checkpoints (
              telegram_user_id, last_synced_message_id, last_sync_at, updated_at
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_user_id) DO NOTHING
            """,
            (telegram_id, message_id, sync_at, sync_at),
        )
        inserted += 1
    db.commit()
    return inserted


def update_sync_state(db, **patch):
    columns = {
        "status": "disabled",
        "last_started_at": None,
        "last_connected_at": None,
        "last_import_completed_at": None,
        "last_error": None,
        "account_user_id": None,
        "account_username": None,
        "imported_contacts": 0,
        "imported_messages": 0,
    }
    existing = db.execute("SELECT * FROM telegram_account_sync_state WHERE id = 1").fetchone()
    if existing:
        columns.update({key: existing[key] for key in columns.keys()})
    columns.update(patch)
    columns["updated_at"] = now_iso()
    db.execute(
        """
        INSERT INTO telegram_account_sync_state (
          id, status, last_started_at, last_connected_at, last_import_completed_at, last_error,
          account_user_id, account_username, imported_contacts, imported_messages, updated_at
        )
        VALUES (1, :status, :last_started_at, :last_connected_at, :last_import_completed_at, :last_error,
          :account_user_id, :account_username, :imported_contacts, :imported_messages, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          last_started_at = excluded.last_started_at,
          last_connected_at = excluded.last_connected_at,
          last_import_completed_at = excluded.last_import_completed_at,
          last_error = excluded.last_error,
          account_user_id = excluded.account_user_id,
          account_username = excluded.account_username,
          imported_contacts = excluded.imported_contacts,
          imported_messages = excluded.imported_messages,
          updated_at = excluded.updated_at
        """,
        columns,
    )
    db.commit()


def notify_node(event_type, payload=None):
    body = json.dumps({"type": event_type, "payload": payload or {}}).encode("utf-8")
    req = request.Request(
        NODE_NOTIFY_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Sync-Token": SYNC_NOTIFY_TOKEN,
        },
        method="POST",
    )
    try:
        request.urlopen(req, timeout=2).read()
    except Exception:
        pass


def display_name(user):
    parts = [user.first_name, user.last_name]
    name = " ".join([part for part in parts if part])
    if name:
        return name
    if user.username:
        return f"@{user.username}"
    return f"Telegram {user.id}"


def presence(user):
    status = getattr(user, "status", None)
    if isinstance(status, UserStatusOnline):
        return "online", utc_iso(status.expires)
    if isinstance(status, UserStatusOffline):
        return "offline", utc_iso(status.was_online)
    if status:
        return status.__class__.__name__.replace("UserStatus", "").lower(), None
    return None, None


async def cache_profile_photo(client, db, crm_user_id, telegram_id):
    """Disabled by default. Set PROFILE_PHOTOS_ENABLED=True to re-enable."""
    if not PROFILE_PHOTOS_ENABLED:
        return
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    destination = MEDIA_ROOT / f"{telegram_id}.jpg"
    try:
        downloaded = await client.download_profile_photo(telegram_id, file=str(destination))
    except Exception:
        downloaded = None
    if downloaded:
        rel_url = f"/media/business-profile-photos/{destination.name}"
        db.execute(
            "UPDATE telegram_users SET profile_photo_url = ?, updated_at = ? WHERE id = ?",
            (rel_url, now_iso(), crm_user_id),
        )

def assign_coadmin_to_contact(db, crm_user_id, seen_at):
    row = db.execute("SELECT * FROM coadmin_settings WHERE id = 1").fetchone()
    if not row:
        return
    snapshot = {
        "coadmin_name": row["coadmin_name"],
        "coadmin_code": row["coadmin_code"],
        "appbeg_coadmin_uid": row["appbeg_coadmin_uid"],
    }
    if not any(snapshot.values()):
        return

    db.execute(
        """
        INSERT INTO contact_automation_state (telegram_user_id, registration_info_json, intents_json)
        VALUES (?, '{}', '{}')
        ON CONFLICT(telegram_user_id) DO NOTHING
        """,
        (crm_user_id,),
    )
    state = db.execute(
        "SELECT registration_info_json FROM contact_automation_state WHERE telegram_user_id = ?",
        (crm_user_id,),
    ).fetchone()
    info = json.loads(state["registration_info_json"] or "{}")

    if all(info.get(key) == value for key, value in snapshot.items() if value):
        return

    changed = False
    for key, value in snapshot.items():
        if value and info.get(key) != value:
            info[key] = value
            changed = True
    if not changed:
        return

    db.execute(
        """
        UPDATE contact_automation_state
        SET registration_info_json = ?, updated_at = ?
        WHERE telegram_user_id = ?
        """,
        (json.dumps(info), now_iso(), crm_user_id),
    )
    label = snapshot["coadmin_name"] or "Coadmin"
    code = f" ({snapshot['coadmin_code']})" if snapshot.get("coadmin_code") else ""
    db.execute(
        """
        INSERT INTO activity_events (telegram_user_id, event_type, title, body, actor_name, metadata_json, created_at)
        VALUES (?, 'coadmin_assigned', 'Coadmin Assigned', ?, 'Telethon', ?, ?)
        """,
        (
            crm_user_id,
            f"Assigned to {label}{code}.",
            json.dumps(snapshot),
            seen_at,
        ),
    )


def upsert_contact(db, user, seen_at):
    account_id = SYNC_ACCOUNT.get("id")
    account_username = SYNC_ACCOUNT.get("username")
    presence_status, last_online_at = presence(user)
    existing = db.execute("SELECT * FROM telegram_users WHERE telegram_id = ?", (user.id,)).fetchone()
    if existing:
        greatest_seen = sql_greatest("last_seen")
        db.execute(
            f"""
            UPDATE telegram_users
            SET username = ?, first_name = ?, last_name = ?, display_name = ?, phone_number = ?,
                is_bot = ?, presence_status = COALESCE(?, presence_status),
                last_online_at = COALESCE(?, last_online_at), last_seen = {greatest_seen},
                telegram_sync_source = COALESCE(telegram_sync_source, 'business_account'),
                telegram_source_account_id = COALESCE(telegram_source_account_id, ?),
                telegram_source_account_username = COALESCE(telegram_source_account_username, ?),
                updated_at = ?
            WHERE telegram_id = ?
            """,
            (
                user.username,
                user.first_name,
                user.last_name,
                display_name(user),
                getattr(user, "phone", None),
                as_db_bool(user.bot),
                presence_status,
                last_online_at,
                seen_at,
                str(account_id) if account_id else None,
                account_username,
                now_iso(),
                user.id,
            ),
        )
        return db.execute("SELECT * FROM telegram_users WHERE telegram_id = ?", (user.id,)).fetchone()

    db.execute(
        """
        INSERT INTO telegram_users (
          telegram_id, username, first_name, last_name, display_name, phone_number, is_bot,
          presence_status, last_online_at, telegram_sync_source,
          telegram_source_account_id, telegram_source_account_username,
          first_seen, last_seen, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'business_account', ?, ?, ?, ?, ?)
        """,
        (
            user.id,
            user.username,
            user.first_name,
            user.last_name,
            display_name(user),
            getattr(user, "phone", None),
            as_db_bool(user.bot),
            presence_status,
            last_online_at,
            str(account_id) if account_id else None,
            account_username,
            seen_at,
            seen_at,
            now_iso(),
        ),
    )
    row = db.execute("SELECT * FROM telegram_users WHERE telegram_id = ?", (user.id,)).fetchone()
    crm_user_id = row["id"]
    db.execute(
        """
        INSERT INTO activity_events (telegram_user_id, event_type, title, body, actor_name, metadata_json, created_at)
        VALUES (?, 'user_created', 'User Created', 'Telegram business account contact synchronized.', 'Telethon', NULL, ?)
        """,
        (crm_user_id, seen_at),
    )
    assign_coadmin_to_contact(db, crm_user_id, seen_at)
    db.execute(
        """
        INSERT INTO bot_sessions (telegram_user_id, current_screen, state_stack_json, context_json)
        VALUES (?, 'Home', '[]', '{}')
        ON CONFLICT(telegram_user_id) DO NOTHING
        """,
        (crm_user_id,),
    )
    return db.execute("SELECT * FROM telegram_users WHERE id = ?", (crm_user_id,)).fetchone()


def ensure_conversation(db, crm_user_id, activity_at):
    db.execute(
        """
        INSERT INTO conversations (telegram_user_id, first_message_at, last_message_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_user_id, channel) DO UPDATE SET updated_at = excluded.updated_at
        """,
        (crm_user_id, activity_at, activity_at, now_iso()),
    )
    return db.execute(
        "SELECT * FROM conversations WHERE telegram_user_id = ? AND channel = 'telegram_private'",
        (crm_user_id,),
    ).fetchone()


def message_type(message):
    if message.text:
        return "text"
    if message.photo:
        return "image"
    if message.video:
        return "video"
    if message.voice:
        return "voice"
    if message.document:
        return "document"
    return "unknown"


def message_payload(message, sync_kind):
    payload = {
        "id": message.id,
        "out": message.out,
        "date": utc_iso(message.date),
        "message_type": message_type(message),
        "peer_id": str(message.peer_id),
        "sync_kind": sync_kind,
    }
    try:
        payload["raw"] = message.to_dict()
    except Exception:
        pass
    return payload


def store_message(db, crm_user_id, conversation_id, message, sync_kind="imported"):
    sent_at = utc_iso(message.date)
    direction = "outgoing" if message.out else "incoming"
    sender_type = "staff" if message.out else "telegram_user"
    mtype = message_type(message)
    text = message.text or ""
    payload = message_payload(message, sync_kind)
    cursor = db.execute(
        messages_insert_sql(),
        (conversation_id, crm_user_id, message.id, direction, sender_type, mtype, text, json.dumps(payload, default=json_default), sent_at),
    )
    if cursor.rowcount:
        db.execute(
            "UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?",
            (sent_at, now_iso(), conversation_id),
        )
        greatest_seen = sql_greatest("last_seen")
        db.execute(
            f"UPDATE telegram_users SET last_seen = {greatest_seen}, updated_at = ? WHERE id = ?",
            (sent_at, now_iso(), crm_user_id),
        )
        db.execute(
            """
            INSERT INTO activity_events (telegram_user_id, event_type, title, body, actor_name, metadata_json, created_at)
            VALUES (?, ?, ?, ?, 'Telethon', ?, ?)
            """,
            (
                crm_user_id,
                "outgoing_message" if direction == "outgoing" else "incoming_message",
                "Outgoing Message" if direction == "outgoing" else "Incoming Message",
                text or f"[{mtype}]",
                json.dumps({"conversationId": conversation_id, "telegramMessageId": message.id, "source": "business_account", "sync_kind": sync_kind}),
                sent_at,
            ),
        )
        return True
    return False


def normalize_telegram_id(telegram_id):
    return int(str(telegram_id).strip())


def parse_checkpoint_value(value):
    if value is None:
        return 0, None
    if isinstance(value, dict):
        return int(value.get("last_synced_message_id", 0) or 0), value.get("last_sync_at")
    try:
        data = json.loads(value)
        if isinstance(data, dict):
            return int(data.get("last_synced_message_id", 0) or 0), data.get("last_sync_at")
        return int(data or 0), None
    except (json.JSONDecodeError, TypeError, ValueError):
        return int(value or 0), None


def get_checkpoint(db, telegram_id):
    normalized_id = normalize_telegram_id(telegram_id)
    row = db.execute(
        """
        SELECT last_synced_message_id, last_sync_at
        FROM telegram_account_sync_checkpoints
        WHERE telegram_user_id = ?
        """,
        (normalized_id,),
    ).fetchone()
    if row:
        return int(row["last_synced_message_id"] or 0), row["last_sync_at"], "typed"

    key = f"business_account:checkpoint:{normalized_id}"
    row = db.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    if row:
        checkpoint, last_sync_at = parse_checkpoint_value(row["value"])
        return checkpoint, last_sync_at, "sync_state"

    legacy = db.execute(
        "SELECT value FROM sync_state WHERE key = ?",
        (f"business_account:last_message_id:{normalized_id}",),
    ).fetchone()
    if legacy:
        checkpoint, last_sync_at = parse_checkpoint_value(legacy["value"])
        return checkpoint, last_sync_at, "legacy"

    return 0, None, "none"


def set_checkpoint(db, telegram_id, message_id):
    normalized_id = normalize_telegram_id(telegram_id)
    normalized_message_id = int(message_id or 0)
    sync_at = now_iso()
    db.execute(
        """
        INSERT INTO telegram_account_sync_checkpoints (
          telegram_user_id, last_synced_message_id, last_sync_at, updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          last_synced_message_id = excluded.last_synced_message_id,
          last_sync_at = excluded.last_sync_at,
          updated_at = excluded.updated_at
        """,
        (normalized_id, normalized_message_id, sync_at, sync_at),
    )
    key = f"business_account:checkpoint:{normalized_id}"
    value = json.dumps({
        "telegram_user_id": normalized_id,
        "last_synced_message_id": normalized_message_id,
        "last_sync_at": sync_at,
    })
    db.execute(
        """
        INSERT INTO sync_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, sync_at),
    )
    legacy_key = f"business_account:last_message_id:{normalized_id}"
    db.execute(
        """
        INSERT INTO sync_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (legacy_key, str(normalized_message_id), sync_at),
    )


async def sync_dialog(client, db, entity, full_import=False):
    if not is_personal_private_sync_enabled():
        return 0, 0
    if not isinstance(entity, User) or entity.bot or entity.deleted:
        return 0, 0

    checkpoint, last_sync_at, checkpoint_source = (0, None, "full_import") if full_import else get_checkpoint(db, entity.id)
    contact_label = f"@{entity.username}" if entity.username else str(entity.id)
    log_sync(
        db,
        "checkpoint_found",
        f"Contact {entity.id} checkpoint={checkpoint}",
        metadata={
            "telegram_user_id": normalize_telegram_id(entity.id),
            "contact": contact_label,
            "checkpoint": checkpoint,
            "last_sync_at": last_sync_at,
            "checkpoint_source": checkpoint_source,
            "database": database_label(db),
        },
    )
    messages = []
    limit = None if full_import or IMPORT_LIMIT <= 0 else IMPORT_LIMIT
    async for message in client.iter_messages(entity, min_id=checkpoint, limit=limit, reverse=True):
        messages.append(message)

    if not messages:
        contact = upsert_contact(db, entity, now_iso())
        await cache_profile_photo(client, db, contact["id"], entity.id)
        set_checkpoint(db, entity.id, checkpoint)
        db.commit()
        log_sync(
            db,
            "no_new_messages",
            f"Contact {entity.id} synced with 0 new messages.",
            metadata={
                "telegram_user_id": normalize_telegram_id(entity.id),
                "contact": contact_label,
                "checkpoint": checkpoint,
                "imported_count": 0,
                "duplicate_count": 0,
                "database": database_label(db),
            },
        )
        return 1, 0

    first_seen = utc_iso(messages[0].date)
    contact = upsert_contact(db, entity, first_seen)
    await cache_profile_photo(client, db, contact["id"], entity.id)
    conversation = ensure_conversation(db, contact["id"], first_seen)
    imported = 0
    duplicates = 0
    max_id = checkpoint
    for message in messages:
        if store_message(db, contact["id"], conversation["id"], message, sync_kind="imported"):
            imported += 1
            if DEBUG:
                log_sync(
                    db,
                    "message_imported",
                    f"Imported message {message.id} for {contact_label}.",
                    metadata={"telegram_user_id": normalize_telegram_id(entity.id), "message_id": int(message.id)},
                    commit=False,
                )
        else:
            duplicates += 1
        max_id = max(max_id, message.id)

    if max_id:
        set_checkpoint(db, entity.id, max_id)
    db.commit()
    log_sync(
        db,
        "contact_synced",
        f"Contact {entity.id} synced with {imported} new messages ({duplicates} duplicates).",
        metadata={
            "telegram_user_id": normalize_telegram_id(entity.id),
            "contact": contact_label,
            "checkpoint": checkpoint,
            "last_synced_message_id": max_id,
            "imported_count": imported,
            "duplicate_count": duplicates,
            "database": database_label(db),
        },
    )
    return 1, imported


async def initial_import(client, db):
    if not is_personal_private_sync_enabled():
        update_sync_state(db, status="disabled", last_error=None)
        log_sync(db, "private_sync_disabled", "Private dialog import skipped. Personal Telegram sync is disabled.")
        notify_node("disabled", {"reason": "personal_private_sync_disabled"})
        return

    contacts = 0
    messages = 0
    update_sync_state(db, status="importing", last_error=None)
    log_sync(db, "dialog_import_started", "Private dialog import started.")
    notify_node("import_started", {})

    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        if not isinstance(entity, User) or entity.bot or entity.deleted:
            continue
        try:
            contact_count, message_count = await sync_dialog(client, db, entity)
            contacts += contact_count
            messages += message_count
            update_sync_state(db, status="importing", imported_contacts=contacts, imported_messages=messages)
            notify_node("progress", {"contacts": contacts, "messages": messages})
        except Exception as exc:
            rollback_if_needed(db)
            log_sync(
                db,
                "error",
                f"Failed to sync dialog for {getattr(entity, 'username', None) or entity.id}: {exc}",
                level="error",
                metadata={"telegram_id": getattr(entity, "id", None), "error": str(exc)},
            )
            update_sync_state(db, status="importing", last_error=str(exc))
            continue

    update_sync_state(
        db,
        status="connected",
        last_import_completed_at=now_iso(),
        imported_contacts=contacts,
        imported_messages=messages,
        last_error=None,
    )
    log_sync(
        db,
        "dialog_import_completed",
        f"Dialog import completed ({contacts} contacts, {messages} messages).",
        metadata={"contacts": contacts, "messages": messages},
    )
    notify_node("import_complete", {"contacts": contacts, "messages": messages})


def credentials():
    api_id = os.getenv("TELEGRAM_ACCOUNT_API_ID")
    api_hash = os.getenv("TELEGRAM_ACCOUNT_API_HASH")
    if not api_id or not api_hash:
        raise RuntimeError("TELEGRAM_ACCOUNT_API_ID and TELEGRAM_ACCOUNT_API_HASH are required.")
    return int(api_id), api_hash


def build_client():
    api_id, api_hash = credentials()
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    return TelegramClient(
        str(SESSION_PATH),
        api_id,
        api_hash,
        auto_reconnect=True,
        connection_retries=None,
        retry_delay=5,
    )


async def login():
    client = build_client()
    await client.start()
    me = await client.get_me()
    print(f"Logged in as {me.id} @{me.username or ''}".strip())
    await client.disconnect()


def build_inline_buttons(button_rows):
    """
    Convert buttons_json rows into Telethon Button.inline rows.

    Accepted button shapes:
      {"text": "...", "data": "..."}
      {"label": "...", "action": "..."}
      {"text": "...", "callback_data": "..."}
    """
    if not button_rows:
        return None
    rows = []
    for row in button_rows:
        if not isinstance(row, list):
            row = [row]
        built_row = []
        for button in row:
            if not isinstance(button, dict):
                continue
            label = (
                button.get("text")
                or button.get("label")
                or button.get("title")
                or "Button"
            )
            action = (
                button.get("data")
                or button.get("action")
                or button.get("callback_data")
                or "noop"
            )
            action = str(action)
            # Telegram callback_data must be <= 64 bytes.
            encoded = action.encode("utf-8")
            if len(encoded) > 64:
                print(
                    f"[telegram-outbound] skipping button with oversized callback_data ({len(encoded)} bytes): {action}",
                    flush=True,
                )
                continue
            built = Button.inline(str(label), encoded)
            print(
                f"[telegram-outbound] built Button.inline text={label!r} data={action!r} "
                f"type={type(built)!r} repr={built!r}",
                flush=True,
            )
            built_row.append(built)
        if built_row:
            rows.append(built_row)
    return rows or None


def log_buttons_just_before_send(buttons, *, outbound_id=None, raw_buttons_json=None):
    """Log the exact object passed into client.send_message(buttons=...)."""
    prefix = f"[telegram-outbound] send_message buttons id={outbound_id}"
    print(f"{prefix} raw_buttons_json={raw_buttons_json!r}", flush=True)
    print(f"{prefix} type={type(buttons)!r}", flush=True)
    print(f"{prefix} repr={buttons!r}", flush=True)
    if buttons is None:
        print(f"{prefix} value=None (NO BUTTONS WILL BE SENT)", flush=True)
        return
    try:
        print(f"{prefix} len={len(buttons)}", flush=True)
    except TypeError:
        print(f"{prefix} len=<not sized>", flush=True)
    if isinstance(buttons, list):
        for row_index, row in enumerate(buttons):
            print(f"{prefix} row[{row_index}] type={type(row)!r} repr={row!r}", flush=True)
            if isinstance(row, list):
                for col_index, button in enumerate(row):
                    print(
                        f"{prefix} row[{row_index}][{col_index}] type={type(button)!r} repr={button!r}",
                        flush=True,
                    )


def reply_markup_summary(message):
    markup = getattr(message, "reply_markup", None)
    if markup is None:
        return {"present": False, "type": None, "rows": 0}
    rows = getattr(markup, "rows", None) or []
    return {
        "present": True,
        "type": type(markup).__name__,
        "rows": len(rows),
        "repr": repr(markup),
    }


def normalize_callback_action(action):
    raw = (action or "").strip()
    aliases = {
        "register": "bot:register",
        "staff": "staff:takeover",
        "talk_to_staff": "staff:takeover",
        "confirm": "bot:confirm",
        "edit": "bot:edit",
        "cancel": "bot:cancel",
    }
    return aliases.get(raw, raw)


def log_outbound(phase, outbound_id, **extra):
    suffix = " ".join(f"{key}={extra[key]}" for key in extra)
    line = f"[telegram-outbound] {phase} id={outbound_id}"
    if suffix:
        line = f"{line} {suffix}"
    print(line, flush=True)


def check_outbound_nudge(db):
    row = db.execute(
        "SELECT value FROM sync_state WHERE key = 'outbound_queue:nudge'"
    ).fetchone()
    if not row:
        return False
    db.execute("DELETE FROM sync_state WHERE key = 'outbound_queue:nudge'")
    db.commit()
    return True


def ensure_outbound_queue_storage(db):
    if is_postgres_db(db):
        db.execute(
            """
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
            )
            """
        )
        db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN IF NOT EXISTS buttons_json TEXT NOT NULL DEFAULT '[]'")
        db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN IF NOT EXISTS media_path TEXT")
        db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'")
    else:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_outbound_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              contact_id INTEGER NOT NULL,
              telegram_user_id TEXT NOT NULL,
              body TEXT NOT NULL,
              buttons_json TEXT NOT NULL DEFAULT '[]',
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
            )
            """
        )
        columns = [row["name"] for row in db.execute("PRAGMA table_info(telegram_outbound_messages)").fetchall()]
        if "buttons_json" not in columns:
            db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN buttons_json TEXT NOT NULL DEFAULT '[]'")
        if "media_path" not in columns:
            db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN media_path TEXT")
        if "message_type" not in columns:
            db.execute("ALTER TABLE telegram_outbound_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_outbound_status_created ON telegram_outbound_messages(status, created_at ASC, id ASC)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_outbound_contact_created ON telegram_outbound_messages(contact_id, created_at DESC)"
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_outbound_client_request ON telegram_outbound_messages(client_request_id, contact_id) WHERE client_request_id IS NOT NULL"
    )
    db.commit()


def reset_incomplete_outbound(db):
    cursor = db.execute(
        """
        UPDATE telegram_outbound_messages
        SET status = 'failed',
            error_text = 'Worker restarted while message was sending; manual review required to avoid duplicate send.',
            updated_at = ?
        WHERE status = 'sending'
        """,
        (now_iso(),),
    )
    db.commit()
    if cursor.rowcount:
        log_sync(
            db,
            "outbound_stale_failed",
            f"Marked {cursor.rowcount} in-flight outbound message(s) failed after worker restart.",
            level="error",
            metadata={"count": cursor.rowcount},
        )


def claim_pending_outbound(db):
    claimed_at = now_iso()
    if is_postgres_db(db):
        row = db.execute(
            """
            WITH next_outbound AS (
              SELECT id
              FROM telegram_outbound_messages
              WHERE status = 'pending'
              ORDER BY created_at ASC, id ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            UPDATE telegram_outbound_messages q
            SET status = 'sending',
                claimed_at = ?,
                updated_at = ?,
                error_text = NULL
            FROM next_outbound
            WHERE q.id = next_outbound.id
            RETURNING q.*
            """,
            (claimed_at, claimed_at),
        ).fetchone()
        db.commit()
        return row

    db.execute("BEGIN IMMEDIATE")
    row = db.execute(
        """
        SELECT *
        FROM telegram_outbound_messages
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        """
    ).fetchone()
    if not row:
        db.commit()
        return None
    db.execute(
        """
        UPDATE telegram_outbound_messages
        SET status = 'sending', claimed_at = ?, updated_at = ?, error_text = NULL
        WHERE id = ? AND status = 'pending'
        """,
        (claimed_at, claimed_at, row["id"]),
    )
    db.commit()
    return db.execute("SELECT * FROM telegram_outbound_messages WHERE id = ?", (row["id"],)).fetchone()


def parse_buttons_json(value):
    if not value:
        return []
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def mark_outbound_failed(db, outbound_id, error_text):
    db.execute(
        """
        UPDATE telegram_outbound_messages
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE id = ?
        """,
        (str(error_text)[:2000], now_iso(), outbound_id),
    )
    db.commit()


def update_local_outbound_message(db, queue_row, telegram_message_id, sent_at, payload):
    local_message_id = queue_row["local_message_id"]
    if not local_message_id:
        return
    message = db.execute("SELECT * FROM messages WHERE id = ?", (local_message_id,)).fetchone()
    if not message:
        return
    db.execute(
        """
        DELETE FROM messages
        WHERE source = 'business_account'
          AND conversation_id = ?
          AND telegram_message_id = ?
          AND direction = 'outgoing'
          AND id <> ?
        """,
        (message["conversation_id"], telegram_message_id, local_message_id),
    )
    db.execute(
        """
        UPDATE messages
        SET telegram_message_id = ?, payload_json = ?, sent_at = ?
        WHERE id = ?
        """,
        (telegram_message_id, json.dumps(payload, default=json_default), sent_at, local_message_id),
    )
    db.execute(
        "UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?",
        (sent_at, now_iso(), message["conversation_id"]),
    )


def mark_outbound_sent(db, queue_row, telegram_message_id, sent_at, payload):
    update_local_outbound_message(db, queue_row, telegram_message_id, sent_at, payload)
    db.execute(
        """
        UPDATE telegram_outbound_messages
        SET status = 'sent',
            telegram_message_id = ?,
            error_text = NULL,
            sent_at = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (telegram_message_id, sent_at, now_iso(), queue_row["id"]),
    )
    db.commit()


async def process_outbound_row(client, db, queue_row):
    log_outbound(
        "claimed",
        queue_row["id"],
        contact=queue_row["contact_id"],
        telegram=queue_row["telegram_user_id"],
    )
    log_sync(
        db,
        "outbound_claimed",
        f"Claimed outbound queue row {queue_row['id']} for contact {queue_row['contact_id']}.",
        metadata={"outbound_id": queue_row["id"], "contact_id": queue_row["contact_id"]},
        commit=False,
    )
    try:
        entity = await client.get_entity(normalize_telegram_id(queue_row["telegram_user_id"]))
        if not isinstance(entity, User) or entity.bot or entity.deleted:
            raise RuntimeError("Target is not an active private Telegram user.")
        raw_buttons_json = queue_row["buttons_json"]
        parsed_buttons = parse_buttons_json(raw_buttons_json)
        media_path = queue_row["media_path"] if "media_path" in queue_row.keys() else None
        if media_path:
            resolved_media = Path(media_path)
            if not resolved_media.is_absolute():
                resolved_media = ROOT / media_path
            if not resolved_media.exists():
                raise RuntimeError(f"Outbound media file not found: {resolved_media}")
            print(
                f"[telegram-outbound] calling client.send_file("
                f"entity={getattr(entity, 'id', entity)!r}, "
                f"file={resolved_media!r}, "
                f"caption=<len {len(queue_row['body'] or '')}>)",
                flush=True,
            )
            message = await client.send_file(
                entity,
                str(resolved_media),
                caption=queue_row["body"] or None,
            )
        else:
            print(
                f"[telegram-outbound] reconstruct id={queue_row['id']} "
                f"raw_buttons_json={raw_buttons_json!r} parsed={parsed_buttons!r}",
                flush=True,
            )
            buttons = build_inline_buttons(parsed_buttons)
            button_count = sum(len(row) for row in buttons) if buttons else 0
            log_buttons_just_before_send(
                buttons,
                outbound_id=queue_row["id"],
                raw_buttons_json=raw_buttons_json,
            )
            # Explicit kwargs — never omit buttons= when we intended a keyboard.
            print(
                f"[telegram-outbound] calling client.send_message("
                f"entity={getattr(entity, 'id', entity)!r}, "
                f"message=<len {len(queue_row['body'] or '')}>, "
                f"buttons={buttons!r})",
                flush=True,
            )
            message = await client.send_message(
                entity,
                queue_row["body"],
                buttons=buttons,
            )
            markup_info = reply_markup_summary(message)
            print(
                f"[telegram-outbound] send_message returned message_id={message.id} "
                f"reply_markup={markup_info!r}",
                flush=True,
            )
            if button_count and not markup_info.get("present"):
                # User/business accounts often accept the send but strip inline
                # callback buttons. Treat that as a hard failure so we stop lying.
                raise RuntimeError(
                    "Telethon send returned message WITHOUT reply_markup even though "
                    f"{button_count} Button.inline object(s) were passed. "
                    "Inline callback buttons require a Bot API sender "
                    "(TELEGRAM_BOT_TOKEN), not a user/business account session."
                )
        if media_path:
            button_count = 0
            markup_info = reply_markup_summary(message)
        else:
            button_count = sum(len(row) for row in buttons) if buttons else 0
        payload = {
            "ok": True,
            "message_id": message.id,
            "date": utc_iso(message.date),
            "telegram_id": entity.id,
            "sync_kind": "queued",
            "source": "business_account",
            "outboundQueueId": queue_row["id"],
            "buttons": parsed_buttons,
            "reply_markup": markup_info,
        }
        mark_outbound_sent(db, queue_row, message.id, utc_iso(message.date), payload)
        log_outbound(
            "sent",
            queue_row["id"],
            contact=queue_row["contact_id"],
            telegram_message_id=message.id,
            buttons=button_count,
            reply_markup=markup_info.get("present"),
        )
        if button_count:
            print(
                f"[telegram-outbound] welcome_buttons_sent id={queue_row['id']} "
                f"contact={queue_row['contact_id']} telegram_message_id={message.id} "
                f"buttons={button_count} reply_markup_present={markup_info.get('present')}",
                flush=True,
            )
            log_sync(
                db,
                "welcome_buttons_sent",
                f"Sent outbound queue row {queue_row['id']} with {button_count} inline button(s).",
                metadata={
                    "outbound_id": queue_row["id"],
                    "contact_id": queue_row["contact_id"],
                    "telegram_message_id": message.id,
                    "buttons": parsed_buttons,
                    "reply_markup": markup_info,
                },
                commit=False,
            )
        log_sync(
            db,
            "outbound_sent",
            f"Sent outbound queue row {queue_row['id']} as Telegram message {message.id}.",
            metadata={
                "outbound_id": queue_row["id"],
                "contact_id": queue_row["contact_id"],
                "telegram_message_id": message.id,
                "buttons": button_count,
                "reply_markup": markup_info,
            },
        )
        notify_node(
            "message",
            {
                "contactId": queue_row["contact_id"],
                "telegramId": entity.id,
                "telegramMessageId": message.id,
                "direction": "outgoing",
                "text": queue_row["body"],
            },
        )
    except Exception as exc:
        rollback_if_needed(db)
        mark_outbound_failed(db, queue_row["id"], str(exc))
        log_outbound(
            "failed",
            queue_row["id"],
            contact=queue_row["contact_id"],
            error=str(exc),
        )
        log_sync(
            db,
            "outbound_failed",
            f"Outbound queue row {queue_row['id']} failed: {exc}",
            level="error",
            metadata={"outbound_id": queue_row["id"], "contact_id": queue_row["contact_id"], "error": str(exc)},
        )
        notify_node(
            "outbound_failed",
            {
                "contactId": queue_row["contact_id"],
                "telegramId": queue_row["telegram_user_id"],
                "outboundId": queue_row["id"],
                "error": str(exc),
            },
        )


async def outbound_queue_loop(client):
    db = connect_db()
    ensure_outbound_queue_storage(db)
    reset_incomplete_outbound(db)
    print("[telegram-outbound] processor started", flush=True)
    try:
        while True:
            processed = 0
            while True:
                queue_row = claim_pending_outbound(db)
                if not queue_row:
                    break
                processed += 1
                await process_outbound_row(client, db, queue_row)

            nudged = check_outbound_nudge(db)
            if processed == 0 and not nudged:
                await asyncio.sleep(1.5)
            elif processed == 0:
                await asyncio.sleep(0.2)
    finally:
        db.close()


async def send_outbound(telegram_user_id, text):
    raise RuntimeError("Direct send is disabled. Insert into telegram_outbound_messages and let the sync worker send it.")


def attach_outgoing_live_message(db, crm_user_id, message):
    if not message.out:
        return False
    row = db.execute(
        """
        SELECT *
        FROM telegram_outbound_messages
        WHERE contact_id = ?
          AND status IN ('sending', 'sent')
          AND telegram_message_id IS NULL
          AND body = ?
        ORDER BY claimed_at ASC, id ASC
        LIMIT 1
        """,
        (crm_user_id, message.text or ""),
    ).fetchone()
    if not row:
        return False
    payload = message_payload(message, "live")
    payload["outboundQueueId"] = row["id"]
    mark_outbound_sent(db, row, message.id, utc_iso(message.date), payload)
    return True



async def sync_forever():
    db = connect_db()
    ensure_checkpoint_storage(db)
    ensure_outbound_queue_storage(db)
    if not is_personal_private_sync_enabled():
        update_sync_state(db, status="disabled", last_error=None)
        log_sync(db, "private_sync_disabled", personal_private_sync_disabled_reason())
        print("[account-sync] Personal Telegram private-chat sync is disabled; worker exiting without importing contacts.", flush=True)
        notify_node("disabled", {"reason": "personal_private_sync_disabled"})
        db.close()
        return

    backfilled = backfill_typed_checkpoints(db)
    counts = checkpoint_counts(db)
    update_sync_state(db, status="starting", last_started_at=now_iso(), last_error=None)
    log_sync(
        db,
        "sync_started",
        f"Business Telegram account sync worker started using {database_label(db)}.",
        metadata={
            "database_type": "postgres" if is_postgres_db(db) else "sqlite",
            "database_url_set": bool(database_url()),
            "checkpoint_count": counts,
            "backfilled_checkpoints": backfilled,
            "debug": DEBUG,
        },
    )

    client = build_client()

    @client.on(events.NewMessage)
    async def on_new_message(event):
        try:
            if not is_personal_private_sync_enabled():
                return
            if not isinstance(event.message.peer_id, PeerUser):
                return
            entity = await event.get_chat()
            if not isinstance(entity, User) or entity.bot or entity.deleted:
                return
            contact = upsert_contact(db, entity, utc_iso(event.message.date))
            await cache_profile_photo(client, db, contact["id"], entity.id)
            conversation = ensure_conversation(db, contact["id"], utc_iso(event.message.date))
            attached_outbound = attach_outgoing_live_message(db, contact["id"], event.message)
            inserted = False if attached_outbound else store_message(db, contact["id"], conversation["id"], event.message, sync_kind="live")
            checkpoint, _, _ = get_checkpoint(db, entity.id)
            set_checkpoint(db, entity.id, max(checkpoint, event.message.id))
            db.commit()
            if inserted:
                if DEBUG:
                    log_sync(
                        db,
                        "live_message_received",
                        f"Live message {event.message.id} from @{entity.username or entity.id}.",
                        metadata={"telegram_id": entity.id, "message_id": event.message.id, "out": event.message.out},
                    )
                if not event.message.out:
                    notify_node(
                        "message",
                        {
                            "contactId": contact["id"],
                            "telegramId": entity.id,
                            "telegramMessageId": event.message.id,
                            "direction": "incoming",
                            "text": event.message.text or "",
                        },
                    )
            else:
                if DEBUG:
                    log_sync(
                        db,
                        "duplicate_ignored",
                        f"Duplicate live message {event.message.id} ignored.",
                        metadata={"telegram_id": entity.id, "message_id": event.message.id},
                    )
        except Exception as exc:
            update_sync_state(db, status="error", last_error=str(exc))
            log_sync(db, "error", f"Live message handler failed: {exc}", level="error")
            notify_node("error", {"error": str(exc)})

    @client.on(events.CallbackQuery)
    async def on_callback(event):
        try:
            if not is_personal_private_sync_enabled():
                return
            if not isinstance(event.peer, PeerUser):
                return
            entity = await event.get_chat()
            if not isinstance(entity, User) or entity.bot or entity.deleted:
                return
            contact = upsert_contact(db, entity, now_iso())
            action = event.data.decode("utf-8") if event.data else ""
            normalized = normalize_callback_action(action)
            try:
                await event.answer()
            except Exception as answer_exc:
                # Answering is best-effort; registration must still proceed.
                if DEBUG:
                    log_sync(
                        db,
                        "callback_answer_failed",
                        f"Callback answer failed: {answer_exc}",
                        level="warning",
                        metadata={"contact_id": contact["id"], "action": action},
                    )
            event_type = "callback_received"
            if normalized in ("bot:register", "register") or action == "register":
                event_type = "register_clicked"
            elif normalized in ("staff:takeover", "staff") or action == "staff":
                event_type = "staff_clicked"
            log_sync(
                db,
                event_type,
                f"Inline button clicked by contact {contact['id']}: {action}",
                metadata={
                    "contact_id": contact["id"],
                    "telegram_id": entity.id,
                    "action": action,
                    "normalized_action": normalized,
                    "message_id": getattr(event, "message_id", None),
                },
            )
            print(
                f"[telegram-callback] {event_type} contact={contact['id']} telegram={entity.id} action={action} normalized={normalized}",
                flush=True,
            )
            notify_node(
                "callback",
                {
                    "contactId": contact["id"],
                    "telegramId": entity.id,
                    "action": normalized or action,
                    "rawAction": action,
                    "messageId": getattr(event, "message_id", None),
                },
            )
        except Exception as exc:
            log_sync(db, "error", f"Callback handler failed: {exc}", level="error")
            print(f"[telegram-callback] failed: {exc}", flush=True)

    outbound_task = None
    import_task = None
    try:
        await client.connect()
        if not await client.is_user_authorized():
            update_sync_state(db, status="login_required", last_error="Run npm run telegram:login to authorize the business account.")
            log_sync(db, "login_required", "Business Telegram session is not authorized.", level="error")
            print("Business Telegram session is not authorized. Run npm run telegram:login.")
            return

        me = await client.get_me()
        SYNC_ACCOUNT["id"] = me.id
        SYNC_ACCOUNT["username"] = me.username
        update_sync_state(
            db,
            status="connected",
            last_connected_at=now_iso(),
            account_user_id=me.id,
            account_username=me.username,
            last_error=None,
        )
        log_sync(
            db,
            "account_connected",
            f"Connected as @{me.username or me.id}.",
            metadata={"account_user_id": me.id, "account_username": me.username},
        )
        notify_node("connected", {"accountUserId": me.id, "username": me.username})

        outbound_task = asyncio.create_task(outbound_queue_loop(client))
        log_sync(db, "outbound_queue_started", "Outbound Telegram queue worker started.")
        print("[telegram-outbound] queue worker scheduled", flush=True)

        import_task = asyncio.create_task(initial_import(client, db))
        log_sync(db, "live_listener_started", "Listening for new private messages.")
        print("Business Telegram sync connected and listening.")
        await client.run_until_disconnected()
    except Exception as exc:
        rollback_if_needed(db)
        update_sync_state(db, status="error", last_error=str(exc))
        log_sync(db, "error", f"Sync worker failed: {exc}", level="error")
        notify_node("error", {"error": str(exc)})
        raise
    finally:
        for task in (outbound_task, import_task):
            if not task:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        db.close()


if __name__ == "__main__":
    from process_lock import SyncWorkerLock

    command = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if command == "login":
        asyncio.run(login())
    elif command == "sync":
        worker_lock = SyncWorkerLock(SESSION_PATH, label="account-sync")
        if not worker_lock.acquire():
            print(worker_lock.already_running_message(), file=sys.stderr)
            raise SystemExit(2)
        try:
            asyncio.run(sync_forever())
        finally:
            worker_lock.release()
    elif command == "send":
        raise SystemExit("Direct send is disabled. Queue messages in telegram_outbound_messages and run the sync worker.")
    else:
        raise SystemExit(f"Unknown command: {command}")
