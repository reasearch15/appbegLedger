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

Personal Telegram private-chat sync is disabled at startup and in `scripts/telegram_account_sync.py`. Do not enable `TELEGRAM_ACCOUNT_SYNC_ENABLED` for user support or registration.

Payment notifications remain separate. Configure the payment group listener with:

```env
PAYMENT_TELEGRAM_SYNC_ENABLED=true
PAYMENT_TELEGRAM_API_ID=...
PAYMENT_TELEGRAM_API_HASH=...
PAYMENT_TELEGRAM_SESSION=./data/appbeg-payment.session
PAYMENT_TELEGRAM_GROUP=...
```

Preview and run the one-time cleanup for old personal-account contacts with:

```bash
npm run cleanup:business-contacts:preview
npm run cleanup:business-contacts:execute
```
