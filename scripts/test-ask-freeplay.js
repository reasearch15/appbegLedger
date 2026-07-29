import assert from 'node:assert/strict';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { processBotJob } from '../src/telegram/chatbotProcessor.js';
import {
  ASK_FREEPLAY_ACTION,
  FREEPLAY_COOLDOWN_MS,
  FREEPLAY_INELIGIBLE_TEXT,
  FREEPLAY_REQUEST_SENT_TEXT
} from '../src/telegram/freePlayRequest.js';
import { HELP_TOPIC_PREFIX } from '../src/telegram/royalVipHelpCenter.js';
import { SUPPORT_ACCOUNT_NOT_FOUND_TEXT } from '../src/telegram/supportNotificationBot.js';

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

function createStore({ registrationInfo = {} } = {}) {
  let state = {
    current_flow: null,
    current_step: null,
    registration_info: { ...registrationInfo }
  };
  let freeplayRequestedAt = null;
  let freeplayInflightAt = null;
  return {
    async getUserProfile() { return contact(); },
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() { return this.ensureAutomationState(); },
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
    async completeBotJob() {},
    async logAutomationDecision() {},
    async tryAcquireFreePlaySendLock(_id, { cooldownMs = FREEPLAY_COOLDOWN_MS } = {}) {
      const now = Date.now();
      if (freeplayRequestedAt && now - Date.parse(freeplayRequestedAt) < cooldownMs) {
        return { ok: false, reason: 'cooldown_active' };
      }
      if (freeplayInflightAt && now - Date.parse(freeplayInflightAt) < 120000) {
        return { ok: false, reason: 'inflight' };
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
    async tryAcquireSupportNotifyLock() { return { ok: true, inflightAt: new Date().toISOString() }; },
    async commitSupportNotifyLock() { return { ok: true }; },
    async releaseSupportNotifyLock() { return { ok: true }; }
  };
}

async function run() {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  const previousChat = process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = 'token';
  process.env.SUPPORT_NOTIFICATION_CHAT_ID = '99';
  const calls = [];
  globalThis.fetch = async (_url, options = {}) => {
    calls.push(JSON.parse(options.body || '{}'));
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: calls.length } }; } };
  };

  const topic = await decideBotReply({
    store: createStore(),
    contact: contact(),
    action: `${HELP_TOPIC_PREFIX}free_play`
  });
  assert.ok(topic.replies[0].buttons.flat().some((button) => button.data === ASK_FREEPLAY_ACTION));

  const store = createStore({
    registrationInfo: {
      royal_vip_credentials: {
        username: 'Amyfi02',
        password: 'Secret',
        player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
        telegram_user_id: 5476500286
      }
    }
  });
  const player = [];
  const bot = {
    telegram: {
      async sendMessage(_chatId, text, options = {}) {
        player.push(text);
        return { message_id: player.length, reply_markup: options.reply_markup || null };
      }
    }
  };

  await processBotJob(store, {
    id: 1,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 1,
    incoming_telegram_message_id: 1,
    created_at: new Date().toISOString()
  }, { bot });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '🎁 FreePlay Request\nAppBeg Username: Amyfi02');
  assert.equal(player.at(-1), FREEPLAY_REQUEST_SENT_TEXT);

  await processBotJob(store, {
    id: 2,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 2,
    incoming_telegram_message_id: 1,
    created_at: new Date().toISOString()
  }, { bot });
  assert.equal(calls.length, 1);
  assert.equal(player.at(-1), FREEPLAY_INELIGIBLE_TEXT);

  const missing = createStore({ registrationInfo: {} });
  await processBotJob(missing, {
    id: 3,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    update_id: 3,
    incoming_telegram_message_id: 2,
    created_at: new Date().toISOString()
  }, { bot });
  assert.equal(player.at(-1), SUPPORT_ACCOUNT_NOT_FOUND_TEXT);

  globalThis.fetch = previousFetch;
  if (previousToken == null) delete process.env.SUPPORT_NOTIFICATION_BOT_TOKEN;
  else process.env.SUPPORT_NOTIFICATION_BOT_TOKEN = previousToken;
  if (previousChat == null) delete process.env.SUPPORT_NOTIFICATION_CHAT_ID;
  else process.env.SUPPORT_NOTIFICATION_CHAT_ID = previousChat;
  console.log('All Ask FreePlay focused checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
