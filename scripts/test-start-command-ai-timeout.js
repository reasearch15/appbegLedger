import assert from 'node:assert/strict';
import { enqueueChatbotJob, processBotJob } from '../src/telegram/chatbotProcessor.js';

function createProcessorStore(contact, { automationState = {}, aiMode = 'train' } = {}) {
  const calls = {
    outbound: [],
    completedJobs: [],
    staffReview: [],
    draftFailures: [],
    logs: [],
    nudge: []
  };
  let state = {
    current_flow: automationState.current_flow || null,
    current_step: automationState.current_step || null,
    registration_info: { ...(automationState.registration_info || {}) },
    last_auto_welcome_at: automationState.last_auto_welcome_at || null
  };
  const store = {
    calls,
    async getUserProfile() {
      return { ...contact };
    },
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async updateAutomationState(_contactId, patch = {}) {
      if (patch.currentFlow !== undefined) state.current_flow = patch.currentFlow;
      if (patch.currentStep !== undefined) state.current_step = patch.currentStep;
      if (patch.registrationInfo) {
        state.registration_info = { ...state.registration_info, ...patch.registrationInfo };
      }
      return this.ensureAutomationState();
    },
    async updateRegistrationInfo(_contactId, info = {}) {
      state.registration_info = { ...state.registration_info, ...info };
      return this.ensureAutomationState();
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async countIncomingMessages() {
      return 1;
    },
    async isIncomingMessageEligibleForAutoBot() {
      return { eligible: true, reason: 'eligible' };
    },
    async getAutoRegistrationBotSettings() {
      return { enabled: true, enabled_at: new Date(Date.now() - 1000).toISOString() };
    },
    async getCustomerSupportAiSettings() {
      return { mode: aiMode, configured: true };
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage({ text, payload, telegramMessageId, messageType }) {
      calls.outbound.push({ text, payload, telegramMessageId, messageType });
      return { inserted: true, messageId: calls.outbound.length };
    },
    async markAutoWelcomeSent() {
      state.last_auto_welcome_at = new Date().toISOString();
    },
    async logAutomationDecision(entry) {
      calls.logs.push(entry);
    },
    async completeBotJob(jobId, result) {
      calls.completedJobs.push({ jobId, ...result });
    },
    async markBotNeedsStaffReview(contactId, reason) {
      calls.staffReview.push({ contactId, reason });
      throw new Error('markBotNeedsStaffReview should not be called');
    },
    async createBotJob(params) {
      return {
        id: calls.nudge.length + 1,
        contact_id: params.contactId,
        telegram_user_id: params.telegramUserId,
        message_id: params.messageId || null,
        incoming_telegram_message_id: params.incomingTelegramMessageId || null,
        job_type: params.jobType || 'inbound_message',
        input_text: params.inputText || '',
        action: params.action || null,
        status: 'pending',
        created_at: new Date().toISOString()
      };
    },
    async nudgeBotQueue(jobId) {
      calls.nudge.push(jobId);
    }
  };
  return store;
}

function createFakeBot() {
  let nextId = 1000;
  return {
    telegram: {
      async sendMessage(_telegramId, _text, options = {}) {
        nextId += 1;
        return {
          message_id: nextId,
          reply_markup: options.reply_markup || undefined
        };
      }
    }
  };
}

function startJob(contact, text = '/start', telegramMessageId = 700) {
  return {
    id: telegramMessageId,
    contact_id: contact.id,
    telegram_user_id: contact.telegram_id,
    message_id: telegramMessageId + 10000,
    incoming_telegram_message_id: telegramMessageId,
    job_type: 'inbound_message',
    input_text: text,
    action: null,
    created_at: new Date().toISOString()
  };
}

const guest = {
  id: 11,
  telegram_id: 5011,
  display_name: 'Guest User',
  username: 'guestuser',
  registration_status: 'New',
  bot_enabled: true,
  bot_paused: false,
  needs_staff_review: false,
  telegram_sync_source: 'bot_api',
  active_messaging_source: 'bot_api'
};

async function assertStartSendsMenu(contact, expectedButtons, expectedTextPattern, expectedUrlButton = null) {
  const store = createProcessorStore(contact);
  let aiCalled = false;
  const result = await processBotJob(store, startJob(contact), {
    bot: createFakeBot(),
    supportAiGenerator: async () => {
      aiCalled = true;
      throw new Error('AI provider timed out.');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(aiCalled, false);
  assert.equal(store.calls.outbound.length, 1);
  assert.match(store.calls.outbound[0].text, expectedTextPattern);
  assert.deepEqual(
    store.calls.outbound[0].payload.buttons.flat().map((button) => button.text),
    expectedButtons
  );
  if (expectedUrlButton) {
    const button = store.calls.outbound[0].payload.buttons[expectedUrlButton.row][expectedUrlButton.column];
    assert.equal(button.text, expectedUrlButton.text);
    assert.equal(button.url, expectedUrlButton.url);
    assert.equal(button.data, undefined);
  }
  assert.equal(store.calls.staffReview.length, 0);
  assert.equal(store.calls.completedJobs.at(-1).status, 'completed');
}

await assertStartSendsMenu(guest, ['Register', 'Help', 'Contact'], /Welcome to Royal VIP/);
console.log('ok guest /start sends deterministic menu without AI');

const previousAppBegStore = globalThis.appbegStore;
globalThis.appbegStore = {
  configured: true,
  async getPlayerByUid() {
    return { uid: 'playeruid123456', status: 'active', username: 'RoyalUser01' };
  }
};
await assertStartSendsMenu({
  ...guest,
  id: 12,
  telegram_id: 5012,
  registration_status: 'Registered',
  appbeg_account_id: 'playeruid123456',
  appbeg_link_status: 'linked'
}, ['Deposit', 'Royal VIP', 'My Account', 'Support'], /Welcome back/, {
  row: 0,
  column: 1,
  text: 'Royal VIP',
  url: 'https://royal.youplatform.org'
});
globalThis.appbegStore = previousAppBegStore;
console.log('ok registered /start sends deterministic menu without AI');

const supportContact = {
  ...guest,
  id: 13,
  telegram_id: 5013,
  registration_status: 'Registered'
};
const supportStore = createProcessorStore(supportContact, { aiMode: 'train' });
let failureAttempts = 0;
const timeoutResult = await processBotJob(supportStore, startJob(supportContact, 'I need help', 701), {
  bot: createFakeBot(),
  supportAiGenerator: async () => {
    failureAttempts += 1;
    throw new Error('AI provider timed out.');
  }
});
assert.equal(timeoutResult.ok, true);
assert.equal(failureAttempts, 2);
assert.equal(supportStore.calls.outbound.length, 1);
assert.match(supportStore.calls.outbound[0].text, /having trouble accessing support/i);
assert.equal(supportStore.calls.staffReview.length, 0);
assert.equal(supportStore.calls.completedJobs.at(-1).status, 'completed');
assert.match(supportStore.calls.completedJobs.at(-1).errorText, /timed out/);
console.log('ok AI failure sends fallback without staff takeover');

const takeoverContact = {
  ...guest,
  id: 14,
  telegram_id: 5014,
  registration_status: 'Registered',
  bot_paused: true,
  needs_staff_review: true
};
const takeoverStore = createProcessorStore(takeoverContact, { aiMode: 'auto' });
const takeoverResult = await processBotJob(takeoverStore, startJob(takeoverContact, 'Can someone help?', 702), {
  bot: createFakeBot(),
  supportAiGenerator: async () => ({
    configured: true,
    kind: 'general_support',
    confidence: 0.8,
    reply: 'Staff will help shortly.',
    reply_text: 'Staff will help shortly.',
    decision: { intent: 'general_support', recommended_action: 'send_support_reply' },
    entities: {},
    context: '',
    contactContext: { staff_takeover: true }
  })
});
assert.equal(takeoverResult.ok, true);
assert.equal(takeoverResult.skipped, true);
assert.equal(takeoverResult.reason, 'manual_pause');
assert.equal(takeoverStore.calls.outbound.length, 0);
assert.equal(takeoverStore.calls.staffReview.length, 0);
console.log('ok explicit manual takeover suppresses automatic AI replies');

const enqueueStore = createProcessorStore(guest);
const first = await enqueueChatbotJob(enqueueStore, {
  contactId: guest.id,
  telegramUserId: guest.telegram_id,
  incomingTelegramMessageId: 900,
  jobType: 'inbound_message',
  inputText: '/start'
});
enqueueStore.createBotJob = async () => ({ ...first, duplicate: true });
const duplicate = await enqueueChatbotJob(enqueueStore, {
  contactId: guest.id,
  telegramUserId: guest.telegram_id,
  incomingTelegramMessageId: 900,
  jobType: 'inbound_message',
  inputText: '/start'
});
assert.equal(duplicate.duplicate, true);
assert.equal(enqueueStore.calls.nudge.length, 1);
console.log('ok duplicate /start enqueue uses existing idempotency');

console.log('ALL IMMEDIATE SUPPORT BOT CHECKS PASSED');
