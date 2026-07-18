import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStore } from '../src/db/index.js';
import { requireAdmin } from '../src/middleware/auth.js';
import { computeRegistrationProgress } from '../src/registration/playerModel.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';

function assertStaffCannotRevoke() {
  let statusCode = null;
  let payload = null;
  let nextCalled = false;
  requireAdmin(
    { ledgerUser: { role: 'staff' } },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        payload = body;
      }
    },
    () => {
      nextCalled = true;
    }
  );
  assert.equal(statusCode, 403);
  assert.equal(payload.error, 'Admin access required.');
  assert.equal(nextCalled, false);
}

async function insertPaymentEvent(store, { contactId, windowId }) {
  const now = new Date().toISOString();
  const result = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, parsed_amount,
      parsed_sender_name, routing_status, contact_id, registration_payment_window_id,
      message_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'Completed', 5, 'Amy', 'completed', ?, ?, ?, ?, ?)
  `).run(
    90001,
    -1001,
    'Payments',
    'Amy paid $5',
    '{}',
    contactId,
    windowId,
    now,
    now,
    now
  );
  return Number(result.lastInsertRowid);
}

async function run() {
  assertStaffCannotRevoke();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbeg-ledger-revoke-'));
  const databasePath = path.join(tmpDir, 'ledger.sqlite');
  const store = await createDataStore({ dialect: 'sqlite', databasePath });

  try {
    const { user } = await store.storeIncomingTelegramMessage({
      message: {
        message_id: 101,
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
        from: {
          id: 555001,
          username: 'amy',
          first_name: 'Amy',
          is_bot: false
        },
        chat: { id: 555001, type: 'private' }
      }
    });
    await store.storeOutgoingMessage({
      telegramUserId: user.id,
      telegramMessageId: 102,
      text: 'Welcome',
      payload: {},
      senderType: 'bot',
      staffName: 'Bot'
    });

    const matchedWindow = await store.createRegistrationPaymentWindow({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      paymentMethodId: null,
      paymentDisplayName: 'Amy',
      firstDepositAmount: 5
    });
    const paymentEventId = await insertPaymentEvent(store, {
      contactId: user.id,
      windowId: matchedWindow.id
    });
    const claim = await store.claimPaymentWindowMatch(matchedWindow.id, paymentEventId);
    assert.equal(claim.ok, true);

    const activeWindow = await store.createRegistrationPaymentWindow({
      contactId: user.id,
      telegramUserId: user.telegram_id,
      paymentMethodId: null,
      paymentDisplayName: 'Amy fresh',
      firstDepositAmount: 10
    });

    await store.updateRegistrationInfo(user.id, {
      payment_confirmed: true,
      registration_payment_window_id: matchedWindow.id,
      matched_payment_event_id: paymentEventId,
      registration_payment_event_id: paymentEventId,
      first_deposit_amount: 5,
      preferred_appbeg_username: 'Amyfied01',
      appbeg_password: 'secret',
      referral_choice: 'none',
      referral_code: null,
      appbeg_coadmin_uid: 'coadmin_1',
      create_account_in_progress: false,
      create_account_error: null,
      current_registration_phase: 'complete',
      appbeg_player_uid: 'player_1',
      appbeg_creation_complete: true
    }, 'Test');
    await store.markAppBegPlayerCreated({
      userId: user.id,
      playerUid: 'player_1',
      username: 'Amyfied01',
      registrationInfo: { initial_deposit_status: 'credited' },
      actorName: 'Test'
    });
    await store.setBotScreen(user.id, 'Registration', {
      actorName: 'Test',
      workflowKey: 'bot_registration',
      workflowStep: 'confirm',
      context: { registration: true }
    });
    await store.markAutoWelcomeSent(user.id);

    const beforeMessages = await store.listMessagesForUser(user.id);
    assert.equal(beforeMessages.length, 2);
    assert.equal((await store.getUserProfile(user.id)).registration_status, 'Registered');

    const result = await store.revokeRegistration(user.id, 'Admin');
    assert.equal(result.contact.registration_status, 'New');
    assert.equal(result.contact.appbeg_account_id, null);
    assert.equal(result.contact.registered_at, null);
    assert.deepEqual(result.automationState.registration_info, {});
    assert.equal(result.automationState.current_flow, null);
    assert.equal(result.automationState.current_step, null);
    assert.equal(result.automationState.last_auto_welcome_at, null);

    const session = await store.getBotSession(user.id);
    assert.equal(session.current_screen, 'Home');
    assert.equal(session.workflow_key, null);
    assert.equal(session.workflow_step, null);
    assert.equal(session.context_json, '{}');

    const afterMessages = await store.listMessagesForUser(user.id);
    assert.equal(afterMessages.length, beforeMessages.length);

    const consumedWindow = await store.getRegistrationPaymentWindow(matchedWindow.id);
    assert.equal(consumedWindow.status_raw, 'completed');
    assert.equal(Number(consumedWindow.matched_payment_event_id), paymentEventId);
    const consumedPayment = await store.getPaymentEvent(paymentEventId);
    assert.equal(Number(consumedPayment.registration_payment_window_id), matchedWindow.id);
    assert.equal(Number(consumedPayment.contact_id), user.id);

    const expiredWindow = await store.getRegistrationPaymentWindow(activeWindow.id);
    assert.equal(expiredWindow.status_raw, 'expired');
    assert.equal(expiredWindow.matched_payment_event_id, null);

    const timeline = await store.listTimelineForUser(user.id);
    assert.equal(timeline.some((event) => event.event_type === 'registration_revoked'), true);

    const freshContact = await store.getUserProfile(user.id);
    const freshState = await store.getAutomationState(user.id);
    assert.equal(computeRegistrationProgress(freshContact, freshState.registration_info, freshState).percent, 0);
    const decision = await decideBotReply({
      store,
      contact: freshContact,
      automationState: freshState,
      messageText: 'hello',
      forceEntryMenu: true
    });
    assert.equal(decision.kind, 'welcome');
    assert.match(decision.replies[0].text, /not registered/i);

    await assert.rejects(
      store.revokeRegistration(user.id, 'Admin'),
      /Only registered contacts can be revoked/
    );

    console.log('ok revoke registration resets local state safely');
  } finally {
    await store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
