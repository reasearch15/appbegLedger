import asyncio
import json
import os
import sys

from datetime import date, datetime, timezone
from pathlib import Path
from urllib import request

from telethon import TelegramClient, events

ROOT = Path(__file__).resolve().parents[1]
SESSION_PATH = Path(os.getenv("PAYMENT_TELEGRAM_SESSION", "./data/appbeg-payment.session"))
if not SESSION_PATH.is_absolute():
    SESSION_PATH = ROOT / SESSION_PATH
PAYMENT_GROUP = os.getenv("PAYMENT_TELEGRAM_GROUP") or os.getenv("PAYMENT_GROUP_CHAT_ID")
IMPORT_LIMIT = int(os.getenv("PAYMENT_TELEGRAM_IMPORT_LIMIT", "500"))
NODE_NOTIFY_URL = os.getenv("PAYMENT_SYNC_NOTIFY_URL", "http://localhost:4300/api/internal/payment-sync/notify")
SYNC_NOTIFY_TOKEN = os.getenv("SYNC_NOTIFY_TOKEN", "change_this_local_sync_token")

from dotenv import load_dotenv
from db import connect_db, payment_event_upsert_sql, sql_greatest, as_db_bool  # noqa: E402

load_dotenv(ROOT / ".env")

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


def log_listener(db, event_type, message, level="info", metadata=None):
    db.execute(
        """
        INSERT INTO payment_listener_logs (level, event_type, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (level, event_type, message, json.dumps(metadata or {}, default=json_default), now_iso()),
    )
    db.commit()
    print(f"[payment:{level}] {event_type}: {message}")


def update_sync_state(db, **patch):
    defaults = {
        "status": "disabled",
        "last_started_at": None,
        "last_connected_at": None,
        "last_sync_started_at": None,
        "last_sync_completed_at": None,
        "last_error": None,
        "account_user_id": None,
        "account_username": None,
        "telegram_group_id": None,
        "telegram_group_title": None,
        "last_synced_message_id": 0,
        "imported_messages": 0,
    }
    existing = db.execute("SELECT * FROM payment_sync_state WHERE id = 1").fetchone()
    if existing:
        defaults.update({key: existing[key] for key in defaults.keys()})
    defaults.update(patch)
    defaults["updated_at"] = now_iso()
    db.execute(
        """
        INSERT INTO payment_sync_state (
          id, status, last_started_at, last_connected_at, last_sync_started_at, last_sync_completed_at,
          last_error, account_user_id, account_username, telegram_group_id, telegram_group_title,
          last_synced_message_id, imported_messages, updated_at
        )
        VALUES (1, :status, :last_started_at, :last_connected_at, :last_sync_started_at, :last_sync_completed_at,
          :last_error, :account_user_id, :account_username, :telegram_group_id, :telegram_group_title,
          :last_synced_message_id, :imported_messages, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          last_started_at = excluded.last_started_at,
          last_connected_at = excluded.last_connected_at,
          last_sync_started_at = excluded.last_sync_started_at,
          last_sync_completed_at = excluded.last_sync_completed_at,
          last_error = excluded.last_error,
          account_user_id = excluded.account_user_id,
          account_username = excluded.account_username,
          telegram_group_id = excluded.telegram_group_id,
          telegram_group_title = excluded.telegram_group_title,
          last_synced_message_id = excluded.last_synced_message_id,
          imported_messages = excluded.imported_messages,
          updated_at = excluded.updated_at
        """,
        defaults,
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


def credentials():
    api_id = os.getenv("PAYMENT_TELEGRAM_API_ID")
    api_hash = os.getenv("PAYMENT_TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        raise RuntimeError("PAYMENT_TELEGRAM_API_ID and PAYMENT_TELEGRAM_API_HASH are required for the payment group listener.")
    return int(api_id), api_hash


def group_ref():
    group = os.getenv("PAYMENT_TELEGRAM_GROUP") or os.getenv("PAYMENT_GROUP_CHAT_ID")
    if not group:
        raise RuntimeError("PAYMENT_TELEGRAM_GROUP or PAYMENT_GROUP_CHAT_ID is required.")
    try:
        return int(group)
    except ValueError:
        return group


def sender_name(sender):
    if not sender:
        return None
    parts = [getattr(sender, "first_name", None), getattr(sender, "last_name", None)]
    name = " ".join([part for part in parts if part])
    return name or getattr(sender, "title", None) or getattr(sender, "username", None)


def group_title(entity):
    return getattr(entity, "title", None) or getattr(entity, "username", None) or str(getattr(entity, "id", "unknown"))


def message_payload(message, sender, group):
    payload = message.to_dict()
    payload["_sync"] = {
        "group_id": getattr(group, "id", None),
        "group_title": group_title(group),
        "sender_id": getattr(sender, "id", None),
        "sender_username": getattr(sender, "username", None),
    }
    return payload


def get_checkpoint(db):
    row = db.execute("SELECT last_synced_message_id FROM payment_sync_state WHERE id = 1").fetchone()
    return int(row["last_synced_message_id"]) if row else 0


def set_checkpoint(db, message_id):
    greatest = sql_greatest("last_synced_message_id")
    db.execute(
        f"""
        UPDATE payment_sync_state
        SET last_synced_message_id = {greatest}, updated_at = ?
        WHERE id = 1
        """,
        (message_id, now_iso()),
    )


def store_payment_message(db, message, sender, group, edited=False):
    sent_at = utc_iso(message.date)
    edited_at = utc_iso(message.edit_date) if getattr(message, "edit_date", None) else None
    group_id = int(getattr(group, "id"))
    existing = db.execute(
        "SELECT id FROM payment_events WHERE telegram_group_id = ? AND telegram_message_id = ?",
        (group_id, message.id),
    ).fetchone()
    payload = message_payload(message, sender, group)
    db.execute(
        payment_event_upsert_sql(),
        (
            message.id,
            group_id,
            group_title(group),
            getattr(sender, "id", None),
            sender_name(sender),
            getattr(sender, "username", None),
            message.text or "",
            json.dumps(payload, default=json_default),
            as_db_bool(edited or getattr(message, "edit_date", None)),
            as_db_bool(False),
            sent_at,
            edited_at,
            now_iso(),
        ),
    )
    set_checkpoint(db, message.id)
    db.commit()
    return not existing


async def sync_history(client, db, group):
    checkpoint = get_checkpoint(db)
    imported = 0
    update_sync_state(
        db,
        status="syncing",
        last_sync_started_at=now_iso(),
        last_error=None,
        telegram_group_id=getattr(group, "id", None),
        telegram_group_title=group_title(group),
    )
    log_listener(db, "sync_started", "Payment synchronization started.", metadata={"checkpoint": checkpoint})
    messages = []
    async for message in client.iter_messages(group, min_id=checkpoint, limit=IMPORT_LIMIT, reverse=True):
        messages.append(message)
    for message in messages:
        sender = await message.get_sender()
        if store_payment_message(db, message, sender, group):
            imported += 1
    current_state = db.execute("SELECT imported_messages FROM payment_sync_state WHERE id = 1").fetchone()
    update_sync_state(
        db,
        status="connected",
        last_sync_completed_at=now_iso(),
        imported_messages=int(current_state["imported_messages"] or 0) + imported,
        last_error=None,
    )
    log_listener(db, "sync_completed", "Payment synchronization completed.", metadata={"imported": imported})
    notify_node("sync_complete", {"imported": imported})


async def login():
    api_id, api_hash = credentials()
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(SESSION_PATH), api_id, api_hash)
    await client.start()
    me = await client.get_me()
    print(f"Logged in as {me.id} @{me.username or ''}".strip())
    await client.disconnect()


async def sync_forever():
    api_id, api_hash = credentials()
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = connect_db()
    update_sync_state(db, status="starting", last_started_at=now_iso(), last_error=None)
    log_listener(db, "payment_group_listener_started", "Payment group listener starting.")

    client = TelegramClient(
        str(SESSION_PATH),
        api_id,
        api_hash,
        auto_reconnect=True,
        connection_retries=None,
        retry_delay=5,
    )

    try:
        await client.connect()
        if not await client.is_user_authorized():
            update_sync_state(db, status="login_required", last_error="Run npm run payment:login to authorize the payment account.")
            log_listener(db, "login_required", "Payment Telegram session is not authorized.", level="error")
            notify_node("error", {"error": "Payment Telegram session is not authorized."})
            return

        me = await client.get_me()
        group = await client.get_entity(group_ref())
        update_sync_state(
            db,
            status="connected",
            last_connected_at=now_iso(),
            account_user_id=me.id,
            account_username=me.username,
            telegram_group_id=getattr(group, "id", None),
            telegram_group_title=group_title(group),
            last_error=None,
        )
        log_listener(db, "payment_group_connected", "Payment group listener connected.", metadata={"accountUserId": me.id, "group": group_title(group)})
        notify_node("connected", {"accountUserId": me.id, "username": me.username, "group": group_title(group)})

        @client.on(events.NewMessage(chats=group))
        async def on_new_message(event):
            try:
                sender = await event.message.get_sender()
                inserted_or_updated = store_payment_message(db, event.message, sender, group)
                if inserted_or_updated:
                    log_listener(db, "payment_message_saved", "Payment group message saved.", metadata={"telegramMessageId": event.message.id})
                    notify_node("message", {"telegramMessageId": event.message.id})
                else:
                    log_listener(db, "payment_message_duplicate_skipped", "Duplicate payment group message skipped.", metadata={"telegramMessageId": event.message.id})
            except Exception as exc:
                update_sync_state(db, status="error", last_error=str(exc))
                log_listener(db, "error", str(exc), level="error")
                notify_node("error", {"error": str(exc)})

        @client.on(events.MessageEdited(chats=group))
        async def on_edited_message(event):
            try:
                sender = await event.message.get_sender()
                store_payment_message(db, event.message, sender, group, edited=True)
                log_listener(db, "message_edited", "Payment message edit synchronized.", metadata={"telegramMessageId": event.message.id})
                notify_node("message_edited", {"telegramMessageId": event.message.id})
            except Exception as exc:
                update_sync_state(db, status="error", last_error=str(exc))
                log_listener(db, "error", str(exc), level="error")
                notify_node("error", {"error": str(exc)})

        await sync_history(client, db, group)

        print("Payment Telegram sync connected and listening.")
        await client.run_until_disconnected()
    except Exception as exc:
        update_sync_state(db, status="error", last_error=str(exc))
        log_listener(db, "error", str(exc), level="error")
        notify_node("error", {"error": str(exc)})
        raise
    finally:
        log_listener(db, "disconnected", "Payment listener disconnected.")
        db.close()


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if command == "login":
        asyncio.run(login())
    elif command == "sync":
        asyncio.run(sync_forever())
    else:
        raise SystemExit(f"Unknown command: {command}")
