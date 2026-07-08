import { createDataStore } from '../src/db/index.js';
import {
  processPaymentWindowExpiryTick,
  REGISTRATION_PAYMENT_EXPIRY_MESSAGE
} from '../src/telegram/paymentWindowExpiryWorker.js';

async function run() {
  const store = await createDataStore();
  const telegramId = Date.now();
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();

  const insert = await store.db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, last_name, display_name, registration_status,
      is_bot, first_seen, last_seen, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Collecting Info', 0, ?, ?, ?)
  `).run(telegramId, 'expiry_user', 'Expiry', 'Tester', 'Expiry Tester', now, now, now);
  const contactId = insert.lastInsertRowid;
  const contact = await store.getUserProfile(contactId);
  if (!contact) throw new Error('failed to create test contact');

  await store.db.prepare(`
    INSERT INTO contact_automation_state (
      telegram_user_id, current_flow, current_step, registration_info_json, updated_at
    ) VALUES (?, 'bot_registration', 'await_payment_done', ?, ?)
  `).run(
    contactId,
    JSON.stringify({
      payment_method_name: 'Chime',
      payment_display_name: 'John Smith',
      first_deposit_amount: 25.5
    }),
    now
  );

  const windowInsert = await store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?, 'active', ?, ?, ?)
  `).run(contactId, String(telegramId), 'John Smith', 25.5, past, now, now);
  const windowId = windowInsert.lastInsertRowid;

  const queuedMessages = [];
  const result = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async ({ user, text }) => {
      queuedMessages.push({ userId: user.id, text });
      await store.queueTelegramOutboundMessage({
        contactId: user.id,
        telegramUserId: user.telegram_id,
        body: text
      });
      return { queued: true };
    }
  });

  assertEqual(result.expired, 1, 'one window expired');

  const window = await store.db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  assertEqual(window.status, 'expired', 'window status is expired');

  const automationState = await store.getAutomationState(contactId);
  assertEqual(automationState.current_flow, null, 'flow cleared');
  assertEqual(automationState.current_step, null, 'step cleared');
  assertEqual(automationState.registration_info.payment_display_name, undefined, 'payment display name cleared');
  assertEqual(automationState.registration_info.telegram_display_name, contact.display_name, 'identity kept');

  const updatedContact = await store.getUserProfile(contactId);
  assertEqual(updatedContact.registration_status, 'New', 'status reset to New');

  assertEqual(queuedMessages.length, 1, 'one expiry message queued');
  assertEqual(queuedMessages[0].text, REGISTRATION_PAYMENT_EXPIRY_MESSAGE);

  const outbound = await store.db.prepare(`
    SELECT body
    FROM telegram_outbound_messages
    WHERE contact_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(contactId);
  assertIncludes(outbound.body, '5-minute payment window has expired');

  const secondPass = await processPaymentWindowExpiryTick({ store, sendExpiryMessage: async () => {
    throw new Error('should not queue twice');
  } });
  assertEqual(secondPass.expired, 0, 'already-expired window is not processed again');

  console.log('ALL PAYMENT WINDOW EXPIRY WORKER CHECKS PASSED');
}

function assertEqual(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label ? `${label}: ` : ''}expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`Expected text to include ${JSON.stringify(needle)}\nGot:\n${haystack}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
