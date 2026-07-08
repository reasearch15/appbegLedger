"""Shared database connection for AppBeg Ledger Python sync scripts."""

from __future__ import annotations

import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[1]
_NAMED_PARAM_RE = re.compile(r":([a-zA-Z_][\w]*)")


def database_url() -> str | None:
    value = os.getenv("DATABASE_URL", "").strip()
    return value or None


def sqlite_path() -> Path:
    database_path = Path(os.getenv("DATABASE_PATH", "./data/royal-vip-coadmin.sqlite"))
    if not database_path.is_absolute():
        database_path = ROOT / database_path
    return database_path


def is_postgres_db(db: Any) -> bool:
    return isinstance(db, PostgresConnection)


def as_db_bool(value: Any) -> Any:
    return bool(value) if database_url() else (1 if value else 0)


def sql_greatest(column: str, placeholder: str = "?") -> str:
    if database_url():
        return f"GREATEST({column}, {placeholder})"
    return f"MAX({column}, {placeholder})"


def messages_insert_sql() -> str:
    if database_url():
        return """
        INSERT INTO messages (
          conversation_id, telegram_user_id, telegram_message_id, source, direction, sender_type,
          message_type, text, payload_json, sent_at
        )
        VALUES (?, ?, ?, 'business_account', ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, conversation_id, telegram_message_id, direction) WHERE telegram_message_id IS NOT NULL DO NOTHING
        """
    return """
        INSERT OR IGNORE INTO messages (
          conversation_id, telegram_user_id, telegram_message_id, source, direction, sender_type,
          message_type, text, payload_json, sent_at
        )
        VALUES (?, ?, ?, 'business_account', ?, ?, ?, ?, ?, ?)
        """


def payment_event_upsert_sql() -> str:
    if database_url():
        return """
        INSERT INTO payment_events (
          telegram_message_id, telegram_group_id, telegram_group_title, sender_id, sender_name,
          sender_username, message_text, raw_payload_json, processing_status, is_edited,
          is_deleted, message_date, edited_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?)
        ON CONFLICT (telegram_group_id, telegram_message_id) DO UPDATE SET
          telegram_group_title = excluded.telegram_group_title,
          sender_id = excluded.sender_id,
          sender_name = excluded.sender_name,
          sender_username = excluded.sender_username,
          message_text = excluded.message_text,
          raw_payload_json = excluded.raw_payload_json,
          is_edited = CASE WHEN excluded.is_edited IS TRUE THEN TRUE ELSE payment_events.is_edited END,
          edited_at = COALESCE(excluded.edited_at, payment_events.edited_at),
          updated_at = excluded.updated_at
        """
    return """
        INSERT INTO payment_events (
          telegram_message_id, telegram_group_id, telegram_group_title, sender_id, sender_name,
          sender_username, message_text, raw_payload_json, processing_status, is_edited,
          is_deleted, message_date, edited_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, 0, ?, ?, ?)
        ON CONFLICT(telegram_group_id, telegram_message_id) DO UPDATE SET
          telegram_group_title = excluded.telegram_group_title,
          sender_id = excluded.sender_id,
          sender_name = excluded.sender_name,
          sender_username = excluded.sender_username,
          message_text = excluded.message_text,
          raw_payload_json = excluded.raw_payload_json,
          is_edited = CASE WHEN excluded.is_edited = 1 THEN 1 ELSE payment_events.is_edited END,
          edited_at = COALESCE(excluded.edited_at, payment_events.edited_at),
          updated_at = excluded.updated_at
        """


def _convert_sql_params(sql: str, params: Any) -> tuple[str, Any]:
    if database_url():
        if isinstance(params, dict):
            converted = _NAMED_PARAM_RE.sub(r"%(\1)s", sql)
            return converted, params
        converted = sql.replace("?", "%s")
        return converted, params or ()
    return sql, params or ()


class _CursorResult:
    def __init__(self, cursor):
        self._cursor = cursor
        self.rowcount = cursor.rowcount

    def fetchone(self):
        row = self._cursor.fetchone()
        if row is None:
            return None
        if isinstance(row, dict):
            return row
        return dict(row)

    def fetchall(self):
        rows = self._cursor.fetchall()
        return [row if isinstance(row, dict) else dict(row) for row in rows]


class PostgresConnection:
    def __init__(self, connection):
        self._connection = connection
        self.row_factory = None

    def execute(self, sql: str, params: Any = None):
        import psycopg2.extras

        converted, bound = _convert_sql_params(sql, params)
        cursor = self._connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(converted, bound)
        return _CursorResult(cursor)

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        self._connection.close()


def connect_db():
    url = database_url()
    if url:
        import psycopg2

        connection = psycopg2.connect(url)
        connection.autocommit = False
        return PostgresConnection(connection)

    path = sqlite_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


@contextmanager
def db_session() -> Iterator[Any]:
    db = connect_db()
    try:
        yield db
        db.commit()
    except Exception:
        if hasattr(db, "rollback"):
            db.rollback()
        raise
    finally:
        db.close()


def rollback_if_needed(db: Any) -> None:
    if hasattr(db, "rollback"):
        db.rollback()


def commit_if_needed(db: Any) -> None:
    if hasattr(db, "commit"):
        db.commit()


def cursor_value(row, key, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    return row[key] if key in row.keys() else default
