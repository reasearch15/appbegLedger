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

## Business Telegram Account Sync

This uses Telethon and is separate from the Telegram Bot API listener.

1. Set `TELEGRAM_ACCOUNT_API_ID`, `TELEGRAM_ACCOUNT_API_HASH`, and `TELEGRAM_ACCOUNT_SESSION` in `.env`.
2. Run the interactive login once:

```bash
npm run telegram:login
```

3. Set `TELEGRAM_ACCOUNT_SYNC_ENABLED=true`.
4. Restart the app:

```bash
npm start
```

The sync reuses the saved session file, imports private dialogs incrementally, and then listens for live incoming/outgoing account messages.
