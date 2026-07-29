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
  FREEPLAY_REQUEST_SENT_TEXT,
  buildFreePlayOwnerNotificationText
} from '../src/telegram/freePlayRequest.js';
import { HELP_TOPIC_PREFIX } from '../src/telegram/royalVipHelpCenter.js';

function contact(overrides = {}) {
  return {
    id: 34,
    telegram_id: 5476500286,
    display_name: 'Amy F.',
    username: 'amyf',
    first_name: 'Amy',
    last_name: 'F.',
    registration_status: 'Registered',
    appbeg_account_id: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
    appbeg_link_status: 'linked',
    active_messaging_source: 'bot_api',
    ...overrides
  };
}

function createMemoryStore({
  registrationInfo = {},
  claimImpl = null,
  ownerTelegramId = '999001'
} = {}) {
  let state = {
    current_flow: null,
    current_step: null,
    registration_info: { ...registrationInfo }
  };
  const claims = [];
  const releases = [];
  let lastClaimAt = null;
  return {
    claims,
    releases,
    async getUserProfile(id) {
      assert.equal(id, contact().id);
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
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async isIncomingMessageEligibleForAutoBot() {
      return { eligible: true };
    },
    async getAutoRegistrationBotSettings() {
      return { enabled: true };
    },
    async getCoadminSettings() {
      return { telegram_account_id: ownerTelegramId };
    },
    async tryClaimFreePlayRequest(contactId, options = {}) {
      claims.push({ contactId, options });
      if (typeof claimImpl === 'function') {
        return claimImpl({ contactId, options, lastClaimAt, setLastClaimAt: (value) => { lastClaimAt = value; } });
      }
      if (lastClaimAt) {
        const age = Date.now() - Date.parse(lastClaimAt);
        if (age < (options.cooldownMs || FREEPLAY_COOLDOWN_MS)) {
          return { ok: false, reason: 'cooldown_active', requestedAt: lastClaimAt };
        }
      }
      lastClaimAt = new Date().toISOString();
      return { ok: true, reason: 'claimed', requestedAt: lastClaimAt };
    },
    async releaseFreePlayRequestClaim(contactId, claimedAt) {
      releases.push({ contactId, claimedAt });
      if (lastClaimAt === claimedAt) lastClaimAt = null;
      return { ok: true, reason: 'released' };
    },
    async completeBotJob() {},
    async logAutomationDecision() {},
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage(message) {
      return { id: 1, ...message };
    }
  };
}

async function createTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-freeplay-'));
  const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 'test.sqlite') });
  return { store, dir };
}

async function run() {
  const previousOwner = process.env.TELEGRAM_BOT_OWNER_ID;
  process.env.TELEGRAM_BOT_OWNER_ID = '999001';

  const freePlayTopic = await decideBotReply({
    store: createMemoryStore({
      registrationInfo: {
        royal_vip_credentials: {
          username: 'Amyfi02',
          password: 'Secret123',
          player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2'
        }
      }
    }),
    contact: contact(),
    action: `${HELP_TOPIC_PREFIX}free_play`
  });
  assert.match(freePlayTopic.replies[0].text, /FreePlay Gift Box/);
  assert.ok(freePlayTopic.replies[0].buttons.flat().some((button) => button.data === ASK_FREEPLAY_ACTION));
  assert.equal(
    freePlayTopic.replies[0].buttons.flat().find((button) => button.data === ASK_FREEPLAY_ACTION)?.text,
    '🎁 Ask FreePlay'
  );
  console.log('ok Free Play help screen includes Ask FreePlay button without changing topic text');

  const ownerMessages = [];
  const playerMessages = [];
  const bot = {
    telegram: {
      async sendMessage(chatId, text, options = {}) {
        if (String(chatId) === '999001') {
          ownerMessages.push({ chatId, text, options });
          return { message_id: 7001 + ownerMessages.length };
        }
        playerMessages.push({ chatId, text, options });
        return { message_id: 8001 + playerMessages.length, reply_markup: options.reply_markup || null };
      }
    }
  };

  const store = createMemoryStore({
    registrationInfo: {
      royal_vip_credentials: {
        username: 'Amyfi02',
        password: 'Secret123',
        player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
        telegram_user_id: 5476500286
      }
    }
  });

  await processBotJob(store, {
    id: 1,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    input_text: '',
    incoming_telegram_message_id: 400,
    update_id: 5001
  }, { bot });

  assert.equal(ownerMessages.length, 1);
  assert.equal(playerMessages.length, 1);
  assert.equal(playerMessages[0].text, FREEPLAY_REQUEST_SENT_TEXT);
  assert.match(ownerMessages[0].text, /^🎁 New FreePlay Request/);
  assert.match(ownerMessages[0].text, /RoyalVIP Username: Amyfi02/);
  assert.match(ownerMessages[0].text, /Telegram Name: Amy F\./);
  assert.match(ownerMessages[0].text, /Telegram Username: @amyf/);
  assert.match(ownerMessages[0].text, /Telegram ID: 5476500286/);
  assert.match(ownerMessages[0].text, /Contact ID: 34/);
  assert.match(ownerMessages[0].text, /Player UID: o6XdSdLND0g8odmeoYaMXyG5uRn2/);
  assert.match(ownerMessages[0].text, /Requested at:/);
  assert.doesNotMatch(JSON.stringify(ownerMessages[0].options || {}), /Secret123/);
  console.log('ok first FreePlay request notifies owner once and confirms to player');

  await processBotJob(store, {
    id: 2,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    input_text: '',
    incoming_telegram_message_id: 400,
    update_id: 5002
  }, { bot });
  assert.equal(ownerMessages.length, 1);
  assert.equal(playerMessages.at(-1).text, FREEPLAY_INELIGIBLE_TEXT);
  assert.doesNotMatch(playerMessages.at(-1).text, /12|hour|cooldown|remaining/i);
  console.log('ok second request within 12 hours is ineligible with no owner notify');

  // Simulate cooldown expiry for memory store by forcing claim clock back.
  store.claims.length = 0;
  const expiredStore = createMemoryStore({
    registrationInfo: {
      royal_vip_credentials: { username: 'Amyfi02', password: 'Secret123', player_uid: 'uid1' }
    },
    claimImpl: (() => {
      let last = null;
      return ({ options, setLastClaimAt }) => {
        const now = Date.now();
        if (last && (now - last) < (options.cooldownMs || FREEPLAY_COOLDOWN_MS)) {
          return { ok: false, reason: 'cooldown_active', requestedAt: new Date(last).toISOString() };
        }
        // First call pretends previous request was >12h ago by allowing claim.
        last = now;
        setLastClaimAt(new Date(last).toISOString());
        return { ok: true, reason: 'claimed', requestedAt: new Date(last).toISOString() };
      };
    })()
  });
  await processBotJob(expiredStore, {
    id: 3,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    input_text: '',
    incoming_telegram_message_id: 401,
    update_id: 5003
  }, { bot });
  assert.equal(ownerMessages.length, 2);
  assert.equal(playerMessages.at(-1).text, FREEPLAY_REQUEST_SENT_TEXT);
  console.log('ok request after cooldown window notifies owner again');

  const raceOwner = [];
  const raceBot = {
    telegram: {
      async sendMessage(chatId, text) {
        if (String(chatId) === '999001') {
          raceOwner.push(text);
          return { message_id: 9000 + raceOwner.length };
        }
        return { message_id: 9100, reply_markup: null };
      }
    }
  };
  const { store: dbStore, dir } = await createTempStore();
  try {
    const saved = await dbStore.upsertTelegramUser({
      id: 5476500286,
      first_name: 'Amy',
      last_name: 'F.',
      username: 'amyf',
      is_bot: false
    });
    await dbStore.updateRegistrationStatus(saved.id, 'Registered', 'Test');
    await dbStore.updateAutomationState(saved.id, {
      registrationInfo: {
        royal_vip_credentials: {
          username: 'Amyfi02',
          password: 'Secret123',
          player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2',
          telegram_user_id: 5476500286
        },
        appbeg_player_uid: 'o6XdSdLND0g8odmeoYaMXyG5uRn2'
      }
    });
    await dbStore.db.prepare(`
      UPDATE telegram_users
      SET appbeg_account_id = ?, display_name = ?, active_messaging_source = 'bot_api'
      WHERE id = ?
    `).run('o6XdSdLND0g8odmeoYaMXyG5uRn2', 'Amy F.', saved.id);
    dbStore.isIncomingMessageEligibleForAutoBot = async () => ({ eligible: true });
    dbStore.getAutoRegistrationBotSettings = async () => ({ enabled: true });
    dbStore.getCoadminSettings = async () => ({ telegram_account_id: '999001' });

    const [claimA, claimB] = await Promise.all([
      dbStore.tryClaimFreePlayRequest(saved.id),
      dbStore.tryClaimFreePlayRequest(saved.id)
    ]);
    assert.equal([claimA, claimB].filter((claim) => claim.ok).length, 1);
    console.log('ok atomic FreePlay claim allows only one winner under concurrent taps');

    await dbStore.db.prepare('UPDATE telegram_users SET freeplay_requested_at = NULL WHERE id = ?').run(saved.id);
    await Promise.all([
      processBotJob(dbStore, {
        id: 11,
        contact_id: saved.id,
        telegram_user_id: saved.telegram_id,
        job_type: 'callback_action',
        action: ASK_FREEPLAY_ACTION,
        input_text: '',
        incoming_telegram_message_id: 501,
        update_id: 6001,
        created_at: new Date().toISOString()
      }, { bot: raceBot }),
      processBotJob(dbStore, {
        id: 12,
        contact_id: saved.id,
        telegram_user_id: saved.telegram_id,
        job_type: 'callback_action',
        action: ASK_FREEPLAY_ACTION,
        input_text: '',
        incoming_telegram_message_id: 501,
        update_id: 6002,
        created_at: new Date().toISOString()
      }, { bot: raceBot })
    ]);
    assert.equal(raceOwner.length, 1);
    const row = await dbStore.db.prepare('SELECT freeplay_requested_at FROM telegram_users WHERE id = ?').get(saved.id);
    assert.ok(row.freeplay_requested_at);
    console.log('ok rapid double tap creates only one owner notification with durable timestamp');

    const oldStamp = new Date(Date.now() - FREEPLAY_COOLDOWN_MS - 1000).toISOString();
    await dbStore.db.prepare('UPDATE telegram_users SET freeplay_requested_at = ? WHERE id = ?').run(oldStamp, saved.id);
    await processBotJob(dbStore, {
      id: 13,
      contact_id: saved.id,
      telegram_user_id: saved.telegram_id,
      job_type: 'callback_action',
      action: ASK_FREEPLAY_ACTION,
      input_text: '',
      incoming_telegram_message_id: 502,
      update_id: 6003,
      created_at: new Date().toISOString()
    }, { bot: raceBot });
    assert.equal(raceOwner.length, 2);
    console.log('ok durable store allows a new FreePlay request after 12 hours');
  } finally {
    try {
      await dbStore.close?.();
    } catch {
      // ignore Windows sqlite temp unlock races
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
  }

  const missingOwner = [];
  const missingBot = {
    telegram: {
      async sendMessage(chatId, text) {
        if (String(chatId) === '999001') {
          missingOwner.push(text);
          return { message_id: 9501 };
        }
        return { message_id: 9502, reply_markup: null };
      }
    }
  };
  const missingStore = createMemoryStore({ registrationInfo: {} });
  await processBotJob(missingStore, {
    id: 20,
    contact_id: 34,
    telegram_user_id: 5476500286,
    job_type: 'callback_action',
    action: ASK_FREEPLAY_ACTION,
    input_text: '',
    incoming_telegram_message_id: 503,
    update_id: 7001
  }, { bot: missingBot });
  assert.equal(missingOwner.length, 1);
  assert.match(missingOwner[0], /RoyalVIP Username: Unknown/);
  console.log('ok missing RoyalVIP username still notifies owner with Unknown');

  const preview = buildFreePlayOwnerNotificationText({
    contact: contact({ username: null }),
    info: {},
    requestedAt: '2026-07-29T07:30:00.000Z'
  });
  assert.match(preview, /Telegram Username: n\/a/);
  assert.match(preview, /Requested at:\n2026-07-29 07:30 UTC/);

  if (previousOwner == null) delete process.env.TELEGRAM_BOT_OWNER_ID;
  else process.env.TELEGRAM_BOT_OWNER_ID = previousOwner;
  console.log('All Ask FreePlay checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
