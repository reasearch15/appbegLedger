import assert from 'node:assert/strict';
import { startPollingBot } from '../src/telegram/bot.js';
import { ROYAL_VIP_HUB_STOREFRONT_TEXT } from '../src/telegram/channelDeepLinks.js';

const HUB_CHANNEL_ID = '-1004300917295';

function telegramError(description) {
  const error = new Error(description);
  error.description = description;
  error.response = { description };
  return error;
}

function memoryStore() {
  let hub = {
    storefrontMessageId: null,
    syncedAt: null,
    lastError: null,
    pinned: false
  };
  return {
    async getHubStorefrontState() {
      return { ...hub };
    },
    async saveHubStorefrontState(next = {}) {
      hub = {
        storefrontMessageId: next.storefrontMessageId ?? null,
        syncedAt: next.syncedAt ?? null,
        lastError: next.lastError ?? null,
        pinned: Boolean(next.pinned)
      };
      return { ...hub };
    }
  };
}

function mockBot({
  sendBehavior = null,
  launchImpl = null
} = {}) {
  const calls = { launch: 0, stop: [], send: [], edit: [], pin: [], getMe: 0 };
  let launchResolve;
  let launchReject;
  const launchPromise = new Promise((resolve, reject) => {
    launchResolve = resolve;
    launchReject = reject;
  });
  const bot = {
    calls,
    botInfo: null,
    launchResolve,
    launchReject,
    launchPromise,
    telegram: {
      async getMe() {
        calls.getMe += 1;
        return { id: 8682428291, username: 'Royal_Sweeps_bot', is_bot: true };
      },
      async getWebhookInfo() {
        return { url: '' };
      },
      async deleteWebhook() {
        return true;
      },
      async sendMessage(chatId, text, extra = {}) {
        calls.send.push({ chatId: String(chatId), text, extra });
        if (typeof sendBehavior === 'function') {
          const thrown = sendBehavior({ chatId, text, extra });
          if (thrown) throw thrown;
        }
        return { message_id: 501 };
      },
      async editMessageText(chatId, messageId, _inlineId, text, extra = {}) {
        calls.edit.push({ chatId: String(chatId), messageId, text, extra });
        return true;
      },
      async pinChatMessage(chatId, messageId, extra = {}) {
        calls.pin.push({ chatId: String(chatId), messageId, extra });
        return true;
      }
    },
    launch() {
      calls.launch += 1;
      if (launchImpl) return launchImpl();
      return launchPromise;
    },
    stop(reason) {
      calls.stop.push(reason);
      launchResolve(reason);
    }
  };
  return bot;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (blocked by polling)`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const previous = {
    hub: process.env.ROYAL_VIP_HUB_CHANNEL_ID,
    group: process.env.STAFF_TELEGRAM_GROUP_ID,
    bot: process.env.TELEGRAM_BOT_USERNAME
  };
  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;
  delete process.env.STAFF_TELEGRAM_GROUP_ID;
  delete process.env.TELEGRAM_BOT_USERNAME;

  const store = memoryStore();
  const bot = mockBot();
  await withTimeout(startPollingBot(bot, store), 1500, 'startup with hanging launch');
  assert.equal(bot.calls.launch, 1);
  assert.equal(bot.calls.getMe >= 1, true);
  assert.equal(bot.calls.send.length, 1);
  assert.equal(bot.calls.send[0].chatId, HUB_CHANNEL_ID);
  assert.equal(bot.calls.send[0].text, ROYAL_VIP_HUB_STOREFRONT_TEXT);
  assert.equal(Number((await store.getHubStorefrontState()).storefrontMessageId), 501);
  console.log('ok 1-3: hub ensure runs once after init and is not blocked by Telegraf polling');

  bot.stop('SIGTERM');
  await bot.launchPromise;
  assert.deepEqual(bot.calls.stop, ['SIGTERM']);
  assert.equal(bot.calls.launch, 1);
  console.log('ok 7-8: shutdown still works; launch is called once');

  const second = mockBot();
  await withTimeout(startPollingBot(second, store), 1500, 'second startup');
  assert.equal(second.calls.launch, 1);
  assert.equal(second.calls.send.length, 0);
  assert.equal(second.calls.edit.length, 1);
  assert.equal(Number(second.calls.edit[0].messageId), 501);
  console.log('ok 9: restart edits stored storefront instead of duplicating');

  delete process.env.ROYAL_VIP_HUB_CHANNEL_ID;
  const missingStore = memoryStore();
  const missingBot = mockBot();
  await withTimeout(startPollingBot(missingBot, missingStore), 1500, 'missing hub config');
  assert.equal(missingBot.calls.launch, 1);
  assert.equal(missingBot.calls.send.length, 0);
  console.log('ok 5: missing Hub config does not stop bot polling');

  process.env.ROYAL_VIP_HUB_CHANNEL_ID = HUB_CHANNEL_ID;
  const deniedStore = memoryStore();
  const deniedBot = mockBot({
    sendBehavior: () => telegramError('Forbidden: bot is not a member of the channel chat')
  });
  await withTimeout(startPollingBot(deniedBot, deniedStore), 1500, 'permission denied');
  assert.equal(deniedBot.calls.launch, 1);
  const deniedState = await deniedStore.getHubStorefrontState();
  assert.match(String(deniedState.lastError || ''), /cannot post\/edit/i);
  console.log('ok 4/6: Hub permission error does not stop player bot polling');

  restore('ROYAL_VIP_HUB_CHANNEL_ID', previous.hub);
  restore('STAFF_TELEGRAM_GROUP_ID', previous.group);
  restore('TELEGRAM_BOT_USERNAME', previous.bot);
  console.log('All Royal VIP Hub startup tests passed.');
}

function restore(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
