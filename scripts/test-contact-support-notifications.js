import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';
import {
  ASK_FREEPLAY_ACTION,
  FREEPLAY_COOLDOWN_MS,
  FREEPLAY_INELIGIBLE_TEXT,
  FREEPLAY_REQUEST_SENT_TEXT
} from '../src/telegram/freePlayRequest.js';
import {
  CONTACT_SUPPORT_OPTIONS,
  SUPPORT_CUSTOM_INQUIRY_ACTION,
  SUPPORT_TOPIC_PREFIX
} from '../src/telegram/contactSupportFlow.js';
import {
  SUPPORT_ACCOUNT_NOT_FOUND_TEXT,
  SUPPORT_DELIVERY_FAILED_TEXT,
  SUPPORT_REQUEST_SENT_TEXT,
  INQUIRY_REQUEST_SENT_TEXT
} from '../src/telegram/supportNotificationBot.js';

function contact(overrides = {}) {
  return {
    id: 34,
    telegram_id: 5476500286,
    display_name: 'Amy F.',
    username: 'amyf',
    registration_status: 'Registered',
    appbeg_account_id: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
    active_messaging_source: 'bot_api',
    ...overrides
  };
}

function baseInfo(overrides = {}) {
  return {
    royal_vip_credentials: {
      username: 'Amyfi02',
      password: 'Secret123',
      player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
      telegram_user_id: 5476500286
    },
    appbeg_player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
    ...overrides
  };
}

function createMemoryStore({ registrationInfo = baseInfo(), freePlay = null } = {}) {
  let state = {
    current_flow: null,
    current_step: null,
    registration_info: { ...registrationInfo }
  };
  let freeplayRequestedAt = null;
  let freeplayInflightAt = null;
  let supportInflightAt = null;
  let supportLastAt = null;
  let supportLastKey = null;
  const completed = [];
  return {
    completed,
    async getUserProfile(id) {
      assert.equal(id, 34);
      return contact();
    },
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async updateAutomationState(_id, patch = {}) {
      state = {
        ...state,
        current_flow: patch.currentFlow === undefined ? state.current_flow : patch.currentFlow,
        current_step: patch.currentStep === undefined ? state.current_step : patch.currentStep,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.getAutomationState();
    },
    async updateRegistrationInfo(_id, info = {}) {
      state.registration_info = { ...state.registration_info, ...info };
      return this.getAutomationState();
    },
    async getActiveRegistrationPaymentWindow() { return null; },
    async isIncomingMessageEligibleForAutoBot() { return { eligible: true }; },
    async getAutoRegistrationBotSettings() { return { enabled: true }; },
    async getContactPreferredMessageSource() { return 'bot_api'; },
    async storeOutgoingMessage(message) { return { id: 1, ...message }; },
    async completeBotJob(id, payload) { completed.push({ id, payload }); },
    async logAutomationDecision() {},
    async tryAcquireFreePlaySendLock(_id, { cooldownMs = FREEPLAY_COOLDOWN_MS } = {}) {
      const now = Date.now();
      if (freeplayRequestedAt && (now - Date.parse(freeplayRequestedAt)) < cooldownMs) {
        return { ok: false, reason: 'cooldown_active', requestedAt: freeplayRequestedAt };
      }
      if (freeplayInflightAt && (now - Date.parse(freeplayInflightAt)) < 120000) {
        return { ok: false, reason: 'inflight', inflightAt: freeplayInflightAt };
      }
      freeplayInflightAt = new Date().toISOString();
      return { ok: true, inflightAt: freeplayInflightAt };
    },
    async commitFreePlayRequest(_id, { inflightAt } = {}) {
      if (inflightAt && freeplayInflightAt !== inflightAt) return { ok: false };
      freeplayRequestedAt = new Date().toISOString();
      freeplayInflightAt = null;
      return { ok: true, requestedAt: freeplayRequestedAt };
    },
    async releaseFreePlaySendLock(_id, inflightAt = null) {
      if (inflightAt && freeplayInflightAt !== inflightAt) return { ok: false };
      freeplayInflightAt = null;
      return { ok: true };
    },
    async tryAcquireSupportNotifyLock(_id, fingerprint) {
      const now = Date.now();
      if (supportLastKey === fingerprint && supportLastAt && (now - Date.parse(supportLastAt)) < 60000) {
        return { ok: false, reason: 'duplicate_recent', alreadySent: true };
      }
      if (supportInflightAt && (now - Date.parse(supportInflightAt)) < 120000) {
        return { ok: false, reason: 'inflight' };
      }
      supportInflightAt = new Date().toISOString();
      return { ok: true, inflightAt: supportInflightAt, fingerprint };
    },
    async commitSupportNotifyLock(_id, { fingerprint, inflightAt } = {}) {
      if (inflightAt && supportInflightAt !== inflightAt) return { ok: false };
      supportLastKey = fingerprint;
      supportLastAt = new Date().toISOString();
      supportInflightAt = null;
      return { ok: true };
    },
    async releaseSupportNotifyLock(_id, inflightAt = null) {
      if (inflightAt && supportInflightAt !== inflightAt) return { ok: false };
      supportInflightAt = null;
      return { ok: true };
    },
    _forceFreePlayRequestedAt(iso) {
      freeplayRequestedAt = iso;
    },
    _state() { return state; }
  };
}

function mockSupportFetch(calls, { fail = false } = {}) {
  return async (url, options = {}) => {
    assert.match(String(url), /api\.telegram\.org\/bot/);
    assert.doesNotMatch(String(url), /SECRET_TOKEN_SHOULD_NOT_APPEAR_IN_LOGS/);
    const body = JSON.parse(options.body || '{}');
    calls.push({ url: String(url).replace(/bot[^/]+/, 'bot<redacted>'), body });
    if (fail) {
      return {
        ok: false,
        status: 500,
        async json() { return { ok: false, error_code: 500, description: 'boom' }; }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: { message_id: 1000 + calls.length } }; }
    };
  };
}

async function run() {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  const previousChat = process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = 'test-support-token';
  process.env.SUPPORT_NOTIFICATION_CHAT_ID = '424242';

  const supportCalls = [];
  globalThis.fetch = mockSupportFetch(supportCalls);

  const menu = await decideBotReply({
    store: createMemoryStore(),
    contact: contact(),
    action: 'menu:support'
  });
  assert.equal(menu.kind, 'contact_support_menu');
  assert.ok(menu.replies[0].buttons.flat().some((b) => b.data === `${SUPPORT_TOPIC_PREFIX}password_help`));
  assert.ok(menu.replies[0].buttons.flat().some((b) => b.data === SUPPORT_CUSTOM_INQUIRY_ACTION));
  console.log('ok Contact Support opens topic menu');

  for (const option of CONTACT_SUPPORT_OPTIONS.filter((item) => item.notify)) {
    const store = createMemoryStore();
    const player = [];
    const bot = {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          player.push({ chatId, text, options });
          return { message_id: player.length, reply_markup: options.reply_markup || null };
        }
      }
    };
    supportCalls.length = 0;
    await processBotJob(store, {
      id: 10,
      contact_id: 34,
      telegram_user_id: 5476500286,
      job_type: 'callback_action',
      action: `${SUPPORT_TOPIC_PREFIX}${option.key}`,
      update_id: 8000 + supportCalls.length + Math.random(),
      incoming_telegram_message_id: 100,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(supportCalls.length, 1);
    assert.match(supportCalls[0].body.text, /^🆘 Support Request/);
    assert.match(supportCalls[0].body.text, /AppBeg Username: Amyfi02/);
    assert.match(supportCalls[0].body.text, new RegExp(`Topic: ${option.topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(supportCalls[0].body.text, /Telegram|Contact ID|Player UID|5476500286|@amyf/i);
    assert.equal(player.at(-1).text, SUPPORT_REQUEST_SENT_TEXT);
  }
  console.log('ok every human-help Contact Support FAQ notifies via separate bot');

  const infoStore = createMemoryStore();
  const infoDecision = await decideBotReply({
    store: infoStore,
    contact: contact(),
    action: `${SUPPORT_TOPIC_PREFIX}how_deposit`
  });
  assert.match(infoDecision.replies[0].text, /How to deposit/i);
  assert.equal(infoDecision.supportOwnerNotify, undefined);
  console.log('ok informational FAQ answers locally without support notification');

  const inquiryStore = createMemoryStore();
  const prompt = await decideBotReply({
    store: inquiryStore,
    contact: contact(),
    action: SUPPORT_CUSTOM_INQUIRY_ACTION
  });
  assert.equal(prompt.statePatch.currentStep, 'awaiting_support_inquiry');
  await inquiryStore.updateAutomationState(34, prompt.statePatch);
  const inquiryPlayer = [];
  const inquiryBot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        inquiryPlayer.push({ chatId, text, options });
        return { message_id: inquiryPlayer.length, reply_markup: options.reply_markup || null };
      }
    }
  };
  supportCalls.length = 0;
  await processBotJob(inquiryStore, {
    id: 20,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'inbound_message',
    input_text: 'My deposit of $5 did not credit <script>',
    update_id: 9001,
    incoming_telegram_message_id: 201,
    created_at: new Date().toISOString()
  }, { bot: inquiryBot });
  assert.equal(supportCalls.length, 1);
  assert.match(supportCalls[0].body.text, /^❓ New Inquiry/);
  assert.match(supportCalls[0].body.text, /AppBeg Username: Amyfi02/);
  assert.match(supportCalls[0].body.text, /Question:\nMy deposit of \$5 did not credit <script>/);
  assert.doesNotMatch(supportCalls[0].body.text, /Telegram|Contact ID|@amyf|5476500286/);
  assert.equal(inquiryPlayer.at(-1).text, INQUIRY_REQUEST_SENT_TEXT);
  console.log('ok custom inquiry notifies with AppBeg username and question only');

  const freeStore = createMemoryStore();
  const freePlayer = [];
  const freeBot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        freePlayer.push({ chatId, text, options });
        return { message_id: freePlayer.length, reply_markup: options.reply_markup || null };
      }
    }
  };
  supportCalls.length = 0;
  await processBotJob(freeStore, {
    id: 30,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 9101,
    incoming_telegram_message_id: 301,
    created_at: new Date().toISOString()
  }, { bot: freeBot });
  assert.equal(supportCalls.length, 1);
  assert.equal(supportCalls[0].body.text, '🎁 FreePlay Request\nAppBeg Username: Amyfi02');
  assert.equal(freePlayer.at(-1).text, FREEPLAY_REQUEST_SENT_TEXT);

  await processBotJob(freeStore, {
    id: 31,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 9102,
    incoming_telegram_message_id: 301,
    created_at: new Date().toISOString()
  }, { bot: freeBot });
  assert.equal(supportCalls.length, 1);
  assert.equal(freePlayer.at(-1).text, FREEPLAY_INELIGIBLE_TEXT);
  console.log('ok FreePlay notifies username-only and enforces cooldown after successful send');

  const missingStore = createMemoryStore({ registrationInfo: {} });
  supportCalls.length = 0;
  const missingPlayer = [];
  await processBotJob(missingStore, {
    id: 40,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 9201,
    incoming_telegram_message_id: 401,
    created_at: new Date().toISOString()
  }, {
    bot: {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          missingPlayer.push({ chatId, text, options });
          return { message_id: missingPlayer.length, reply_markup: options.reply_markup || null };
        }
      }
    }
  });
  assert.equal(supportCalls.length, 0);
  assert.equal(missingPlayer.at(-1).text, SUPPORT_ACCOUNT_NOT_FOUND_TEXT);
  console.log('ok missing AppBeg username blocks notification');

  const failStore = createMemoryStore();
  globalThis.fetch = mockSupportFetch(supportCalls, { fail: true });
  supportCalls.length = 0;
  const failPlayer = [];
  const failed = await processBotJob(failStore, {
    id: 50,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 9301,
    incoming_telegram_message_id: 501,
    created_at: new Date().toISOString()
  }, {
    bot: {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          failPlayer.push({ chatId, text, options });
          return { message_id: failPlayer.length, reply_markup: options.reply_markup || null };
        }
      }
    }
  });
  assert.equal(failed.ok, false);
  assert.equal(failPlayer.at(-1).text, SUPPORT_DELIVERY_FAILED_TEXT);
  assert.equal(failStore.completed.at(-1).payload.status, 'failed');
  // Eligibility must remain unused so a later successful send can still work.
  globalThis.fetch = mockSupportFetch(supportCalls, { fail: false });
  supportCalls.length = 0;
  await processBotJob(failStore, {
    id: 51,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 9302,
    incoming_telegram_message_id: 502,
    created_at: new Date().toISOString()
  }, {
    bot: {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          failPlayer.push({ chatId, text, options });
          return { message_id: failPlayer.length, reply_markup: options.reply_markup || null };
        }
      }
    }
  });
  assert.equal(supportCalls.length, 1);
  console.log('ok delivery failure replies with retry text and does not consume FreePlay eligibility');

  delete process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  delete process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  const cfgStore = createMemoryStore();
  const cfgPlayer = [];
  const cfgResult = await processBotJob(cfgStore, {
    id: 60,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: `${SUPPORT_TOPIC_PREFIX}password_help`,
    update_id: 9401,
    incoming_telegram_message_id: 601,
    created_at: new Date().toISOString()
  }, {
    bot: {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          cfgPlayer.push({ chatId, text, options });
          return { message_id: cfgPlayer.length, reply_markup: options.reply_markup || null };
        }
      }
    }
  });
  assert.equal(cfgResult.ok, false);
  assert.equal(cfgPlayer.at(-1).text, SUPPORT_DELIVERY_FAILED_TEXT);
  console.log('ok missing support bot config fails visibly');

  const { store: dbStore, dir } = await (async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'support-notify-'));
    const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dirPath, 'test.sqlite') });
    return { store, dir: dirPath };
  })();
  try {
    process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = 'test-support-token';
    process.env.SUPPORT_NOTIFICATION_CHAT_ID = '424242';
    globalThis.fetch = mockSupportFetch(supportCalls);
    supportCalls.length = 0;
    const saved = await dbStore.upsertTelegramUser({
      id: 5476500286,
      first_name: 'Amy',
      last_name: 'F.',
      username: 'amyf',
      is_bot: false
    });
    await dbStore.updateRegistrationStatus(saved.id, 'Registered', 'Test');
    await dbStore.updateAutomationState(saved.id, { registrationInfo: baseInfo() });
    await dbStore.db.prepare(`
      UPDATE telegram_users
      SET appbeg_account_id = ?, display_name = ?, active_messaging_source = 'bot_api'
      WHERE id = ?
    `).run('o6XdSdLND0g8odmeoYaMXyG5uRn2', 'Amy F.', saved.id);
    dbStore.isIncomingMessageEligibleForAutoBot = async () => ({ eligible: true });
    dbStore.getAutoRegistrationBotSettings = async () => ({ enabled: true });

    const raceBot = {
      telegram: {
        async sendMessage() { return { message_id: 1, reply_markup: null }; }
      }
    };
    await Promise.all([
      processBotJob(dbStore, {
        id: 71,
        contact_id: saved.id,
        telegram_user_id: saved.telegram_id,
        job_type: 'callback_action',
        action: `${SUPPORT_TOPIC_PREFIX}password_help`,
        update_id: 9501,
        incoming_telegram_message_id: 701,
        created_at: new Date().toISOString()
      }, { bot: raceBot }),
      processBotJob(dbStore, {
        id: 72,
        contact_id: saved.id,
        telegram_user_id: saved.telegram_id,
        job_type: 'callback_action',
        action: `${SUPPORT_TOPIC_PREFIX}password_help`,
        update_id: 9502,
        incoming_telegram_message_id: 701,
        created_at: new Date().toISOString()
      }, { bot: raceBot })
    ]);
    assert.equal(supportCalls.length, 1);
    console.log('ok rapid repeated taps create only one support notification');

    supportCalls.length = 0;
    const first = await dbStore.createBotJob({
      contactId: saved.id,
      telegramUserId: saved.telegram_id,
      updateId: 9601,
      incomingTelegramMessageId: 801,
      jobType: 'callback_action',
      action: `${SUPPORT_TOPIC_PREFIX}deposit_help`
    });
    const second = await dbStore.createBotJob({
      contactId: saved.id,
      telegramUserId: saved.telegram_id,
      updateId: 9601,
      incomingTelegramMessageId: 801,
      jobType: 'callback_action',
      action: `${SUPPORT_TOPIC_PREFIX}deposit_help`
    });
    assert.equal(Boolean(second.duplicate), true);
    assert.equal(first.id, second.id);
    await processBotJob(dbStore, {
      id: first.id,
      contact_id: saved.id,
      telegram_user_id: saved.telegram_id,
      job_type: 'callback_action',
      action: `${SUPPORT_TOPIC_PREFIX}deposit_help`,
      update_id: 9601,
      incoming_telegram_message_id: 801,
      created_at: new Date().toISOString()
    }, { bot: raceBot });
    assert.equal(supportCalls.length, 1);
    console.log('ok duplicate update_id creates only one support notification');
  } finally {
    await dbStore.close?.().catch(() => null);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
  }

  globalThis.fetch = previousFetch;
  if (previousToken == null) delete process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  else process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = previousToken;
  if (previousChat == null) delete process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  else process.env.SUPPORT_NOTIFICATION_CHAT_ID = previousChat;
  console.log('All Contact Support notification checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
