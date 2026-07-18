import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { parsePaymentPageLimit } from '../src/payments/pagination.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-payment-pagination-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');

async function insertPayment(store, {
  id,
  messageDate,
  sender = 'Amy Fei',
  amount = 9,
  routingStatus = 'frozen',
  processingStatus = 'Parsed',
  unmatchedReason = 'no_active_window'
}) {
  const now = new Date().toISOString();
  await store.db.prepare(`
    INSERT INTO payment_events (
      id, telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      sender_name, parsed_sender_name, parsed_amount, parsed_payment_app,
      message_date, unmatched_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    1000 + id,
    -100,
    'Payments',
    `You received $${amount} from ${sender}`,
    processingStatus,
    routingStatus,
    sender,
    sender,
    amount,
    'chime',
    messageDate,
    unmatchedReason,
    now,
    now
  );
}

function ids(rows) {
  return rows.map((row) => Number(row.id));
}

async function run() {
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  const base = new Date('2026-07-18T12:00:00.000Z').getTime();

  for (let i = 1; i <= 35; i += 1) {
    await insertPayment(store, {
      id: i,
      messageDate: new Date(base - (35 - i) * 60_000).toISOString(),
      sender: i <= 20 ? 'Amy Fei' : 'Bob Ray'
    });
  }

  const first = await store.listPaymentEventsPage({ limit: 15, queue: 'payments' });
  assert.equal(first.items.length, 15, 'initial page returns 15 rows');
  assert.equal(first.hasMore, true, 'initial page has more rows');
  assert.ok(first.nextCursor, 'initial page returns cursor');

  const second = await store.listPaymentEventsPage({ limit: 15, cursor: first.nextCursor, queue: 'payments' });
  assert.equal(second.items.length, 15, 'second page returns next 15 rows');
  const seen = new Set([...ids(first.items), ...ids(second.items)]);
  assert.equal(seen.size, 30, 'first two pages have no duplicate IDs');

  const third = await store.listPaymentEventsPage({ limit: 15, cursor: second.nextCursor, queue: 'payments' });
  assert.equal(third.items.length, 5, 'final page returns remaining rows');
  assert.equal(third.hasMore, false, 'final page has no more rows');
  assert.equal(third.nextCursor, null, 'final page has no next cursor');

  const search = await store.listPaymentEventsPage({ limit: 15, queue: 'payments', query: 'bob' });
  assert.equal(search.items.length, 15, 'search returns first matching page only');
  assert.equal(search.hasMore, false, 'search reflects matching result count');
  assert.equal(search.items.every((payment) => /bob/i.test(payment.sender_name || '')), true);

  for (let i = 36; i <= 50; i += 1) {
    await insertPayment(store, {
      id: i,
      messageDate: new Date(base + i * 60_000).toISOString(),
      routingStatus: 'deposit_window_matched',
      processingStatus: 'Completed',
      unmatchedReason: null
    });
  }
  const completed = await store.listPaymentEventsPage({
    limit: 15,
    queue: 'payments',
    matchingStatus: 'completed'
  });
  assert.equal(completed.items.length, 15, 'status filter returns first 15 matching rows');
  assert.equal(completed.items.every((payment) => payment.matching_status === 'completed'), true);

  const capped = await store.listPaymentEventsPage({ limit: 1000, queue: 'payments' });
  assert.equal(capped.items.length, 15, 'store caps excessive page size to 15');
  assert.deepEqual(parsePaymentPageLimit('15'), { ok: true, limit: 15 });
  assert.equal(parsePaymentPageLimit('500').ok, false, 'API limit parser rejects excessive page sizes');
  assert.equal(parsePaymentPageLimit('0').ok, false, 'API limit parser rejects zero');

  console.log('ok payment pagination');
}

await run();
