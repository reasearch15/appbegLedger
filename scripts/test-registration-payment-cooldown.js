import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

async function createExpiredWindow(store, user, {
  flowType = PAYMENT_WINDOW_FLOW.REGISTRATION,
  expiresAt = null,
  paymentEventId = null
} = {}) {
  const window = await store.createRegistrationPaymentWindow({
    contactId: user.id,
    telegramUserId: user.telegram_id,
    paymentMethodId: null,
    paymentQrCodeId: null,
    paymentDisplayName: 'Cooldown User',
    firstDepositAmount: flowType === PAYMENT_WINDOW_FLOW.REGISTRATION ? 10.01 : 10,
    creditedDepositAmount: flowType === PAYMENT_WINDOW_FLOW.REGISTRATION ? 11 : null,
    flowType,
    windowMinutes: 7
  });
  const expiredAt = expiresAt || new Date(Date.now() - 60 * 1000).toISOString();
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET expires_at = ?,
        matched_payment_event_id = ?,
        updated_at = ?
    WHERE id = ?
  `).run(expiredAt, paymentEventId, expiredAt, window.id);
  const expired = await store.expireRegistrationPaymentWindowIfDue(window.id);
  return expired || await store.getRegistrationPaymentWindow(window.id);
}

async function run() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-reg-cooldown-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dbDir, 'test.sqlite') });

  try {
    const user = await store.upsertTelegramUser({
      id: 700001,
      first_name: 'Cooldown',
      last_name: 'User',
      username: 'cooldown_user',
      is_bot: false
    });

    await createExpiredWindow(store, user);
    await createExpiredWindow(store, user);
    assert.equal(await store.countRecentExpiredRegistrationPaymentWindows(user.id), 2);
    assert.equal((await store.getActiveRegistrationPaymentCooldown(user.id)).active, false);

    await createExpiredWindow(store, user, { flowType: PAYMENT_WINDOW_FLOW.DEPOSIT });
    assert.equal(await store.countRecentExpiredRegistrationPaymentWindows(user.id), 2);
    assert.equal((await store.getActiveRegistrationPaymentCooldown(user.id)).active, false);

    const cancelledFutureWindow = await store.createRegistrationPaymentWindow({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      paymentMethodId: null,
      paymentQrCodeId: null,
      paymentDisplayName: 'Cooldown User',
      firstDepositAmount: 11.01,
      creditedDepositAmount: 12,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
      windowMinutes: 7
    });
    await store.expireRegistrationPaymentWindow(cancelledFutureWindow.id, { suppressNotification: true });
    assert.equal(await store.countRecentExpiredRegistrationPaymentWindows(user.id), 2);
    assert.equal((await store.getActiveRegistrationPaymentCooldown(user.id)).active, false);

    await createExpiredWindow(store, user);
    const cooldown = await store.getActiveRegistrationPaymentCooldown(user.id);
    assert.equal(cooldown.active, true);
    assert.ok(cooldown.cooldown_until);

    await assert.rejects(
      store.createRegistrationPaymentWindow({
        contactId: user.id,
        telegramUserId: user.telegram_id,
        paymentMethodId: null,
        paymentQrCodeId: null,
        paymentDisplayName: 'Cooldown User',
        firstDepositAmount: 12.01,
        creditedDepositAmount: 13,
        flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
        windowMinutes: 7
      }),
      (error) => error.code === 'REGISTRATION_PAYMENT_COOLDOWN'
    );

    const depositWindow = await store.createRegistrationPaymentWindow({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      paymentMethodId: null,
      paymentQrCodeId: null,
      paymentDisplayName: 'Cooldown User',
      firstDepositAmount: 12,
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
      windowMinutes: 7
    });
    assert.equal(depositWindow.flow_type, PAYMENT_WINDOW_FLOW.DEPOSIT);

    await store.db.prepare(`
      UPDATE telegram_users
      SET registration_payment_cooldown_until = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 60 * 1000).toISOString(), user.id);
    const allowedWindow = await store.createRegistrationPaymentWindow({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      paymentMethodId: null,
      paymentQrCodeId: null,
      paymentDisplayName: 'Cooldown User',
      firstDepositAmount: 13.01,
      creditedDepositAmount: 14,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
      windowMinutes: 7
    });
    assert.equal(allowedWindow.flow_type, PAYMENT_WINDOW_FLOW.REGISTRATION);

    const oldUser = await store.upsertTelegramUser({
      id: 700002,
      first_name: 'Old',
      last_name: 'Misses',
      username: 'old_misses',
      is_bot: false
    });
    const oldExpiresAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (let index = 0; index < 3; index += 1) {
      await createExpiredWindow(store, oldUser, { expiresAt: oldExpiresAt });
    }
    const refreshed = await store.refreshRegistrationPaymentCooldown(oldUser.id);
    assert.equal(refreshed.active, false);
    assert.equal(await store.countRecentExpiredRegistrationPaymentWindows(oldUser.id), 0);

    console.log('ALL REGISTRATION PAYMENT COOLDOWN CHECKS PASSED');
  } finally {
    await store.db?.close?.();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
