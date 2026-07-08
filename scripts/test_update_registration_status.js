import { createDataStore, REGISTRATION_STATUSES } from '../src/db/index.js';

const REQUIRED_STATUSES = [
  'New',
  'Collecting Info',
  'Pending Verification',
  'Registered',
  'Suspended',
  'Archived'
];

async function run() {
  for (const status of REQUIRED_STATUSES) {
    if (!REGISTRATION_STATUSES.includes(status)) {
      throw new Error(`REGISTRATION_STATUSES missing required value: ${status}`);
    }
  }
  console.log('ok REGISTRATION_STATUSES includes required values');

  const store = await createDataStore();
  const telegramId = Date.now();
  const now = new Date().toISOString();
  const insert = await store.db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, last_name, display_name, is_bot, first_seen, last_seen, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(telegramId, 'status_tester', 'Status', 'Tester', 'Status Tester', now, now, now);
  const user = await store.getUserProfile(insert.lastInsertRowid);
  if (!user) throw new Error('failed to create test user');

  assertEqual(user.registration_status, 'New', 'new user starts as New');

  const updated = await store.updateRegistrationStatus(user.id, 'Collecting Info', 'Test');
  assertEqual(updated.registration_status, 'Collecting Info', 'status updates to Collecting Info');

  const pending = await store.updateRegistrationStatus(user.id, 'Pending Verification', 'Test');
  assertEqual(pending.registration_status, 'Pending Verification', 'status updates to Pending Verification');

  let rejected = false;
  try {
    await store.updateRegistrationStatus(user.id, 'Not A Real Status', 'Test');
  } catch (error) {
    rejected = /Invalid registration status/i.test(String(error.message));
  }
  if (!rejected) {
    throw new Error('expected invalid registration status to throw');
  }
  console.log('ok invalid registration status is rejected');

  console.log('ALL UPDATE REGISTRATION STATUS CHECKS PASSED');
}

function assertEqual(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label ? `${label}: ` : ''}expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
