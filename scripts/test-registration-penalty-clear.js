import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { requireAdmin } from '../src/middleware/auth.js';
import { PAYMENT_WINDOW_FLOW, UNMATCHED_REASON } from '../src/payments/constants.js';
import { REGISTRATION_PAYMENT_COOLDOWN_MESSAGE } from '../src/telegram/registrationQrSend.js';

async function createStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-reg-penalty-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(tmpDir, 'test.sqlite') });
  return { store, tmpDir };
}

async function createUser(store, telegramId) {
  return await store.upsertTelegramUser({
    id: telegramId,
    first_name: 'Penalty',
    last_name: String(telegramId),
    username: `penalty_${telegramId}`,
    is_bot: false
  });
}

async function createExpiredRegistrationWindow(store, user, { minutesAgo = 10 } = {}) {
  const window = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: null,
    paymentQrCodeId: null,
    paymentDisplayName: 'Penalty User',
    firstDepositAmount: 10.01,
    creditedDepositAmount: 11,
    flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
    windowMinutes: 7
  });
  const expiredAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET expires_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(expiredAt, expiredAt, window.id);
  await store.expireRegistrationPaymentWindowIfDue(window.id);
  return await store.getRegistrationPaymentWindow(window.id);
}

async function createCompletedRegistrationWindow(store, user) {
  const window = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: null,
    paymentQrCodeId: null,
    paymentDisplayName: 'Completed User',
    firstDepositAmount: 20.01,
    creditedDepositAmount: 21,
    flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
    windowMinutes: 7
  });
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET status = 'completed',
        matched_payment_event_id = 7001,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), new Date().toISOString(), window.id);
  return await store.getRegistrationPaymentWindow(window.id);
}

async function insertUnrelatedRecords(store, user) {
  await store.storeOutgoingMessage({
    telegramUserId: user.id,
    telegramMessageId: 81001,
    text: 'Saved chat message',
    payload: {},
    senderType: 'staff',
    staffName: 'Admin'
  });
  const deposit = await store.createDepositEvent({
    contactId: user.id,
    paymentTag: '$PenaltyTag',
    paymentTagNormalized: '$penaltytag',
    startedBy: 'Test'
  });
  const completed = await createCompletedRegistrationWindow(store, user);
  const now = new Date().toISOString();
  const paymentResult = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      unmatched_reason, contact_id, message_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, '{}', 'Failed', 'ignored', ?, ?, ?, ?, ?)
  `).run(
    91001,
    -91001,
    'Payments',
    '/OUT 40',
    UNMATCHED_REASON.CASHOUT_MESSAGE,
    user.id,
    now,
    now,
    now
  );
  return {
    messageCount: (await store.listMessagesForUser(user.id)).length,
    depositId: deposit.id,
    completedWindowId: completed.id,
    cashoutPaymentId: paymentResult.lastInsertRowid
  };
}

async function assertUnrelatedPreserved(store, user, before) {
  assert.equal((await store.listMessagesForUser(user.id)).length, before.messageCount);
  assert.ok(await store.getDepositEvent(before.depositId));
  const completedWindow = await store.getRegistrationPaymentWindow(before.completedWindowId);
  assert.equal(completedWindow.status_raw, 'completed');
  assert.equal(Number(completedWindow.matched_payment_event_id), 7001);
  const cashoutPayment = await store.getPaymentEvent(before.cashoutPaymentId);
  assert.equal(cashoutPayment.routing_status, 'ignored');
  assert.equal(cashoutPayment.unmatched_reason, UNMATCHED_REASON.CASHOUT_MESSAGE);
}

function createTestApp(store, ledgerUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ledgerUser = ledgerUser;
    next();
  });
  app.post('/api/contacts/:id/registration/penalty/clear', requireAdmin, async (req, res) => {
    const result = await store.clearRegistrationPaymentPenalty(Number(req.params.id), {
      actorId: req.ledgerUser?.id || null,
      actorName: req.ledgerUser?.username || 'Admin'
    });
    if (!result) return res.status(404).json({ error: 'Contact not found.' });
    return res.json({ ok: true, ...result });
  });
  return app;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  const { store, tmpDir } = await createStore();
  try {
    for (const count of [1, 2]) {
      const user = await createUser(store, 720000 + count);
      for (let index = 0; index < count; index += 1) {
        await createExpiredRegistrationWindow(store, user, { minutesAgo: 10 + index });
      }
      assert.equal((await store.getRegistrationPaymentPenaltyStatus(user.id)).expired_strike_count, count);
      const result = await store.clearRegistrationPaymentPenalty(user.id, { actorId: 1, actorName: 'Admin' });
      assert.equal(result.status.expired_strike_count, 0);
      assert.equal(result.status.cooldown_active, false);
      assert.equal(result.status.registration_allowed, true);
    }

    const cooldownUser = await createUser(store, 720003);
    const before = await insertUnrelatedRecords(store, cooldownUser);
    for (let index = 0; index < 3; index += 1) {
      await createExpiredRegistrationWindow(store, cooldownUser, { minutesAgo: 10 + index });
    }

    // Paused player is blocked before revocation
    const blocked = await store.getRegistrationPaymentPenaltyStatus(cooldownUser.id);
    assert.equal(blocked.expired_strike_count, 3);
    assert.equal(blocked.cooldown_active, true);
    assert.equal(blocked.pause_active, true);
    assert.equal(blocked.pause_reason, 'repeated_missed_payment_windows');
    assert.equal(blocked.pause_reason_label, 'Multiple missed payment windows');
    assert.ok(blocked.paused_until);
    assert.equal(blocked.registration_allowed, false);
    await assert.rejects(
      () => store.createRegistrationPaymentWindow({
        contactId: cooldownUser.id,
        telegramUserId: cooldownUser.telegram_id,
        paymentMethodId: null,
        paymentQrCodeId: null,
        paymentDisplayName: 'Penalty User',
        firstDepositAmount: 12.01,
        creditedDepositAmount: 13,
        flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
        windowMinutes: 7
      }),
      (error) => error.code === 'REGISTRATION_PAYMENT_COOLDOWN'
    );
    assert.match(REGISTRATION_PAYMENT_COOLDOWN_MESSAGE, /temporarily paused for 12 hours/i);

    // Preserve expired-window history before revoke
    const expiredBefore = await store.db.prepare(`
      SELECT id, status, registration_penalty_cleared_at, expires_at
      FROM registration_payment_windows
      WHERE contact_id = ? AND status = 'expired'
      ORDER BY id ASC
    `).all(cooldownUser.id);
    assert.equal(expiredBefore.length, 3);
    assert.ok(expiredBefore.every((row) => row.registration_penalty_cleared_at == null));

    // Authorized admin can revoke pause
    const firstClear = await store.clearRegistrationPaymentPenalty(cooldownUser.id, {
      actorId: 99,
      actorName: 'AdminAlice'
    });
    assert.equal(firstClear.previous.expired_strike_count, 3);
    assert.equal(firstClear.previous.pause_active, true);
    assert.equal(firstClear.status.expired_strike_count, 0);
    assert.equal(firstClear.status.cooldown_active, false);
    assert.equal(firstClear.status.pause_active, false);
    assert.equal(firstClear.status.paused_until, null);
    assert.equal(firstClear.status.registration_allowed, true);
    await assertUnrelatedPreserved(store, cooldownUser, before);

    // History preserved: windows remain, only strike-clear stamp added
    const expiredAfter = await store.db.prepare(`
      SELECT id, status, registration_penalty_cleared_at, expires_at
      FROM registration_payment_windows
      WHERE contact_id = ? AND status = 'expired'
      ORDER BY id ASC
    `).all(cooldownUser.id);
    assert.equal(expiredAfter.length, 3);
    assert.deepEqual(expiredAfter.map((row) => row.id), expiredBefore.map((row) => row.id));
    assert.ok(expiredAfter.every((row) => row.registration_penalty_cleared_at != null));
    assert.deepEqual(
      expiredAfter.map((row) => row.expires_at),
      expiredBefore.map((row) => row.expires_at)
    );

    // Player can proceed immediately after revocation
    const allowedWindow = await store.createRegistrationPaymentWindow({
      contactId: cooldownUser.id,
      telegramUserId: cooldownUser.telegram_id,
      paymentMethodId: null,
      paymentQrCodeId: null,
      paymentDisplayName: 'Penalty User',
      firstDepositAmount: 30.01,
      creditedDepositAmount: 31,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
      windowMinutes: 7
    });
    assert.equal(allowedWindow.flow_type, PAYMENT_WINDOW_FLOW.REGISTRATION);
    assert.ok(allowedWindow.id);

    // Revocation is audited
    const timeline = await store.listTimelineForUser(cooldownUser.id);
    const revokeEvents = timeline.filter((event) => event.event_type === 'registration_pause_revoked');
    assert.ok(revokeEvents.length >= 1);
    const metadata = revokeEvents
      .map((event) => JSON.parse(event.metadata_json))
      .find((item) => item.previousExpiredWindowCount === 3);
    assert.ok(metadata);
    assert.equal(metadata.action, 'registration_pause_revoked');
    assert.equal(metadata.originalReason, 'repeated_missed_payment_windows');
    assert.equal(metadata.revokedBy, 'AdminAlice');
    assert.equal(metadata.actorId, 99);
    assert.equal(metadata.contactId, cooldownUser.id);
    assert.ok(metadata.originalPausedUntil);
    assert.ok(metadata.revokedAt);
    assert.equal(metadata.wasPaused, true);

    // Already-unpaused player is handled safely/idempotently
    const secondClear = await store.clearRegistrationPaymentPenalty(cooldownUser.id, {
      actorId: 99,
      actorName: 'AdminAlice'
    });
    assert.equal(secondClear.status.expired_strike_count, 0);
    assert.equal(secondClear.status.pause_active, false);
    assert.equal(secondClear.status.registration_allowed, true);
    await assertUnrelatedPreserved(store, cooldownUser, before);
    const idempotentEvents = (await store.listTimelineForUser(cooldownUser.id))
      .filter((event) => event.event_type === 'registration_pause_revoked');
    assert.ok(idempotentEvents.length >= 2);

    // Unauthorized users cannot revoke it
    await withServer(createTestApp(store, { id: 2, username: 'staff', role: 'staff' }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/contacts/${cooldownUser.id}/registration/penalty/clear`, { method: 'POST' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'Admin access required.');
    });

    // Authorized admin endpoint succeeds
    await withServer(createTestApp(store, { id: 1, username: 'admin', role: 'admin' }), async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/contacts/999999/registration/penalty/clear`, { method: 'POST' });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error, 'Contact not found.');

      const ok = await fetch(`${baseUrl}/api/contacts/${cooldownUser.id}/registration/penalty/clear`, { method: 'POST' });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.ok, true);
      assert.equal(body.status.pause_active, false);
      assert.equal(body.status.registration_allowed, true);
    });

    console.log('ALL REGISTRATION PENALTY CLEAR CHECKS PASSED');
  } finally {
    await store.db?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
