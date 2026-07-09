import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
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
      payment_method_id: 1,
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
    ) VALUES (?, ?, 1, 10, ?, ?, 'active', ?, ?, ?)
  `).run(contactId, String(telegramId), 'John Smith', 25.5, past, now, now);
  const windowId = windowInsert.lastInsertRowid;

  const queuedMessages = [];
  const result = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async ({ user, text }) => {
      if (user.id !== contactId) return { queued: true };
      queuedMessages.push({ userId: user.id, text });
      await store.queueTelegramOutboundMessage({
        contactId: user.id,
        telegramUserId: user.telegram_id,
        body: text
      });
      return { queued: true };
    }
  });

  assertEqual(result.expired >= 1, true, 'at least one window expired');

  const window = await store.db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  assertEqual(window.status, 'expired', 'window status is expired');
  assertEqual(Boolean(window.expiry_notified_at), true, 'expiry notification marked');

  const automationState = await store.getAutomationState(contactId);
  assertEqual(automationState.current_flow, null, 'flow cleared');
  assertEqual(automationState.current_step, null, 'step cleared');
  assertEqual(automationState.registration_info.payment_display_name, undefined, 'payment display name cleared');
  assertEqual(automationState.registration_info.payment_method_name, undefined, 'payment method cleared');
  assertEqual(automationState.registration_info.telegram_display_name, contact.display_name, 'identity kept');

  const updatedContact = await store.getUserProfile(contactId);
  assertEqual(updatedContact.registration_status, 'New', 'status reset to New');

  assertEqual(queuedMessages.length, 1, 'one expiry message queued');
  assertEqual(queuedMessages[0].text, REGISTRATION_PAYMENT_EXPIRY_MESSAGE);
  assertIncludes(queuedMessages[0].text, 'payment confirmation window has expired');
  assertIncludes(queuedMessages[0].text, 'cancelled for your security');

  const outbound = await store.db.prepare(`
    SELECT body
    FROM telegram_outbound_messages
    WHERE contact_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(contactId);
  assertIncludes(outbound.body, '**Register**');

  const secondPass = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async ({ user }) => {
      if (user.id === contactId) {
        throw new Error('should not queue twice for same contact');
      }
      return { queued: true };
    }
  });
  assertEqual(secondPass.expired, 0, 'already-expired window is not expired again');

  const fakeStore = {
    state: {
      current_flow: null,
      current_step: null,
      registration_info: automationState.registration_info
    },
    async ensureAutomationState() {
      return {
        current_flow: fakeStore.state.current_flow,
        current_step: fakeStore.state.current_step,
        registration_info: { ...fakeStore.state.registration_info }
      };
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Chime', key: 'chime', display_order: 1 }];
    },
    async getActiveDefaultPaymentQr(methodId) {
      if (methodId === 1) {
        return { id: 10, file_path: 'data/media/payment-qr/test.png', payment_method_id: 1 };
      }
      return null;
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    }
  };

  const restarted = await decideBotReply({
    store: fakeStore,
    contact: updatedContact,
    messageText: 'Register'
  });
  assertEqual(restarted.kind, 'registration_ask_payment_app');
  assertEqual(restarted.statePatch.currentStep, 'payment_app');
  assertEqual(restarted.statePatch.registrationInfo?.payment_display_name, undefined);
  console.log('ok Register after expiry starts fresh payment method selection');

  const completedTelegramId = Date.now() + 1;
  const completedInsert = await store.db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, last_name, display_name, registration_status,
      is_bot, first_seen, last_seen, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Collecting Info', 0, ?, ?, ?)
  `).run(completedTelegramId, 'done_user', 'Done', 'User', 'Done User', now, now, now);
  const completedContactId = completedInsert.lastInsertRowid;

  await store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, status, expires_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, 1, 10, ?, ?, 'completed', ?, ?, ?, ?)
  `).run(completedContactId, String(completedTelegramId), 'Jane Doe', 10, past, now, now, now);

  const completedResult = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async () => {
      throw new Error('completed window should not notify');
    }
  });
  assertEqual(completedResult.notified, 0, 'completed window before expiry does nothing');
  console.log('ok completed payment window is ignored');

  const suppressedTelegramId = Date.now() + 2;
  const suppressedInsert = await store.db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, last_name, display_name, registration_status,
      is_bot, first_seen, last_seen, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Collecting Info', 0, ?, ?, ?)
  `).run(suppressedTelegramId, 'stop_user', 'Stop', 'User', 'Stop User', now, now, now);
  const suppressedContactId = suppressedInsert.lastInsertRowid;

  const suppressedWindowInsert = await store.db.prepare(`
    INSERT INTO registration_payment_windows (
      contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
      payment_display_name, first_deposit_amount, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, 1, 10, ?, ?, 'active', ?, ?, ?)
  `).run(suppressedContactId, String(suppressedTelegramId), 'Jane Doe', 10, past, now, now);

  await store.expireRegistrationPaymentWindow(suppressedWindowInsert.lastInsertRowid, { suppressNotification: true });
  const suppressedResult = await processPaymentWindowExpiryTick({
    store,
    sendExpiryMessage: async () => {
      throw new Error('manual stop should suppress expiry notification');
    }
  });
  assertEqual(suppressedResult.notified, 0, 'manually suppressed window does not notify');
  console.log('ok manual cancel suppresses expiry notification');

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
