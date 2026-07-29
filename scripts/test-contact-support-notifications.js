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
  INQUIRY_REQUEST_SENT_TEXT,
  SUPPORT_SUBSCRIBED_TEXT,
  SUPPORT_UNSUBSCRIBED_TEXT,
  sendSupportBotNotification,
  isPermanentSupportDeliveryError
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

function createMemoryStore({
  registrationInfo = baseInfo(),
  subscribers = [{ telegram_chat_id: '1001', is_active: true }]
} = {}) {
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
  let nextSubscriberId = 1;
  const subscriberRows = subscribers.map((row) => ({
    id: nextSubscriberId++,
    telegram_chat_id: String(row.telegram_chat_id),
    telegram_user_id: row.telegram_user_id == null ? null : String(row.telegram_user_id),
    is_active: row.is_active !== false,
    subscribed_at: row.subscribed_at || new Date().toISOString(),
    last_delivery_at: null,
    last_delivery_status: null,
    last_error: null
  }));
  const completed = [];
  return {
    completed,
    subscribers: subscriberRows,
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
    async upsertSupportNotificationSubscriber({ telegramChatId, telegramUserId = null } = {}) {
      const chatId = String(telegramChatId);
      const existing = subscriberRows.find((row) => row.telegram_chat_id === chatId);
      if (existing) {
        const wasActive = existing.is_active;
        existing.is_active = true;
        existing.telegram_user_id = telegramUserId == null ? existing.telegram_user_id : String(telegramUserId);
        existing.last_error = null;
        if (!wasActive) existing.subscribed_at = new Date().toISOString();
        return { ok: true, created: false, reactivated: !wasActive, telegramChatId: chatId };
      }
      subscriberRows.push({
        id: nextSubscriberId++,
        telegram_chat_id: chatId,
        telegram_user_id: telegramUserId == null ? null : String(telegramUserId),
        is_active: true,
        subscribed_at: new Date().toISOString(),
        last_delivery_at: null,
        last_delivery_status: null,
        last_error: null
      });
      return { ok: true, created: true, reactivated: false, telegramChatId: chatId };
    },
    async deactivateSupportNotificationSubscriber(telegramChatId, { reason = null } = {}) {
      const row = subscriberRows.find((item) => item.telegram_chat_id === String(telegramChatId));
      if (!row) return { ok: false, reason: 'not_found' };
      row.is_active = false;
      row.last_error = reason || row.last_error;
      return { ok: true, reason: 'disabled' };
    },
    async listActiveSupportNotificationSubscribers() {
      return subscriberRows.filter((row) => row.is_active).map((row) => ({ ...row }));
    },
    async markSupportNotificationDelivery(telegramChatId, { status = 'sent', error = null, deactivate = false } = {}) {
      const row = subscriberRows.find((item) => item.telegram_chat_id === String(telegramChatId));
      if (!row) return { ok: false };
      row.last_delivery_at = new Date().toISOString();
      row.last_delivery_status = status;
      row.last_error = error;
      if (deactivate) row.is_active = false;
      return { ok: true };
    },
    _state() { return state; }
  };
}

function mockSupportFetch(calls, { failChatIds = new Set(), failAll = false, permanentFailChatIds = new Set() } = {}) {
  return async (url, options = {}) => {
    assert.match(String(url), /api\.telegram\.org\/bot/);
    const body = JSON.parse(options.body || '{}');
    calls.push({ url: String(url).replace(/bot[^/]+/, 'bot<redacted>'), body });
    const chatId = String(body.chat_id);
    if (failAll || failChatIds.has(chatId) || permanentFailChatIds.has(chatId)) {
      const permanent = permanentFailChatIds.has(chatId);
      return {
        ok: false,
        status: permanent ? 403 : 500,
        async json() {
          return permanent
            ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
            : { ok: false, error_code: 500, description: 'boom' };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: { message_id: 1000 + calls.length } }; }
    };
  };
}

function playerBot() {
  const player = [];
  return {
    player,
    bot: {
      telegram: {
        async sendMessage(chatId, text, options = {}) {
          player.push({ chatId, text, options });
          return { message_id: player.length, reply_markup: options.reply_markup || null };
        }
      }
    }
  };
}

async function run() {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  const previousChat = process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = 'test-support-token';
  delete process.env.SUPPORT_NOTIFICATION_CHAT_ID;

  assert.equal(isPermanentSupportDeliveryError(403, 'Forbidden: bot was blocked by the user'), true);
  assert.equal(isPermanentSupportDeliveryError(500, 'boom'), false);

  // 1 + 2: first /start registers; existing subscriber reactivates
  {
    const store = createMemoryStore({ subscribers: [] });
    const first = await store.upsertSupportNotificationSubscriber({
      telegramChatId: 777,
      telegramUserId: 777
    });
    assert.equal(first.created, true);
    assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 1);
    await store.deactivateSupportNotificationSubscriber('777', { reason: 'user_stop' });
    assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 0);
    const again = await store.upsertSupportNotificationSubscriber({
      telegramChatId: '777',
      telegramUserId: 777
    });
    assert.equal(again.reactivated, true);
    assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 1);
    assert.equal(SUPPORT_SUBSCRIBED_TEXT.includes('subscribed'), true);
    console.log('ok first /start registers and existing subscriber reactivates');
  }

  // 3: /stop disables notifications
  {
    const store = createMemoryStore();
    await store.deactivateSupportNotificationSubscriber('1001', { reason: 'user_stop' });
    assert.equal((await store.listActiveSupportNotificationSubscribers()).length, 0);
    assert.equal(SUPPORT_UNSUBSCRIBED_TEXT, 'Notifications disabled.');
    console.log('ok /stop disables notifications');
  }

  const supportCalls = [];
  globalThis.fetch = mockSupportFetch(supportCalls);

  // 4: one subscriber receives notifications
  {
    const store = createMemoryStore();
    supportCalls.length = 0;
    const result = await sendSupportBotNotification({
      store,
      kind: 'support',
      text: '🆘 Support Request\nAppBeg Username: Amyfi02\nTopic: Password / Login Help'
    });
    assert.equal(result.successCount, 1);
    assert.equal(supportCalls.length, 1);
    assert.equal(supportCalls[0].body.chat_id, '1001');
    console.log('ok one subscriber receives notifications');
  }

  // 5: multiple subscribers all receive notifications
  {
    const store = createMemoryStore({
      subscribers: [
        { telegram_chat_id: '1001', is_active: true },
        { telegram_chat_id: '1002', is_active: true }
      ]
    });
    supportCalls.length = 0;
    const result = await sendSupportBotNotification({
      store,
      kind: 'freeplay',
      text: '🎁 FreePlay Request\nAppBeg Username: Amyfi02'
    });
    assert.equal(result.successCount, 2);
    assert.equal(supportCalls.length, 2);
    assert.deepEqual(supportCalls.map((item) => String(item.body.chat_id)).sort(), ['1001', '1002']);
    console.log('ok multiple subscribers all receive notifications');
  }

  // 6: one subscriber fails while others still receive
  {
    const store = createMemoryStore({
      subscribers: [
        { telegram_chat_id: '1001', is_active: true },
        { telegram_chat_id: '1002', is_active: true }
      ]
    });
    supportCalls.length = 0;
    globalThis.fetch = mockSupportFetch(supportCalls, { failChatIds: new Set(['1001']) });
    const result = await sendSupportBotNotification({
      store,
      kind: 'inquiry',
      text: '❓ New Inquiry\nAppBeg Username: Amyfi02\nQuestion:\nHello'
    });
    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 1);
    assert.equal(store.subscribers.find((row) => row.telegram_chat_id === '1001').is_active, true);
    console.log('ok one subscriber fails while others still receive notifications');
  }

  // 11: automatic deactivation when bot is blocked
  {
    const store = createMemoryStore({
      subscribers: [
        { telegram_chat_id: '1001', is_active: true },
        { telegram_chat_id: '1002', is_active: true }
      ]
    });
    supportCalls.length = 0;
    globalThis.fetch = mockSupportFetch(supportCalls, { permanentFailChatIds: new Set(['1001']) });
    const result = await sendSupportBotNotification({
      store,
      kind: 'support',
      text: '🆘 Support Request\nAppBeg Username: Amyfi02\nTopic: Cashout Help'
    });
    assert.equal(result.successCount, 1);
    assert.equal(store.subscribers.find((row) => row.telegram_chat_id === '1001').is_active, false);
    assert.equal(store.subscribers.find((row) => row.telegram_chat_id === '1002').is_active, true);
    console.log('ok automatic deactivation when the bot is blocked');
  }

  // 7: all subscribers fail
  {
    const store = createMemoryStore({
      subscribers: [
        { telegram_chat_id: '1001', is_active: true },
        { telegram_chat_id: '1002', is_active: true }
      ]
    });
    supportCalls.length = 0;
    globalThis.fetch = mockSupportFetch(supportCalls, { failAll: true });
    await assert.rejects(
      () => sendSupportBotNotification({
        store,
        kind: 'support',
        text: '🆘 Support Request\nAppBeg Username: Amyfi02\nTopic: Deposit / Payment Help'
      }),
      (error) => error.code === 'SUPPORT_NOTIFICATION_ALL_FAILED'
    );
    console.log('ok all subscribers fail');
  }

  // 8: no subscribers registered
  {
    const store = createMemoryStore({ subscribers: [] });
    await assert.rejects(
      () => sendSupportBotNotification({
        store,
        kind: 'support',
        text: '🆘 Support Request\nAppBeg Username: Amyfi02\nTopic: Password / Login Help'
      }),
      (error) => error.code === 'SUPPORT_NOTIFICATION_NO_SUBSCRIBERS'
    );
    console.log('ok no subscribers registered');
  }

  globalThis.fetch = mockSupportFetch(supportCalls);

  // 14: informational FAQ remains local
  {
    const infoDecision = await decideBotReply({
      store: createMemoryStore(),
      contact: contact(),
      action: `${SUPPORT_TOPIC_PREFIX}how_deposit`
    });
    assert.match(infoDecision.replies[0].text, /How to deposit/i);
    assert.equal(infoDecision.supportOwnerNotify, undefined);
    console.log('ok informational FAQ answers remain local and do not broadcast');
  }

  // 13: human-help FAQ notifications
  for (const option of CONTACT_SUPPORT_OPTIONS.filter((item) => item.notify)) {
    const store = createMemoryStore();
    const { player, bot } = playerBot();
    supportCalls.length = 0;
    await processBotJob(store, {
      id: 10,
      contact_id: 34,
      telegram_user_id: 5476500286,
      job_type: 'callback_action',
      action: `${SUPPORT_TOPIC_PREFIX}${option.key}`,
      update_id: 8000 + Math.floor(Math.random() * 100000),
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
  console.log('ok human-help FAQ notifications broadcast to subscribers');

  // 12: inquiry notifications
  {
    const inquiryStore = createMemoryStore();
    const prompt = await decideBotReply({
      store: inquiryStore,
      contact: contact(),
      action: SUPPORT_CUSTOM_INQUIRY_ACTION
    });
    await inquiryStore.updateAutomationState(34, prompt.statePatch);
    const { player, bot } = playerBot();
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
    }, { bot });
    assert.equal(supportCalls.length, 1);
    assert.match(supportCalls[0].body.text, /^❓ New Inquiry/);
    assert.match(supportCalls[0].body.text, /AppBeg Username: Amyfi02/);
    assert.match(supportCalls[0].body.text, /Question:\nMy deposit of \$5 did not credit <script>/);
    assert.equal(player.at(-1).text, INQUIRY_REQUEST_SENT_TEXT);
    console.log('ok inquiry notifications');
  }

  // 10: rapid repeated FreePlay requests
  {
    const freeStore = createMemoryStore();
    const { player, bot } = playerBot();
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
    }, { bot });
    assert.equal(supportCalls.length, 1);
    assert.equal(supportCalls[0].body.text, '🎁 FreePlay Request\nAppBeg Username: Amyfi02');
    assert.equal(player.at(-1).text, FREEPLAY_REQUEST_SENT_TEXT);

    await processBotJob(freeStore, {
      id: 31,
      contact_id: 34,
      telegram_user_id: 5476500286,
      job_type: 'callback_action',
      action: ASK_FREEPLAY_ACTION,
      update_id: 9102,
      incoming_telegram_message_id: 301,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(supportCalls.length, 1);
    assert.equal(player.at(-1).text, FREEPLAY_INELIGIBLE_TEXT);
    console.log('ok rapid repeated FreePlay requests');
  }

  // delivery failure does not consume FreePlay
  {
    const failStore = createMemoryStore();
    globalThis.fetch = mockSupportFetch(supportCalls, { failAll: true });
    supportCalls.length = 0;
    const { player, bot } = playerBot();
    const failed = await processBotJob(failStore, {
      id: 50,
      contact_id: 34,
      telegram_user_id: 5476500286,
      job_type: 'callback_action',
      action: ASK_FREEPLAY_ACTION,
      update_id: 9301,
      incoming_telegram_message_id: 501,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(failed.ok, false);
    assert.equal(player.at(-1).text, SUPPORT_DELIVERY_FAILED_TEXT);
    globalThis.fetch = mockSupportFetch(supportCalls);
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
    }, { bot });
    assert.equal(supportCalls.length, 1);
    console.log('ok delivery failure does not consume FreePlay eligibility');
  }

  // missing username
  {
    const missingStore = createMemoryStore({ registrationInfo: {} });
    supportCalls.length = 0;
    const { player, bot } = playerBot();
    await processBotJob(missingStore, {
      id: 40,
      contact_id: 34,
      telegram_user_id: 5476500286,
      job_type: 'callback_action',
      action: ASK_FREEPLAY_ACTION,
      update_id: 9201,
      incoming_telegram_message_id: 401,
      created_at: new Date().toISOString()
    }, { bot });
    assert.equal(supportCalls.length, 0);
    assert.equal(player.at(-1).text, SUPPORT_ACCOUNT_NOT_FOUND_TEXT);
    console.log('ok missing AppBeg username blocks notification');
  }

  // 9: duplicate Telegram updates + rapid taps against real sqlite store
  {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'support-notify-'));
    const dbStore = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dirPath, 'test.sqlite') });
    try {
      process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = 'test-support-token';
      globalThis.fetch = mockSupportFetch(supportCalls);
      supportCalls.length = 0;

      await dbStore.upsertSupportNotificationSubscriber({
        telegramChatId: '424242',
        telegramUserId: 424242
      });

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
      console.log('ok duplicate Telegram updates create only one support notification');
    } finally {
      await dbStore.close?.().catch(() => null);
      await fs.rm(dirPath, { recursive: true, force: true }).catch(() => null);
    }
  }

  globalThis.fetch = previousFetch;
  if (previousToken == null) delete process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  else process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = previousToken;
  if (previousChat == null) delete process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  else process.env.SUPPORT_NOTIFICATION_CHAT_ID = previousChat;
  console.log('All Contact Support subscriber notification checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
