import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { beginRegisteredDeposit, continueRegisteredDeposit } from '../src/telegram/registeredDepositFlow.js';
import { evaluatePaymentConfidence, CONFIDENCE, EVIDENCE } from '../src/payments/confidenceEngine.js';
import { PAYMENT_WINDOW_MINUTES, PAYMENT_WINDOW_FLOW, ROUTING_STATUS } from '../src/payments/constants.js';
import { startPaymentFreezeWorker } from '../src/payments/paymentFreezeWorker.js';
import { OPERATIONAL_ROLES } from '../src/telegram/operationalRoles.js';
import { FREEPLAY_UNREGISTERED_TEXT } from '../src/telegram/freePlayRequest.js';
import { staffFreezePayment, staffUnfreezePayment, resolveFreeplayGive, resolveFreeplayDecline, staffAssignAndCredit } from '../src/telegram/staffOperations.js';
import { FREEPLAY_ISSUANCE_BLOCKER } from '../src/appbeg/freeplayIssuanceClient.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-vip-telegram-first-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');

function contactShape(user) {
  return {
    ...user,
    telegram_sync_source: 'bot_api',
    active_messaging_source: 'bot_api'
  };
}

async function run() {
  assert.equal(PAYMENT_WINDOW_MINUTES, 15);
  delete process.env.PAYMENT_FREEZE_WORKER_ENABLED;
  const worker = startPaymentFreezeWorker({ store: {}, io: null });
  assert.equal(typeof worker.stop, 'function');
  await worker.stop();
  console.log('ok freeze worker disabled by default; window is 15 minutes');

  const off = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [{ contact_id: 1, evidence_kind: 'staff_confirmed' }],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }],
    confidenceModeOn: false
  });
  assert.equal(off.autoCreditEligible, false);
  assert.ok(off.reasons.includes(EVIDENCE.MODE_OFF));

  const unknown = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }],
    confidenceModeOn: true
  });
  assert.equal(unknown.classification, CONFIDENCE.UNKNOWN);
  assert.equal(unknown.autoCreditEligible, false);

  const legacy = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [{ contact_id: 1, evidence_kind: 'legacy_assumed_payer_eq_recipient' }],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }],
    confidenceModeOn: true
  });
  assert.notEqual(legacy.classification, CONFIDENCE.VERY_HIGH_CONFIDENCE);
  assert.equal(legacy.autoCreditEligible, false);

  const shared = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [
      { contact_id: 1, evidence_kind: 'staff_confirmed' },
      { contact_id: 2, evidence_kind: 'staff_confirmed' }
    ],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }, { id: 10, contact_id: 2 }],
    confidenceModeOn: true
  });
  assert.equal(shared.classification, CONFIDENCE.AMBIGUOUS);

  const rejected = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [
      { contact_id: 1, evidence_kind: 'staff_confirmed' },
      { contact_id: 1, evidence_kind: 'rejected' }
    ],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }],
    confidenceModeOn: true
  });
  assert.equal(rejected.autoCreditEligible, false);

  const noWindow = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [{ contact_id: 1, evidence_kind: 'staff_confirmed' }],
    activeWindowsForPayer: [],
    confidenceModeOn: true
  });
  assert.equal(noWindow.autoCreditEligible, false);
  assert.ok(noWindow.reasons.includes(EVIDENCE.NO_ACTIVE_WINDOW));

  const veryHigh = evaluatePaymentConfidence({
    displayName: 'Calvin M.',
    evidenceRows: [{ contact_id: 1, evidence_kind: 'staff_confirmed' }],
    activeWindowsForPayer: [{ id: 9, contact_id: 1 }],
    confidenceModeOn: true
  });
  assert.equal(veryHigh.classification, CONFIDENCE.VERY_HIGH_CONFIDENCE);
  assert.equal(veryHigh.autoCreditEligible, true);
  console.log('ok confidence engine rules');

  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = '9001';
  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  await store.updateCoadminSettings?.({
    coadmin_name: 'Test',
    coadmin_code: 'T1',
    appbeg_coadmin_uid: 'coadmin-1'
  }, 'Test').catch(() => null);

  const mode = await store.getConfidenceMode();
  assert.equal(mode.enabled, false);
  const root = await store.getActiveOperationalRole('9001');
  assert.equal(root.role, OPERATIONAL_ROLES.ROOT_ADMIN);
  console.log('ok Confidence Mode defaults OFF; root admin bootstrapped from env');

  await store.grantOperationalRole({
    telegramUserId: '8001',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: '9001',
    telegramDisplayName: 'Staff One'
  });
  const staff = await store.getActiveOperationalRole('8001');
  assert.equal(staff.role, OPERATIONAL_ROLES.STAFF);

  await store.grantOperationalRole({
    telegramUserId: '8002',
    role: OPERATIONAL_ROLES.COADMIN,
    grantedByTelegramUserId: '9001'
  });
  await store.grantOperationalRole({
    telegramUserId: '8003',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: '8002'
  });
  await store.revokeOperationalRole({ telegramUserId: '8001', revokedByTelegramUserId: '8002' });
  assert.ok(!(await store.getActiveOperationalRole('8001')));
  let rootRemoveFailed = false;
  try {
    await store.revokeOperationalRole({ telegramUserId: '9001', revokedByTelegramUserId: '8002' });
  } catch {
    rootRemoveFailed = true;
  }
  assert.equal(rootRemoveFailed, true);
  let staffToggleFailed = false;
  try {
    await store.setConfidenceMode({ enabled: true, actorTelegramUserId: '8003' });
  } catch {
    staffToggleFailed = true;
  }
  assert.equal(staffToggleFailed, true);
  const toggled = await store.setConfidenceMode({ enabled: true, actorTelegramUserId: '8002' });
  assert.equal(toggled.enabled, true);
  await store.setConfidenceMode({ enabled: false, actorTelegramUserId: '9001' });
  console.log('ok roles: coadmin can remove staff, cannot remove root; staff cannot toggle confidence');

  const ayush = await store.upsertTelegramUser({
    telegram_id: 1001,
    username: 'ayush',
    first_name: 'Ayush',
    last_name: '',
    is_bot: false
  });
  await store.updateRegistrationStatus(ayush.id, 'Registered', 'Test');
  await store.updateAutomationState(ayush.id, {
    registrationInfo: {
      preferred_appbeg_username: 'AyushVIP',
      appbeg_player_uid: 'player-ayush',
      appbeg_coadmin_uid: 'coadmin-1',
      appbeg_creation_complete: true
    }
  });
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('player-ayush', 'linked', ayush.id);

  const mike = await store.upsertTelegramUser({
    telegram_id: 1002,
    username: 'mike',
    first_name: 'Mike',
    last_name: '',
    is_bot: false
  });
  await store.updateRegistrationStatus(mike.id, 'Registered', 'Test');
  await store.updateAutomationState(mike.id, {
    registrationInfo: {
      preferred_appbeg_username: 'Mike123',
      appbeg_player_uid: 'player-mike',
      appbeg_coadmin_uid: 'coadmin-1',
      appbeg_creation_complete: true
    }
  });
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('player-mike', 'linked', mike.id);

  const found = await store.findRegisteredRoyalVipPlayerByUsername('Mike123', { coadminUid: 'coadmin-1' });
  assert.equal(Number(found.id), Number(mike.id));
  const missing = await store.findRegisteredRoyalVipPlayerByUsername('AppBegOnlyUser', { coadminUid: 'coadmin-1' });
  assert.equal(missing, null);
  console.log('ok load-another resolves only registered Royal VIP players');

  const ayushContact = contactShape(await store.getUserProfile(ayush.id));
  const startDeposit = await beginRegisteredDeposit(store, ayushContact, {
    preferred_appbeg_username: 'AyushVIP',
    appbeg_player_uid: 'player-ayush'
  });
  assert.equal(startDeposit.kind, 'deposit_choose_target');
  assert.match(startDeposit.replies[0].text, /Who are you loading/);
  assert.doesNotMatch(startDeposit.replies[0].text, /amount/i);

  await store.createPaymentMethod?.({ name: 'Chime', key: 'chime' }).catch(() => null);
  const methods = await store.listPaymentMethods();
  const chime = methods.find((m) => m.key === 'chime') || methods[0];
  if (chime) {
    await store.createPaymentQrCode({
      paymentMethodId: chime.id,
      filePath: path.join(tmpRoot, 'qr.png'),
      isDefault: true
    }).catch(() => {
      fs.writeFileSync(path.join(tmpRoot, 'qr.png'), 'qr');
    });
    fs.writeFileSync(path.join(tmpRoot, 'qr.png'), 'qr');
    try {
      await store.createPaymentQrCode({
        paymentMethodId: chime.id,
        filePath: path.join(tmpRoot, 'qr.png'),
        isDefault: true
      });
    } catch {
      // already exists
    }
  }

  const w1 = await store.createRegistrationPaymentWindow({
    contactId: ayush.id,
    telegramUserId: ayush.telegram_id,
    paymentMethodId: chime?.id || 1,
    paymentDisplayName: null,
    firstDepositAmount: null,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    requesterContactId: ayush.id,
    recipientContactId: mike.id,
    recipientUsername: 'Mike123',
    recipientPlayerUid: 'player-mike'
  });
  const w2 = await store.createRegistrationPaymentWindow({
    contactId: ayush.id,
    telegramUserId: ayush.telegram_id,
    paymentMethodId: chime?.id || 1,
    firstDepositAmount: null,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    requesterContactId: ayush.id,
    recipientContactId: ayush.id
  });
  assert.equal(Number(w1.id), Number(w2.id));
  assert.equal(Number(w1.first_deposit_amount), 0);
  assert.equal(w1.expected_payment_cents == null || w1.expected_payment_cents === '', true);
  const expires = new Date(w1.expires_at).getTime() - Date.now();
  assert.ok(expires > 14 * 60 * 1000 && expires <= 15 * 60 * 1000 + 2000);
  console.log('ok one active deposit window; 15 minute lifetime; payer vs recipient stored');

  const cancelled = await store.cancelDepositWindow({ contactId: ayush.id, windowId: w1.id });
  assert.equal(cancelled.ok, true);
  const stale = await store.cancelDepositWindow({ contactId: ayush.id, windowId: w1.id });
  assert.equal(stale.ok, true);
  const newer = await store.createRegistrationPaymentWindow({
    contactId: ayush.id,
    telegramUserId: ayush.telegram_id,
    paymentMethodId: chime?.id || 1,
    firstDepositAmount: null,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    requesterContactId: ayush.id,
    recipientContactId: ayush.id
  });
  const staleNewer = await store.cancelDepositWindow({ contactId: ayush.id, windowId: w1.id });
  assert.equal(staleNewer.ok, false);
  assert.ok(Number(newer.id) !== Number(w1.id));
  console.log('ok cancel is idempotent and stale cancel cannot close a newer window');

  await store.expireRegistrationPaymentWindow(newer.id, { suppressNotification: true });
  const afterExpiry = await store.createRegistrationPaymentWindow({
    contactId: ayush.id,
    telegramUserId: ayush.telegram_id,
    paymentMethodId: chime?.id || 1,
    firstDepositAmount: null,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    requesterContactId: ayush.id,
    recipientContactId: ayush.id
  });
  assert.ok(afterExpiry.id);
  console.log('ok new window after expiry');

  const now = new Date().toISOString();
  await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, routing_status,
      parsed_amount, parsed_sender_name, parsed_payment_app,
      message_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 'Parsed', 'unmatched', ?, ?, 'Chime', ?, ?, ?)
  `).run(501, -100, 'Pay', 'You received $10.00 from Calvin M.', 10, 'Calvin M.', now, now, now);
  const unmatchedEvent = await store.db.prepare('SELECT * FROM payment_events WHERE telegram_message_id = 501').get();
  assert.equal(unmatchedEvent.routing_status, 'unmatched');
  const stillActive = await store.getActiveRegistrationPaymentWindow(ayush.id, { flowType: PAYMENT_WINDOW_FLOW.DEPOSIT });
  assert.ok(stillActive);
  assert.equal(stillActive.matched_payment_event_id, null);
  const candidates = await store.listUnmatchedPaymentsForIdentity('calvin m');
  assert.ok(candidates.some((row) => Number(row.id) === Number(unmatchedEvent.id)));
  console.log('ok late unmatched payment does not attach to a new window');

  await staffFreezePayment(store, unmatchedEvent.id, '9001');
  const frozen = await store.getPaymentEvent(unmatchedEvent.id);
  assert.equal(frozen.routing_status, 'frozen');
  await staffUnfreezePayment(store, unmatchedEvent.id, '9001');
  const unfrozen = await store.getPaymentEvent(unmatchedEvent.id);
  assert.equal(unfrozen.routing_status, ROUTING_STATUS.NEEDS_CONFIRMATION);
  console.log('ok manual freeze/unfreeze');

  const guestUser = await store.upsertTelegramUser({
    telegram_id: 7777,
    username: 'guest',
    first_name: 'Guest',
    is_bot: false
  });
  const freeplay = await decideBotReply({
    store,
    contact: contactShape(await store.getUserProfile(guestUser.id)),
    messageText: '/start freeplay'
  });
  assert.match(freeplay.replies[0].text, /not registered/i);
  assert.equal(freeplay.replies[0].text, FREEPLAY_UNREGISTERED_TEXT);
  console.log('ok /start freeplay unregistered');

  const fpLock = await store.tryAcquireFreePlaySendLock(ayush.id, { cooldownMs: 1 });
  assert.equal(fpLock.ok, true);
  const fp = await store.createSupportRequest?.({
    kind: 'freeplay',
    contactId: ayush.id,
    username: 'AyushVIP',
    topic: 'FreePlay',
    message: 'request'
  }).catch(async () => {
    const nowText = new Date().toISOString();
    const result = await store.db.prepare(`
      INSERT INTO support_requests (kind, contact_id, username, topic, message, status, created_at, updated_at)
      VALUES ('freeplay', ?, 'AyushVIP', 'FreePlay', 'request', 'pending', ?, ?)
    `).run(ayush.id, nowText, nowText);
    return store.db.prepare('SELECT * FROM support_requests WHERE id = ?').get(result.lastInsertRowid);
  });
  const requestId = fp.id || fp;
  const firstGive = await resolveFreeplayGive(store, requestId, 10, '8002', 'Coadmin');
  assert.equal(firstGive.ok, true);
  assert.equal(firstGive.issuanceBlocked, true);
  assert.equal(firstGive.issued, false);
  assert.equal(firstGive.request.decision, 'approved');
  assert.notEqual(firstGive.request.decision, 'given');
  assert.equal(firstGive.request.issuance_status, 'unavailable');
  assert.equal(firstGive.error.code, FREEPLAY_ISSUANCE_BLOCKER);
  const secondGive = await resolveFreeplayGive(store, requestId, 10, '9001', 'Root');
  assert.equal(secondGive.ok, false);
  const declineRace = await resolveFreeplayDecline(store, requestId, '9001', 'Root');
  assert.equal(declineRace.ok, false);
  console.log('ok freeplay atomic resolve; AppBeg issuance blocked without invented endpoint');

  const otherPrompt = await continueRegisteredDeposit({
    store,
    contact: ayushContact,
    text: '',
    action: 'deposit:other',
    step: 'deposit_choose_target',
    info: { preferred_appbeg_username: 'AyushVIP' }
  });
  assert.equal(otherPrompt.kind, 'deposit_ask_other_username');
  const unknownOther = await continueRegisteredDeposit({
    store,
    contact: ayushContact,
    text: 'NotARoyalVipPlayer',
    action: null,
    step: 'deposit_other_username',
    info: { preferred_appbeg_username: 'AyushVIP', appbeg_coadmin_uid: 'coadmin-1' }
  });
  assert.equal(unknownOther.kind, 'deposit_other_not_found');
  const knownOther = await continueRegisteredDeposit({
    store,
    contact: ayushContact,
    text: 'Mike123',
    action: null,
    step: 'deposit_other_username',
    info: { preferred_appbeg_username: 'AyushVIP', appbeg_coadmin_uid: 'coadmin-1' }
  });
  assert.equal(knownOther.kind, 'deposit_confirm_other');
  assert.match(knownOther.replies[0].text, /Mike123/);
  console.log('ok another-player deposit confirmation');

  const assignResult = await staffAssignAndCredit(store, {
    paymentId: unmatchedEvent.id,
    recipientContactId: mike.id,
    payerContactId: ayush.id,
    actorTelegramUserId: '9001'
  });
  const assignedPayment = await store.getPaymentEvent(unmatchedEvent.id);
  assert.equal(Number(assignedPayment.recipient_contact_id), Number(mike.id));
  assert.equal(Number(assignedPayment.payer_contact_id), Number(ayush.id));
  assert.ok(assignResult.ok === true || assignResult.creditFailed === true);
  console.log('ok staff assignment records payer vs recipient');

  console.log('All Royal VIP telegram-first tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
