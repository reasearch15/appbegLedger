import assert from 'node:assert/strict';

import { createAppBegPlayerForContact } from '../src/appbeg/createPlayerService.js';
import { buildPaymentEventIdempotencyKey, creditAppBegDepositViaApi } from '../src/appbeg/depositCreditClient.js';
import { continueRegisteredDepositAfterPayment } from '../src/payments/depositPaymentFlow.js';
import { PAYMENT_WINDOW_FLOW } from '../src/payments/constants.js';

const originalFetch = globalThis.fetch;
const originalBot = globalThis.telegramBot;
const originalEnv = {
  APPBEG_API_URL: process.env.APPBEG_API_URL,
  APPBEG_LEDGER_INTERNAL_TOKEN: process.env.APPBEG_LEDGER_INTERNAL_TOKEN
};

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  globalThis.telegramBot = originalBot;
  if (originalEnv.APPBEG_API_URL == null) delete process.env.APPBEG_API_URL;
  else process.env.APPBEG_API_URL = originalEnv.APPBEG_API_URL;
  if (originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN == null) delete process.env.APPBEG_LEDGER_INTERNAL_TOKEN;
  else process.env.APPBEG_LEDGER_INTERNAL_TOKEN = originalEnv.APPBEG_LEDGER_INTERNAL_TOKEN;
}

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function makeCreateStore({ creditFails = false, markFails = false } = {}) {
  const calls = [];
  const info = {
    payment_confirmed: true,
    preferred_appbeg_username: 'JohnVIP01',
    appbeg_password: 'secret123',
    registration_payment_window_id: 44,
    appbeg_coadmin_uid: 'coadmin_1'
  };
  return {
    calls,
    async getUserProfile(id) {
      return {
        id,
        telegram_id: 777,
        registration_status: 'Pending Verification',
        appbeg_account_id: null
      };
    },
    async getAutomationState() {
      return { registration_info: { ...info } };
    },
    async getCoadminSettings() {
      return { appbeg_coadmin_uid: 'coadmin_1' };
    },
    async getRegistrationPaymentWindow(id) {
      return {
        id,
        contact_id: 10,
        flow_type: PAYMENT_WINDOW_FLOW.REGISTRATION,
        status: 'matched',
        status_raw: 'completed',
        first_deposit_amount: 25,
        matched_payment_event_id: 123
      };
    },
    async creditRegisteredDeposit(payload) {
      calls.push(['credit', payload]);
      if (creditFails) throw new Error('credit down');
      return { ok: true, status: 'credited' };
    },
    async markAppBegPlayerCreated(payload) {
      calls.push(['markRegistered', payload]);
      if (markFails) throw new Error('local write down');
      return { id: payload.userId, registration_status: 'Registered' };
    },
    async logEvent(payload) {
      calls.push(['logEvent', payload.eventType]);
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage() {}
  };
}

async function testRegistrationCreditBeforeRegistered() {
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://appbeg.test/api/internal/ledger/create-player');
    return makeResponse(200, { ok: true, playerUid: 'player_1', username: 'JohnVIP01' });
  };
  globalThis.telegramBot = {
    telegram: {
      async sendMessage() {
        return { message_id: 1, reply_markup: { inline_keyboard: [] } };
      }
    }
  };

  const store = makeCreateStore();
  await createAppBegPlayerForContact(store, { contactId: 10, actorName: 'Chatbot' });
  assert.equal(store.calls.findIndex(([name]) => name === 'credit') < store.calls.findIndex(([name]) => name === 'markRegistered'), true);
  assert.equal(store.calls.some(([name]) => name === 'markRegistered'), true);
  assert.equal(store.calls.find(([name]) => name === 'credit')[1].paymentEventId, 123);
  assert.equal(store.calls.find(([name]) => name === 'credit')[1].amount, 25);
}

async function testCreditFailureBlocksRegistered() {
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  globalThis.fetch = async () => makeResponse(200, { ok: true, playerUid: 'player_1', username: 'JohnVIP01' });
  const store = makeCreateStore({ creditFails: true });
  await assert.rejects(
    createAppBegPlayerForContact(store, { contactId: 10, actorName: 'Chatbot' }),
    /credit down/
  );
  assert.equal(store.calls.some(([name]) => name === 'markRegistered'), false);
}

async function testLocalFailureRetriesAsAlreadyCredited() {
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  let createCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/create-player')) {
      createCalls += 1;
      return createCalls === 1
        ? makeResponse(200, { ok: true, playerUid: 'player_1', username: 'JohnVIP01' })
        : makeResponse(409, { error: 'username already exists' });
    }
    return makeResponse(200, {
      status: 'already_credited',
      amount: 25,
      externalReference: buildPaymentEventIdempotencyKey(123),
      playerUid: 'player_1'
    });
  };
  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUsername() {
      return { uid: 'player_1', username: 'JohnVIP01', coadmin_uid: 'coadmin_1' };
    }
  };
  const firstStore = makeCreateStore({ markFails: true });
  await assert.rejects(createAppBegPlayerForContact(firstStore, { contactId: 10, actorName: 'Chatbot' }), /local write down/);
  const secondStore = makeCreateStore();
  await createAppBegPlayerForContact(secondStore, { contactId: 10, actorName: 'Chatbot' });
  assert.equal(secondStore.calls.some(([name]) => name === 'markRegistered'), true);
  delete globalThis.appbegStore;
}

async function testCreditClientIdempotencyAndConflict() {
  process.env.APPBEG_API_URL = 'https://appbeg.test/';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return makeResponse(200, { status: 'credited', amount: 25, externalReference: 'appbegledger-payment-event:123' });
    }
    if (requests.length === 2) {
      return makeResponse(200, { status: 'already_credited', amount: 25, externalReference: 'appbegledger-payment-event:123' });
    }
    return makeResponse(409, { error: 'externalReference is already used for a different credit.' });
  };

  const first = await creditAppBegDepositViaApi({
    playerUid: 'player_1',
    amount: 25,
    externalReference: 'appbegledger-payment-event:123'
  });
  const second = await creditAppBegDepositViaApi({
    playerUid: 'player_1',
    amount: 25,
    externalReference: 'appbegledger-payment-event:123'
  });
  assert.equal(first.status, 'credited');
  assert.equal(second.status, 'already_credited');
  await assert.rejects(
    creditAppBegDepositViaApi({
      playerUid: 'player_1',
      amount: 26,
      externalReference: 'appbegledger-payment-event:123'
    }),
    /different credit/
  );
}

async function testNormalDepositUsesSharedCredit() {
  const calls = [];
  const store = {
    async getUserProfile(id) {
      return { id, telegram_id: 777 };
    },
    async getRegistrationPaymentWindow(id) {
      return {
        id,
        contact_id: 10,
        flow_type: PAYMENT_WINDOW_FLOW.DEPOSIT,
        first_deposit_amount: 15
      };
    },
    async getAutomationState() {
      return { registration_info: { deposit_payment_window_id: 55 } };
    },
    async updateRegistrationInfo() {},
    async updateAutomationState() {},
    async logEvent() {},
    async getAutoRegistrationBotSettings() {
      return { enabled: false };
    },
    async logPaymentRouting() {},
    async updatePaymentRouting() {},
    async creditRegisteredDeposit(payload) {
      calls.push(payload);
      return { ok: true, status: 'credited' };
    }
  };

  await continueRegisteredDepositAfterPayment(store, {
    contactId: 10,
    windowId: 55,
    paymentEventId: 456,
    alreadyClaimed: true
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].flowType, PAYMENT_WINDOW_FLOW.DEPOSIT);
  assert.equal(calls[0].amount, 15);
}

try {
  await testRegistrationCreditBeforeRegistered();
  await testCreditFailureBlocksRegistered();
  await testLocalFailureRetriesAsAlreadyCredited();
  await testCreditClientIdempotencyAndConflict();
  await testNormalDepositUsesSharedCredit();
  console.log('ok registration initial deposit credit');
} finally {
  restoreGlobals();
}
