# AppBeg Ledger database setup

AppBeg Ledger supports **PostgreSQL** (central VPS storage) and **SQLite** (local fallback).

- If `DATABASE_URL` is set, the app and Python sync workers use PostgreSQL.
- If `DATABASE_URL` is unset, the app uses `DATABASE_PATH` (default `./data/royal-vip-coadmin.sqlite`).

TeleLedger is **not** affected by this database.

## Troubleshooting Telethon session locks

Telethon stores its **session** in a local SQLite file (e.g. `telegram-business.session`). Only one sync/login process may use that session at a time.

AppBeg Ledger enforces this in two places:

1. **Node supervisor** — only one `telegram_account_sync.py sync` child per server process; restarts stop the old worker first.
2. **Python file lock** — `scripts/process_lock.py` prevents a second sync worker from starting while one is already running.

If you see `sqlite3.OperationalError: database is locked` from Telethon, a stale Python or Node process is still holding the session. On Windows:

```bat
taskkill /F /IM python.exe
taskkill /F /IM node.exe
```

Then start the app again with `npm start`.

## 1. Create the VPS database and user

On your VPS, as a PostgreSQL superuser:

```bash
export APPBEG_DB_PASSWORD='choose-a-strong-password'
sudo -u postgres bash /path/to/AppbegLedger/scripts/vps/create_postgres_db.sh
```

This creates:

| Item | Value |
|------|-------|
| Database | `appbeg_ledger_db` |
| User | `appbeg_ledger_user` |

### Network access

Allow your development machine to reach PostgreSQL:

1. Edit `postgresql.conf` — set `listen_addresses` to include the VPS interface (or `*` if appropriate).
2. Edit `pg_hba.conf` — add a host rule for your dev IP, for example:

```
host    appbeg_ledger_db    appbeg_ledger_user    YOUR_DEV_IP/32    scram-sha-256
```

3. Open port `5432` in the VPS firewall only for trusted IPs.
4. Reload PostgreSQL: `sudo systemctl reload postgresql`

## 2. Local `.env`

Copy `.env.example` to `.env` and set:

```env
DATABASE_URL=postgresql://appbeg_ledger_user:YOUR_PASSWORD@YOUR_VPS_HOST:5432/appbeg_ledger_db
DATABASE_SSL=true
```

Remove or comment out `DATABASE_URL` to fall back to SQLite.

`DATABASE_PATH` is ignored when `DATABASE_URL` is set.

## 3. Python dependencies

Telegram sync scripts need PostgreSQL support when using `DATABASE_URL`:

```bash
pip install -r requirements.txt
```

## 4. Initialize schema (PostgreSQL only)

From the AppBeg Ledger project root:

```bash
npm run db:init
```

This applies `src/db/schema.postgres.sql` and seeds default tags, quick replies, automation rules, and coadmin settings.

SQLite schema is created automatically on first app start when `DATABASE_URL` is not set.

## 5. Start the app locally

```bash
npm start
```

The Node server and Python Telethon workers read `DATABASE_URL` from `.env`.

## 6. Verify persistence

Run the verification script before and after a restart — counts and checkpoints should match:

```bash
npm run db:verify
```

Or use the health endpoint while the app is running:

```bash
curl http://localhost:4300/api/health
```

### Contacts and messages

1. Start the app with `DATABASE_URL` pointing at the VPS.
2. Enable business account sync (`TELEGRAM_ACCOUNT_SYNC_ENABLED=true`) or receive bot messages.
3. Confirm contacts/messages appear in the dashboard.
4. Stop the app (`Ctrl+C`) and start it again.
5. Contacts and messages should still be present — no full re-import from scratch.

### Sync checkpoints (no duplicate Telegram messages)

Checkpoints are stored in PostgreSQL:

| Table | Purpose |
|-------|---------|
| `sync_state` | Per-dialog business account checkpoints (`business_account:checkpoint:{telegram_id}`) |
| `payment_sync_state.last_synced_message_id` | Payment group import cursor |
| `telegram_account_sync_state` | Account sync worker status |

After a restart, sync should resume from the last checkpoint. Duplicate messages are prevented by:

- `UNIQUE (source, conversation_id, telegram_message_id, direction)` on `messages`
- `UNIQUE (telegram_group_id, telegram_message_id)` on `payment_events`
- `PRIMARY KEY (client_request_id, telegram_user_id)` on `outgoing_message_requests`

### Quick SQL checks (on VPS)

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM telegram_users;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM messages;"
psql "$DATABASE_URL" -c "SELECT key, updated_at FROM sync_state ORDER BY updated_at DESC LIMIT 5;"
psql "$DATABASE_URL" -c "SELECT last_synced_message_id FROM payment_sync_state WHERE id = 1;"
```

## Tables included in PostgreSQL schema

- `telegram_users` (contacts)
- `conversations`, `messages`
- `players` / registration (`registration_info`, `registration_info_history`)
- `automation_rules`, `contact_automation_state`, `automation_logs`
- `coadmin_settings`, `settings_audit_log`
- `deposit_events`, `payment_events`, `payment_routing_logs`
- `sync_state`, `telegram_account_sync_state`, `payment_sync_state`
- `outgoing_message_requests` (send idempotency)

## What is not deployed yet

This setup only creates the **database** on the VPS. The AppBeg Ledger Node app itself still runs locally for development.
