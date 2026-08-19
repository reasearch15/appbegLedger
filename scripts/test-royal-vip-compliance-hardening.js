import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import {
  FREEPLAY_DECISION,
  FREEPLAY_ISSUANCE_BLOCKER,
  FREEPLAY_ISSUANCE_STATUS,
  buildFreeplayIdempotencyKey
} from '../src/appbeg/freeplayIssuanceClient.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';
import { findMatchingActivePaymentWindow, windowExpectedAmountCents } from '../src/payments/paymentWindowMatcher.js';
import { OPERATIONAL_ROLES, describeRootAdminEstablishment } from '../src/telegram/operationalRoles.js';
import { STAFF_CB } from '../src/telegram/staffCards.js';
import {
  handleStaffCallbackQuery,
  handleStaffGroupMessage,
  __resetStaffPendingPromptsForTests
} from '../src/telegram/staffGroupHandler.js';
import { resolveFreeplayGive, retryFreeplayIssuance } from '../src/telegram/staffOperations.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-vip-compliance-'));
const dbPath = path.join(tmpRoot, 'test.sqlite');
const STAFF_GROUP_ID = '-100555000';

function futureIso(minutes = 15) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function insertFreeplay(store, contactId, username = 'Calvin') {
  const now = new Date().toISOString();
  const result = await store.db.prepare(`
    INSERT INTO support_requests (kind, contact_id, username, topic, message, status, created_at, updated_at)
    VALUES ('freeplay', ?, ?, 'FreePlay', 'request', 'pending', ?, ?)
  `).run(contactId, username, now, now);
  return store.db.prepare('SELECT * FROM support_requests WHERE id = ?').get(result.lastInsertRowid);
}

function mockIssuerTracker() {
  const calls = [];
  const issuer = async ({ requestId, amount, idempotencyKey }) => {
    calls.push({ requestId, amount, idempotencyKey });
    return { ok: true, idempotencyKey };
  };
  return { calls, issuer };
}

function failingIssuer(code = 'APPBEG_FREEPLAY_FAILED') {
  return async () => {
    const error = new Error('AppBeg rejected freeplay issuance.');
    error.code = code;
    throw error;
  };
}

function makeGroupCtx({ fromId, text = '', caption = null, photo = false, document = false, threadId = null, firstName = 'Staff' }) {
  const replies = [];
  return {
    replies,
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName, username: `user${fromId}` },
    message: {
      message_id: Number(String(Date.now()).slice(-6)),
      text: caption ? undefined : text,
      caption: caption || undefined,
      photo: photo ? [{ file_id: 'photo' }] : undefined,
      document: document ? { file_id: 'doc' } : undefined,
      message_thread_id: threadId,
      from: { id: Number(fromId) }
    },
    async reply(body) {
      replies.push(body);
      return { message_id: replies.length };
    }
  };
}

function makeCbCtx({ fromId, data, firstName = 'Staff' }) {
  const replies = [];
  let answered = null;
  return {
    replies,
    get answered() { return answered; },
    chat: { id: Number(STAFF_GROUP_ID), type: 'supergroup' },
    from: { id: Number(fromId), first_name: firstName, username: `user${fromId}` },
    callbackQuery: { data, message: { message_thread_id: 77 } },
    async answerCbQuery(text) { answered = text || ''; },
    async reply(body) {
      replies.push(body);
      return { message_id: replies.length };
    }
  };
}

async function run() {
  process.env.ROOT_ADMIN_TELEGRAM_USER_ID = '9001';
  process.env.STAFF_TELEGRAM_GROUP_ID = STAFF_GROUP_ID;

  const store = await createDataStore({ dialect: 'sqlite', databasePath: dbPath });
  await store.updateCoadminSettings?.({
    coadmin_name: 'Test',
    coadmin_code: 'T1',
    appbeg_coadmin_uid: 'coadmin-1'
  }, 'Test').catch(() => null);

  const calvin = await store.upsertTelegramUser({
    telegram_id: 1001,
    username: 'calvin',
    first_name: 'Calvin',
    last_name: '',
    is_bot: false
  });
  await store.updateRegistrationStatus(calvin.id, 'Registered', 'Test');
  await store.db.prepare('UPDATE telegram_users SET appbeg_account_id = ?, appbeg_link_status = ? WHERE id = ?')
    .run('player-calvin', 'linked', calvin.id);
  await store.updateAutomationState(calvin.id, {
    registrationInfo: {
      preferred_appbeg_username: 'Calvin',
      appbeg_player_uid: 'player-calvin',
      appbeg_creation_complete: true
    }
  });

  const topic = await store.upsertStaffTopic({
    contactId: calvin.id,
    telegramUserId: calvin.telegram_id,
    staffGroupId: STAFF_GROUP_ID,
    messageThreadId: 77,
    topicName: 'Calvin'
  });
  assert.equal(Number(topic.message_thread_id), 77);

  await store.grantOperationalRole({
    telegramUserId: '8002',
    role: OPERATIONAL_ROLES.COADMIN,
    grantedByTelegramUserId: '9001',
    telegramDisplayName: 'Coadmin'
  });
  await store.grantOperationalRole({
    telegramUserId: '8003',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: '8002',
    telegramDisplayName: 'Alice'
  });
  await store.grantOperationalRole({
    telegramUserId: '8004',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: '9001',
    telegramDisplayName: 'Bob'
  });

  const playerDms = [];
  const bot = {
    telegram: {
      async sendMessage(chatId, text) {
        playerDms.push({ chatId: String(chatId), text: String(text) });
        return { message_id: playerDms.length + 100 };
      }
    }
  };

  // --- FREEPLAY 1: staff approve with issuance unavailable is NOT GIVEN ---
  const fpUnavailable = await insertFreeplay(store, calvin.id);
  const unavailableGive = await resolveFreeplayGive(store, fpUnavailable.id, 10, '8003', 'Alice');
  assert.equal(unavailableGive.ok, true);
  assert.equal(unavailableGive.issued, false);
  assert.equal(unavailableGive.request.decision, FREEPLAY_DECISION.APPROVED);
  assert.notEqual(unavailableGive.request.decision, FREEPLAY_DECISION.GIVEN);
  assert.equal(unavailableGive.request.issuance_status, FREEPLAY_ISSUANCE_STATUS.UNAVAILABLE);
  assert.equal(unavailableGive.error.code, FREEPLAY_ISSUANCE_BLOCKER);
  assert.equal(unavailableGive.idempotencyKey, buildFreeplayIdempotencyKey(fpUnavailable.id));
  console.log('ok 1 freeplay unavailable approval is not given');

  __resetStaffPendingPromptsForTests();
  playerDms.length = 0;
  const giveCtx = makeCbCtx({ fromId: '8002', data: `${STAFF_CB.FP_GIVE}${fpUnavailable.id}`, firstName: 'Coadmin' });
  await handleStaffCallbackQuery({ ctx: giveCtx, store });
  const amountCtx = makeGroupCtx({ fromId: '8002', text: '10', firstName: 'Coadmin' });
  await handleStaffGroupMessage({ ctx: amountCtx, store, bot });
  const confirmCtx = makeCbCtx({ fromId: '8002', data: `${STAFF_CB.FP_CONFIRM}${fpUnavailable.id}`, firstName: 'Coadmin' });
  await handleStaffCallbackQuery({ ctx: confirmCtx, store });
  assert.equal(confirmCtx.answered, 'Already resolved');
  assert.equal(playerDms.some((item) => /freeplay added|approved for|has been issued/i.test(item.text)), false);

  const fpPlayerMsg = await insertFreeplay(store, calvin.id, 'Calvin');
  __resetStaffPendingPromptsForTests();
  playerDms.length = 0;
  await handleStaffCallbackQuery({ ctx: makeCbCtx({ fromId: '8003', data: `${STAFF_CB.FP_GIVE}${fpPlayerMsg.id}`, firstName: 'Alice' }), store });
  await handleStaffGroupMessage({ ctx: makeGroupCtx({ fromId: '8003', text: '10', firstName: 'Alice' }), store, bot });
  const confirmNew = makeCbCtx({ fromId: '8003', data: `${STAFF_CB.FP_CONFIRM}${fpPlayerMsg.id}`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: confirmNew, store });
  assert.match(confirmNew.replies.join('\n'), /FREEPLAY NOT LOADED/);
  assert.match(confirmNew.replies.join('\n'), /AppBeg Freeplay issuance is not configured/);
  assert.equal(playerDms.length, 0);
  const afterUnavailable = await store.db.prepare('SELECT * FROM support_requests WHERE id = ?').get(fpPlayerMsg.id);
  assert.equal(afterUnavailable.decision, FREEPLAY_DECISION.APPROVED);
  assert.notEqual(afterUnavailable.decision, FREEPLAY_DECISION.GIVEN);
  console.log('ok 1 staff confirm unavailable does not message player success');

  // --- FREEPLAY 2: issuance failure is NOT GIVEN ---
  const fpFail = await insertFreeplay(store, calvin.id);
  const failedGive = await resolveFreeplayGive(store, fpFail.id, 15, '8003', 'Alice', { issuer: failingIssuer() });
  assert.equal(failedGive.ok, true);
  assert.equal(failedGive.issued, false);
  assert.equal(failedGive.request.decision, FREEPLAY_DECISION.APPROVED);
  assert.equal(failedGive.request.issuance_status, FREEPLAY_ISSUANCE_STATUS.FAILED);
  console.log('ok 2 freeplay issuance failure is not given');

  // --- FREEPLAY 3: mocked proven issuer marks GIVEN once ---
  const fpSuccess = await insertFreeplay(store, calvin.id);
  const successTracker = mockIssuerTracker();
  const successGive = await resolveFreeplayGive(store, fpSuccess.id, 20, '9001', 'Root', { issuer: successTracker.issuer });
  assert.equal(successGive.issued, true);
  assert.equal(successGive.request.decision, FREEPLAY_DECISION.GIVEN);
  assert.equal(successGive.request.issuance_status, FREEPLAY_ISSUANCE_STATUS.ISSUED);
  assert.equal(successTracker.calls.length, 1);
  console.log('ok 3 freeplay issuance success becomes given once');

  // --- FREEPLAY 4: two staff confirm simultaneously ---
  const fpRace = await insertFreeplay(store, calvin.id);
  const raceTracker = mockIssuerTracker();
  const [raceA, raceB] = await Promise.all([
    resolveFreeplayGive(store, fpRace.id, 8, '8003', 'Alice', { issuer: raceTracker.issuer }),
    resolveFreeplayGive(store, fpRace.id, 8, '8004', 'Bob', { issuer: raceTracker.issuer })
  ]);
  const winners = [raceA, raceB].filter((item) => item.ok && item.issued);
  const losers = [raceA, raceB].filter((item) => !item.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(raceTracker.calls.length, 1);
  const raced = await store.db.prepare('SELECT * FROM support_requests WHERE id = ?').get(fpRace.id);
  assert.equal(raced.decision, FREEPLAY_DECISION.GIVEN);
  console.log('ok 4 two staff confirm cannot duplicate issuance');

  // --- FREEPLAY 5: duplicate callback ---
  const dup = await resolveFreeplayGive(store, fpSuccess.id, 20, '8003', 'Alice', { issuer: successTracker.issuer });
  assert.equal(dup.ok, false);
  assert.equal(successTracker.calls.length, 1);
  console.log('ok 5 duplicate callback does not reissue');

  // --- FREEPLAY 6: retry keeps the same idempotency identity ---
  const fpRetry = await insertFreeplay(store, calvin.id);
  const firstBlocked = await resolveFreeplayGive(store, fpRetry.id, 12, '8003', 'Alice');
  const retried = await retryFreeplayIssuance(store, fpRetry.id, '8002');
  assert.equal(firstBlocked.idempotencyKey, buildFreeplayIdempotencyKey(fpRetry.id));
  assert.equal(retried.idempotencyKey, firstBlocked.idempotencyKey);
  assert.notEqual(retried.request.decision, FREEPLAY_DECISION.GIVEN);
  const retrySuccess = mockIssuerTracker();
  const retriedIssued = await retryFreeplayIssuance(store, fpRetry.id, '9001', { issuer: retrySuccess.issuer });
  assert.equal(retriedIssued.issued, true);
  assert.equal(retrySuccess.calls[0].idempotencyKey, firstBlocked.idempotencyKey);
  const secondRetry = await retryFreeplayIssuance(store, fpRetry.id, '9001', { issuer: retrySuccess.issuer });
  assert.equal(secondRetry.ok, false);
  assert.equal(retrySuccess.calls.length, 1);
  console.log('ok 6 retry uses the same freeplay idempotency key');

  // --- ROOT ADMIN 7-12 ---
  const binding = await store.inspectRootAdminBinding();
  assert.equal(binding.machineVerified, false);
  assert.equal(binding.source, 'trusted_bootstrap_env');
  assert.equal(binding.configuredTelegramUserId, '9001');
  assert.equal(binding.boundTelegramUserId, '9001');
  assert.equal(binding.aligned, true);
  assert.equal(describeRootAdminEstablishment().machineVerified, false);
  const root = await store.getActiveOperationalRole('9001');
  assert.equal(root.role, OPERATIONAL_ROLES.ROOT_ADMIN);
  console.log('ok 7 configured root admin retains ROOT_ADMIN');

  let coadminRevokeRoot = false;
  try {
    await store.revokeOperationalRole({ telegramUserId: '9001', revokedByTelegramUserId: '8002' });
  } catch (error) {
    coadminRevokeRoot = error.code === 'ROOT_ADMIN_IMMUTABLE';
  }
  assert.equal(coadminRevokeRoot, true);
  console.log('ok 8 coadmin cannot revoke root');

  let staffRevokeRoot = false;
  try {
    await store.revokeOperationalRole({ telegramUserId: '9001', revokedByTelegramUserId: '8003' });
  } catch (error) {
    staffRevokeRoot = error.code === 'FORBIDDEN' || error.code === 'ROOT_ADMIN_IMMUTABLE';
  }
  assert.equal(staffRevokeRoot, true);
  console.log('ok 9 staff cannot revoke root');

  await store.db.prepare('UPDATE operational_roles SET telegram_username = ? WHERE telegram_user_id = ? AND revoked_at IS NULL')
    .run('root_renamed', '9001');
  assert.equal((await store.getActiveOperationalRole('9001')).role, OPERATIONAL_ROLES.ROOT_ADMIN);
  assert.equal(describeRootAdminEstablishment().configuredTelegramUserId, '9001');
  console.log('ok 10 username change does not affect root identity');

  assert.equal(await store.getActiveOperationalRole(String(calvin.telegram_id)), null);
  assert.equal(await store.getActiveOperationalRole('5555'), null);
  console.log('ok 11 ordinary channel member receives no authority');

  const forgedRootCb = makeCbCtx({ fromId: '5555', data: `${STAFF_CB.STAFF_REVOKE}9001` });
  await handleStaffCallbackQuery({ ctx: forgedRootCb, store });
  assert.equal(forgedRootCb.answered, 'Not authorized');
  assert.equal((await store.getActiveOperationalRole('9001')).role, OPERATIONAL_ROLES.ROOT_ADMIN);
  assert.equal(await store.getActiveOperationalRole('5555'), null);
  const staffRevokeCb = makeCbCtx({ fromId: '8003', data: `${STAFF_CB.STAFF_REVOKE}9001`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: staffRevokeCb, store });
  assert.equal((await store.getActiveOperationalRole('9001')).role, OPERATIONAL_ROLES.ROOT_ADMIN);
  const coadminRevokeCb = makeCbCtx({ fromId: '8002', data: `${STAFF_CB.STAFF_REVOKE}9001`, firstName: 'Coadmin' });
  await handleStaffCallbackQuery({ ctx: coadminRevokeCb, store });
  assert.equal((await store.getActiveOperationalRole('9001')).role, OPERATIONAL_ROLES.ROOT_ADMIN);
  let grantRootFailed = false;
  try {
    await store.grantOperationalRole({
      telegramUserId: '5555',
      role: OPERATIONAL_ROLES.ROOT_ADMIN,
      grantedByTelegramUserId: '9001'
    });
  } catch {
    grantRootFailed = true;
  }
  assert.equal(grantRootFailed, true);
  console.log('ok 12 wrong Telegram ID cannot inherit Root from callback data');

  // --- STAFF TOPICS 13-20 ---
  async function countStaffPlayerMessages(text) {
    const rows = await store.listMessagesForUser(calvin.id);
    return rows.filter((row) => row.sender_type === 'staff' && row.text === text).length;
  }

  playerDms.length = 0;
  const staffText = 'Authorized staff reply';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '8003', text: staffText, threadId: 77, firstName: 'Alice' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === staffText && item.chatId === String(calvin.telegram_id)), true);
  assert.equal(await countStaffPlayerMessages(staffText), 1);
  console.log('ok 13 authorized staff text reply is forwarded');

  const coadminText = 'Authorized coadmin reply';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '8002', text: coadminText, threadId: 77, firstName: 'Coadmin' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === coadminText), true);
  console.log('ok 14 authorized coadmin reply is forwarded');

  const rootText = 'Authorized root reply';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '9001', text: rootText, threadId: 77, firstName: 'Root' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === rootText), true);
  console.log('ok 15 authorized root reply is forwarded');

  await store.revokeOperationalRole({ telegramUserId: '8003', revokedByTelegramUserId: '8002' });
  assert.equal(await store.getActiveOperationalRole('8003'), null);
  const beforeRevokeCount = playerDms.length;
  const revokedText = 'Your payment is confirmed.';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '8003', text: revokedText, threadId: 77, firstName: 'Alice' }),
    store,
    bot
  });
  assert.equal(playerDms.length, beforeRevokeCount);
  assert.equal(await countStaffPlayerMessages(revokedText), 0);
  const staleGive = makeCbCtx({ fromId: '8003', data: `${STAFF_CB.FP_GIVE}${fpPlayerMsg.id}`, firstName: 'Alice' });
  await handleStaffCallbackQuery({ ctx: staleGive, store });
  assert.equal(staleGive.answered, 'Not authorized');
  console.log('ok 16 revoked staff reply is not forwarded');

  const strangerText = 'Hello Calvin';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '5555', text: strangerText, threadId: 77, firstName: 'Stranger' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === strangerText), false);
  assert.equal(await countStaffPlayerMessages(strangerText), 0);
  console.log('ok 17 random staff-group member is not forwarded');

  const forgedText = 'Forged sender message';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '5555', text: forgedText, threadId: 77 }),
    store,
    bot
  });
  const forgedCb = makeCbCtx({ fromId: '5555', data: STAFF_CB.CTRL });
  await handleStaffCallbackQuery({ ctx: forgedCb, store });
  assert.equal(forgedCb.answered, 'Not authorized');
  assert.equal(playerDms.some((item) => item.text === forgedText), false);
  console.log('ok 18 forged sender/callback is not forwarded');

  const revokedCaption = 'Revoked media caption';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({
      fromId: '8003',
      caption: revokedCaption,
      photo: true,
      threadId: 77,
      firstName: 'Alice'
    }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === revokedCaption), false);
  assert.equal(await countStaffPlayerMessages(revokedCaption), 0);
  console.log('ok 19 revoked user media is not forwarded');

  await store.grantOperationalRole({
    telegramUserId: '8005',
    role: OPERATIONAL_ROLES.STAFF,
    grantedByTelegramUserId: '9001',
    telegramDisplayName: 'LaterRevoked'
  });
  const liveText = 'Still authorized at handling time';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '8005', text: liveText, threadId: 77, firstName: 'LaterRevoked' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === liveText), true);
  await store.revokeOperationalRole({ telegramUserId: '8005', revokedByTelegramUserId: '9001' });
  const afterLiveRevoke = 'Should not go out after revoke';
  await handleStaffGroupMessage({
    ctx: makeGroupCtx({ fromId: '8005', text: afterLiveRevoke, threadId: 77, firstName: 'LaterRevoked' }),
    store,
    bot
  });
  assert.equal(playerDms.some((item) => item.text === afterLiveRevoke), false);
  console.log('ok 20 authorization is checked at message handling time');

  // --- AMOUNTLESS WINDOW 21-23 ---
  await store.createPaymentMethod?.({ name: 'Chime', key: 'chime' }).catch(() => null);
  const methods = await store.listPaymentMethods();
  const chime = methods.find((item) => item.key === 'chime') || methods[0];
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
  const amountless = await store.createRegistrationPaymentWindow({
    contactId: calvin.id,
    telegramUserId: calvin.telegram_id,
    paymentMethodId: chime.id,
    paymentDisplayName: 'Calvin M',
    firstDepositAmount: null,
    flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
    requesterContactId: calvin.id,
    recipientContactId: calvin.id,
    recipientPlayerUid: 'player-calvin'
  });
  assert.equal(Number(amountless.first_deposit_amount), 0);
  assert.ok(amountless.expected_payment_cents == null || amountless.expected_payment_cents === '');
  assert.equal(windowExpectedAmountCents(amountless), 0);
  const sqliteMatch = findMatchingActivePaymentWindow([amountless], {
    amount: 12.5,
    payment_sender_name: 'Calvin M',
    payment_app: 'chime'
  });
  assert.equal(sqliteMatch.result, 'exact_match');
  console.log('ok 21 sqlite amount=0 is amountless, not a $0 expected deposit');

  const postgresShaped = {
    ...amountless,
    first_deposit_amount: null,
    expected_payment_cents: null,
    status: 'active',
    status_raw: 'active',
    matched_payment_event_id: null,
    expires_at: amountless.expires_at || futureIso()
  };
  assert.equal(windowExpectedAmountCents(postgresShaped), null);
  const postgresMatch = findMatchingActivePaymentWindow([postgresShaped], {
    amount: 12.5,
    payment_sender_name: 'Calvin M',
    payment_app: 'chime'
  });
  assert.equal(postgresMatch.result, 'exact_match');
  console.log('ok 23 postgres NULL and sqlite 0 follow the same amountless match logic');

  const now = new Date().toISOString();
  const paymentInsert = await store.db.prepare(`
    INSERT INTO payment_events (
      telegram_message_id, telegram_group_id, telegram_group_title,
      message_text, raw_payload_json, processing_status, parsed_amount,
      parsed_sender_name, routing_status, contact_id, payer_contact_id, recipient_contact_id,
      registration_payment_window_id,
      message_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Completed', ?, 'Calvin M', 'needs_confirmation', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    70001,
    -1001,
    'Payments',
    'Calvin M sent $12.50',
    '{}',
    12.5,
    calvin.id,
    calvin.id,
    calvin.id,
    amountless.id,
    now,
    now,
    now
  );
  const paymentId = Number(paymentInsert.lastInsertRowid);
  await store.db.prepare(`
    UPDATE registration_payment_windows
    SET status = 'completed',
        matched_payment_event_id = ?,
        received_payment_amount = 12.5,
        received_payment_cents = 1250
    WHERE id = ?
  `).run(paymentId, amountless.id);

  const prevFetch = globalThis.fetch;
  const prevApi = process.env.APPBEG_API_URL;
  const prevToken = process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  const creditBodies = [];
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'test-token';
  globalThis.fetch = async (_url, options) => {
    creditBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ status: 'credited', amount: JSON.parse(options.body).amount });
      }
    };
  };
  try {
    await store.creditRegisteredDeposit({
      contactId: calvin.id,
      paymentEventId: paymentId,
      windowId: amountless.id,
      flowType: PAYMENT_WINDOW_FLOW.DEPOSIT,
      playerUid: 'player-calvin'
    });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevApi === undefined) delete process.env.APPBEG_API_URL;
    else process.env.APPBEG_API_URL = prevApi;
    if (prevToken === undefined) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
    else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = prevToken;
  }
  assert.equal(creditBodies.length, 1);
  assert.equal(Number(creditBodies[0].amount), 12.5);
  assert.equal(Number(creditBodies[0].paymentAmount), 12.5);
  assert.equal(Number(creditBodies[0].paymentCents), 1250);
  assert.notEqual(Number(creditBodies[0].amount), 0);
  console.log('ok 22 parsed incoming payment amount is the credited amount');

  await store.close?.().catch(() => null);
  console.log('ok royal vip compliance hardening');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
