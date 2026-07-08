"""
Standalone Telethon inline-button probe.

Bypasses AppBeg Ledger's outbound queue completely so we can isolate:

  A) Telethon user-session cannot render Button.inline  → no buttons here either
  B) Queue serialize/deserialize is broken               → buttons work here, not in queue

Usage:
  python scripts/test_welcome_buttons.py <telegram_user_id_or_@username>
  python scripts/test_welcome_buttons.py 123456789
  python scripts/test_welcome_buttons.py @someuser

Requires the same credentials/session as telegram_account_sync.py:
  TELEGRAM_ACCOUNT_API_ID / TELEGRAM_ACCOUNT_API_HASH
  TELEGRAM_ACCOUNT_SESSION (default ./data/telegram-business.session)
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv
from telethon import Button
from telethon.tl.types import User

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
load_dotenv(ROOT / ".env")

from telegram_account_sync import (  # noqa: E402
    build_client,
    log_buttons_just_before_send,
    reply_markup_summary,
)


MESSAGE = """👋 Hey! Welcome to Royal VIP.

It looks like you're not registered with us yet.

Choose an option below."""


def hardcoded_buttons():
    return [
        [Button.inline("📝 Register", b"register")],
        [Button.inline("💬 Talk to Staff", b"staff")],
    ]


async def main(target: str):
    client = build_client()
    await client.connect()
    if not await client.is_user_authorized():
        raise SystemExit("Session not authorized. Run: npm run telegram:login")

    me = await client.get_me()
    print(f"[test] connected as id={me.id} username=@{me.username or ''} bot={bool(getattr(me, 'bot', False))}")

    entity = await client.get_entity(target if not target.isdigit() else int(target))
    if not isinstance(entity, User):
        raise SystemExit(f"Target must be a private Telegram user, got {type(entity)!r}")

    buttons = hardcoded_buttons()
    print("[test] hardcoded buttons constructed outside the outbound queue")
    log_buttons_just_before_send(buttons, outbound_id="standalone-test", raw_buttons_json=None)

    print(
        f"[test] calling client.send_message(entity={entity.id}, message=..., buttons={buttons!r})",
        flush=True,
    )
    message = await client.send_message(entity, MESSAGE, buttons=buttons)
    markup = reply_markup_summary(message)
    print(f"[test] returned message_id={message.id}", flush=True)
    print(f"[test] reply_markup={markup!r}", flush=True)

    await client.disconnect()

    if not markup.get("present"):
        print(
            "\nRESULT: FAIL — Telethon accepted the send but returned NO reply_markup.\n"
            "This means the bug is Telethon usage / account type (user/business session),\n"
            "NOT AppBeg queue serialization.\n"
            "Fix: send inline button messages via TELEGRAM_BOT_TOKEN (Bot API).\n"
        )
        raise SystemExit(2)

    print(
        "\nRESULT: PASS — Telegram returned reply_markup for this send.\n"
        "If the product still shows plain text, the bug is in queue\n"
        "serialize/deserialize or a different send path.\n"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(
            "Usage: python scripts/test_welcome_buttons.py <telegram_user_id_or_@username>"
        )
    asyncio.run(main(sys.argv[1]))
