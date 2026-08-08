# Royal VIP Coadmin Agent Foundation

Standalone Phase 1 application for storing Telegram bot users, conversations, and messages in a CRM-style dashboard.

## Quick Start

1. Copy `.env.example` to `.env`.
2. Set `TELEGRAM_BOT_TOKEN` to your bot token from BotFather.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm start
```

5. Open `http://localhost:4300`.

If `TELEGRAM_BOT_TOKEN` is missing, the dashboard and API still run, but the Telegram listener is disabled.

## Telegram Architecture

User contacts are created only when a person interacts with the official BotFather bot configured by `TELEGRAM_BOT_TOKEN`.

Owner/admin notifications from Contact Support, custom inquiries, and FreePlay are sent by a separate bot configured with:

```env
SUPPORT_NOTIFICATION_BOT_TOKEN=
```

Staff enroll with a Coadmin **Staff Telegram Integration Code** (`STG-…`) after `/start`. Linked staff can `/stop` to disable notifications and `/start` again to reactivate without re-entering the code. Unlinked or legacy unscoped subscribers are not notified. There is no hardcoded owner chat ID.

Personal Telegram private-chat sync is disabled at startup and in `scripts/telegram_account_sync.py`. Do not enable `TELEGRAM_ACCOUNT_SYNC_ENABLED` for user support or registration.

Payment notifications remain separate. Configure the payment group listener with:

```env
PAYMENT_TELEGRAM_SYNC_ENABLED=true
PAYMENT_TELEGRAM_API_ID=...
PAYMENT_TELEGRAM_API_HASH=...
PAYMENT_TELEGRAM_SESSION=./data/appbeg-payment.session
PAYMENT_TELEGRAM_GROUP=-5413513424
```

`PAYMENT_TELEGRAM_GROUP` (or fallback `PAYMENT_GROUP_CHAT_ID`) is the **source** payment confirmation group the Telethon listener watches. It is not the outbound Telegram notification destination.

Preview and run the one-time cleanup for old personal-account contacts with:

```bash
npm run cleanup:business-contacts:preview
npm run cleanup:business-contacts:execute
```
