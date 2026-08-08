# Cash-out ↔ Royal Support Notification — Deployment & Hardening (Phase 7)

Phases 1–6 implement STG enrollment, subscriber management, notifications, state sync, CLAIM, and DONE.
Phase 7 adds Coadmin/Staff attribution UI and production hardening. **Do not enable mutation flags until prior stages are verified.**

## Feature flags

| Flag | Default | Meaning |
|------|---------|---------|
| `CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED` | false | Outbox worker send/edit cards |
| `CASHOUT_TELEGRAM_CLAIM_ENABLED` | false | CLAIM button + callback |
| `CASHOUT_TELEGRAM_DONE_ENABLED` | false | DONE button + callback |

**Dependency / fail-safe matrix**

- `NOTIFICATIONS=false` → no cards; CLAIM/DONE effective off
- `NOTIFICATIONS=true`, `CLAIM=false` → read-only sync
- `CLAIM=true`, `DONE=false` → claim only
- `DONE=true` with `CLAIM=false` → **DONE forced off** (logged as `DONE_WITHOUT_CLAIM`)
- Missing `APPBEG_API_URL` / `APPBEG_LEDGER_INTERNAL_TOKEN` / `SUPPORT_NOTIFICATION_BOT_TOKEN` → mutation gates stay off

## M2M auth map (do not casually migrate)

| Surface | Credential | Header |
|---------|------------|--------|
| STG validate-code | `APPBEG_LEDGER_INTERNAL_TOKEN` | `x-appbeg-ledger-token` |
| Outbox poll + task read | same | same |
| Cash-out CLAIM | same | same |
| Cash-out COMPLETE | same | same |
| Subscriber list/enable/disable (AppBeg→Ledger) | `APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY` or `APPBEG_LEDGER_INTERNAL_API_KEY` | Bearer |

Scoped credentials for cash-out mutations are a **future hardening** item; leave shared ledger token unchanged to avoid breaking vendor/internal routes.

## Deploy order

### AppBeg first

1. Backup per normal procedure  
2. Migrations `070` (STG), `071` (ops claim), `072` (ops completion)  
3. Deploy AppBeg APIs/services/UI (including attribution UI)  
4. Verify STG GET/POST, validate-code, task read, outbox, claim, complete routes  

### AppbegLedger second

5. Subscriber + delivery/checkpoint schema  
6. Deploy bot, worker, CLAIM/DONE callbacks, hardening  
7. Start with **all three flags false**

## Progressive enablement

1. **Enrollment** — STG `/start`, rotate, disable/enable  
2. **Notifications** — `NOTIFICATIONS=true` only; observe one new cash-out  
3. **State sync** — legitimate lifecycle edits  
4. **CLAIM** — `CLAIM=true`, `DONE=false`  
5. **DONE** — one legitimate cash-out only; record balances before/after  

## Rollback (flags only)

- Notifications issue → `NOTIFICATIONS=false`  
- CLAIM issue → `CLAIM=false` (keep notifications if safe)  
- DONE issue → `DONE=false` (keep CLAIM if safe)  

Disabling flags does **not** undo committed AppBeg claims/completions. Do not roll back legitimate financial rows because Telegram UI failed.

## Outbox retention risk

No automated prune/TTL was added in Phase 7. Soft-delete exists on AppBeg outbox. If rows needed after the Ledger checkpoint are deleted before processing, events may be missed. Mitigation: delivery retry/reconcile always **re-fetches AppBeg task truth**; missed create events may still leave gaps for never-sent cards. Prefer retaining outbox until consumers are healthy.

## Safe verification queries (read-only)

AppBeg (examples — adjust schema names as deployed):

```sql
-- STG / ops tables exist
SELECT to_regclass('public.coadmin_staff_telegram_integration_codes');
SELECT to_regclass('public.cashout_operational_events');

-- Operational events (no payment secrets)
SELECT event_type, action_source, telegram_display_name, occurred_at
FROM public.cashout_operational_events
WHERE cashout_task_id = $1
ORDER BY occurred_at;

-- First DONE check (no cash tags / QR)
SELECT status, assigned_handler_uid, reward_npr_applied, reward_blocked_applied,
       operational_completion_source, operational_completion_telegram_display_name
FROM public.player_cashout_tasks_cache
WHERE firebase_id = $1;
```

Ledger:

```sql
SELECT COUNT(*) FROM support_notification_subscribers WHERE coadmin_uid IS NULL;
SELECT last_processed_outbox_id FROM cashout_outbox_consumer_state
  WHERE consumer_name = 'cashout_telegram_notifications';
SELECT delivery_status, COUNT(*) FROM cashout_notification_deliveries GROUP BY 1;
```

## Health

`GET /api/health` includes `cashoutTelegram` flags, effective gates, consumer checkpoint, and delivery failure counts (no secrets).
