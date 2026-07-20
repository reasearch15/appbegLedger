import sqlite3

from payment_telegram_sync import resolve_checkpoint_for_group


def make_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute(
        """
        CREATE TABLE payment_sync_state (
          id INTEGER PRIMARY KEY,
          telegram_group_id INTEGER,
          telegram_group_title TEXT,
          last_synced_message_id INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    return db


def seed_state(db, group_id, checkpoint):
    db.execute(
        """
        INSERT INTO payment_sync_state (
          id, telegram_group_id, telegram_group_title, last_synced_message_id
        )
        VALUES (1, ?, 'LARRY CHIME', ?)
        """,
        (group_id, checkpoint),
    )


db = make_db()
seed_state(db, 5591388010, 9243)
checkpoint, previous, changed = resolve_checkpoint_for_group(db, 5591388010)
assert checkpoint == 9243
assert previous["telegram_group_id"] == 5591388010
assert changed is False
print("ok same payment peer keeps checkpoint")

db = make_db()
seed_state(db, 5591388010, 9243)
checkpoint, previous, changed = resolve_checkpoint_for_group(db, 4272772672)
assert checkpoint == 0
assert previous["telegram_group_id"] == 5591388010
assert changed is True
print("ok changed payment peer resets checkpoint")

db = make_db()
checkpoint, previous, changed = resolve_checkpoint_for_group(db, 4272772672)
assert checkpoint == 0
assert previous is None
assert changed is False
print("ok missing sync state starts at zero")
