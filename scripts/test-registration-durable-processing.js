import assert from 'node:assert/strict';

import { enqueueChatbotJob, processBotJob } from '../src/telegram/chatbotProcessor.js';
import { startChatbotWorker } from '../src/telegram/chatbotWorker.js';

function createStore(initial = {}) {
  const contact = {
    id: 101,
    telegram_id: '555101',
    username: 'amy',
    display_name: 'Amy',
    registration_status: 'New',
    telegram_sync_source: 'bot_api',
    active_messaging_source: 'bot_api',
    bot_enabled: true,
    bot_paused: false,
    ...initial.contact
  };
  const store = {
    contact,
    state: {
      current_flow: initial.current_flow ?? null,
      current_step: initial.current_step ?? null,
      registration_info: { ...(initial.registration_info || {}) }
    },
    jobs: [],
    completed: [],
    outgoing: [],
    statusUpdates: [],
    nextJobId: 1,
    botSession: initial.botSession || { workflow_key: null, workflow_step: null },
    async getUserProfile(id) {
      return Number(id) === Number(contact.id) ? { ...contact } : null;
    },
    async ensureAutomationState() {
      return cloneState(store.state);
    },
    async getAutomationState() {
      return cloneState(store.state);
    },
    async getBotSession() {
      return store.botSession;
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return {
        paymentMethodId: 1,
        paymentMethodName: 'Chime',
        paymentMethodKey: 'chime',
        qr: { id: 10, file_path: 'data/media/payment-qr/test.png' }
      };
    },
    async listActivePaymentMethodsForRegistration() {
      return [{ id: 1, name: 'Chime', key: 'chime' }];
    },
    async getAutoRegistrationBotSettings() {
      return { enabled: true, enabled_at: null };
    },
    async isIncomingMessageEligibleForAutoBot() {
      return { eligible: true };
    },
    async countIncomingMessages() {
      return 2;
    },
    async updateRegistrationStatus(_id, status) {
      contact.registration_status = status;
      store.statusUpdates.push(status);
      return { ...contact };
    },
    async updateAutomationState(_id, patch = {}) {
      if (patch.currentFlow !== undefined) store.state.current_flow = patch.currentFlow;
      if (patch.currentStep !== undefined) store.state.current_step = patch.currentStep;
      if (patch.registrationInfo) store.state.registration_info = { ...patch.registrationInfo };
      return cloneState(store.state);
    },
    async updateRegistrationInfo(_id, info = {}) {
      store.state.registration_info = { ...store.state.registration_info, ...info };
      return cloneState(store.state);
    },
    async markAutoWelcomeSent() {},
    async logAutomationDecision(entry) {
      store.lastDecisionLog = entry;
    },
    async completeBotJob(id, result = {}) {
      const job = store.jobs.find((item) => item.id === id);
      if (job) job.status = result.status || 'completed';
      store.completed.push({ id, ...result });
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    },
    async storeOutgoingMessage(message) {
      store.outgoing.push(message);
      return { messageId: message.telegramMessageId };
    },
    async nudgeBotQueue() {},
    async createBotJob(input) {
      const existing = store.jobs.find((job) => (
        input.updateId != null
          ? job.update_id === input.updateId && ['pending', 'processing', 'completed'].includes(job.status)
          : job.contact_id === input.contactId
            && job.incoming_telegram_message_id === input.incomingTelegramMessageId
            && job.job_type === input.jobType
            && ['pending', 'processing', 'completed'].includes(job.status)
      ));
      if (existing) return { ...existing, duplicate: true };
      const job = {
        id: store.nextJobId++,
        contact_id: input.contactId,
        telegram_user_id: String(input.telegramUserId),
        update_id: input.updateId,
        message_id: input.messageId,
        incoming_telegram_message_id: input.incomingTelegramMessageId,
        job_type: input.jobType,
        input_text: input.inputText,
        action: input.action,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      store.jobs.push(job);
      return job;
    },
    async claimNextBotJob() {
      const job = store.jobs.find((item) => item.status === 'pending');
      if (!job) return null;
      job.status = 'processing';
      return job;
    },
    async resetStuckBotJobs() {}
  };
  return store;
}

function cloneState(state) {
  return {
    current_flow: state.current_flow,
    current_step: state.current_step,
    registration_info: { ...(state.registration_info || {}) }
  };
}

function createBot({ failFirstSend = false } = {}) {
  let attempts = 0;
  return {
    sent: [],
    telegram: {
      async sendMessage(chatId, text, options) {
        attempts += 1;
        if (failFirstSend && attempts === 1) {
          throw new Error('temporary telegram send failure');
        }
        const message = {
          message_id: 700 + attempts,
          reply_markup: options?.reply_markup || null
        };
        this.sent?.push?.(message);
        return message;
      }
    }
  };
}

function registrationJob(store, overrides = {}) {
  return {
    id: overrides.id || 1,
    contact_id: store.contact.id,
    telegram_user_id: store.contact.telegram_id,
    update_id: overrides.update_id ?? 9001,
    message_id: overrides.message_id ?? 501,
    incoming_telegram_message_id: overrides.incoming_telegram_message_id ?? 601,
    job_type: overrides.job_type || 'inbound_message',
    input_text: overrides.input_text ?? 'Amy Field',
    action: overrides.action || null,
    status: overrides.status,
    created_at: new Date().toISOString()
  };
}

async function testValidNameSendsAmountQuestion() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const bot = createBot();
  const result = await processBotJob(store, registrationJob(store), { bot });
  assert.equal(result.ok, true);
  assert.equal(store.state.current_step, 'first_deposit_amount');
  assert.equal(store.state.registration_info.payment_display_name, 'Amy Field');
  assert.match(store.outgoing.at(-1).text, /Enter the exact amount/);
}

async function testSendFailureKeepsStepAndSendsRecovery() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const bot = createBot({ failFirstSend: true });
  const result = await processBotJob(store, registrationJob(store), { bot });
  assert.equal(result.ok, false);
  assert.equal(store.state.current_step, 'payment_name');
  assert.equal(store.state.registration_info.payment_display_name, undefined);
  assert.equal(store.outgoing.at(-1).text, 'Something went wrong while saving that. Please try again.');
  assert.equal(store.completed.at(-1).status, 'failed');
}

async function testRetryAfterFailureAdvancesOnce() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  await processBotJob(store, registrationJob(store, { id: 1, update_id: 9002 }), {
    bot: createBot({ failFirstSend: true })
  });
  const result = await processBotJob(store, registrationJob(store, { id: 2, update_id: 9003 }), {
    bot: createBot()
  });
  assert.equal(result.ok, true);
  assert.equal(store.state.current_step, 'first_deposit_amount');
  assert.equal(store.outgoing.filter((message) => /Enter the exact amount/.test(message.text)).length, 1);
}

async function testDuplicateUpdateDoesNotAdvanceTwice() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const first = await enqueueChatbotJob(store, {
    contactId: store.contact.id,
    telegramUserId: store.contact.telegram_id,
    updateId: 12345,
    incomingTelegramMessageId: 888,
    inputText: 'Amy Field'
  });
  first.status = 'completed';
  const duplicate = await enqueueChatbotJob(store, {
    contactId: store.contact.id,
    telegramUserId: store.contact.telegram_id,
    updateId: 12345,
    incomingTelegramMessageId: 888,
    inputText: 'Amy Field'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.jobs.length, 1);
}

async function testRestartBetweenStepsPreservesRegistration() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'first_deposit_amount',
    registration_info: { payment_display_name: 'Amy Field' }
  });
  const result = await processBotJob(store, registrationJob(store, {
    input_text: 'hello',
    update_id: 9004
  }), { bot: createBot() });
  assert.equal(result.ok, true);
  assert.equal(store.state.current_step, 'first_deposit_amount');
  assert.equal(store.state.registration_info.payment_display_name, 'Amy Field');
}

async function testHelpDoesNotDestroyActiveRegistration() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  const result = await processBotJob(store, registrationJob(store, {
    input_text: 'Help',
    update_id: 9005
  }), { bot: createBot() });
  assert.equal(result.ok, true);
  assert.equal(store.state.current_step, 'payment_name');
}

async function testCancelRemovesRegistrationState() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name',
    registration_info: { payment_display_name: 'Amy Field' }
  });
  const result = await processBotJob(store, registrationJob(store, {
    job_type: 'callback_action',
    action: 'bot:stop',
    input_text: '',
    update_id: 9006
  }), { bot: createBot() });
  assert.equal(result.ok, true);
  assert.equal(store.state.current_flow, null);
  assert.equal(store.state.current_step, null);
  assert.equal(store.state.registration_info.payment_display_name, undefined);
}

async function testPasswordInputIsRedactedFromRegistrationLogs() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'password',
    registration_info: {
      payment_display_name: 'Amy Field',
      payment_confirmed: true,
      appbeg_username: 'AmyField01'
    }
  });
  const secret = 'SuperSecret123!';
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    originalLog(...args);
  };
  try {
    const result = await processBotJob(store, registrationJob(store, {
      input_text: secret,
      update_id: 9007
    }), { bot: createBot() });
    assert.equal(result.ok, true);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some((line) => line.includes(secret)), false);
  assert.equal(logs.some((line) => line.includes('[redacted]')), true);
}

async function testWorkerContinuesAfterException() {
  const store = createStore({
    current_flow: 'bot_registration',
    current_step: 'payment_name'
  });
  store.jobs.push(registrationJob(store, { id: 1, update_id: 9101, input_text: 'Amy Field', status: 'pending' }));
  store.jobs.push(registrationJob(store, { id: 2, update_id: 9102, input_text: 'Amy Field', status: 'pending' }));
  let sends = 0;
  globalThis.telegramBot = {
    telegram: {
      async sendMessage(_chatId, _text, options) {
        sends += 1;
        if (sends === 1) throw new Error('first update failed');
        return { message_id: 800 + sends, reply_markup: options?.reply_markup || null };
      }
    }
  };
  const worker = startChatbotWorker({ store, io: null, concurrency: 1 });
  await new Promise((resolve) => setTimeout(resolve, 900));
  await worker.stop();
  assert.equal(store.jobs[0].status, 'failed');
  assert.equal(store.jobs[1].status, 'completed');
}

await testValidNameSendsAmountQuestion();
await testSendFailureKeepsStepAndSendsRecovery();
await testRetryAfterFailureAdvancesOnce();
await testDuplicateUpdateDoesNotAdvanceTwice();
await testRestartBetweenStepsPreservesRegistration();
await testHelpDoesNotDestroyActiveRegistration();
await testCancelRemovesRegistrationState();
await testPasswordInputIsRedactedFromRegistrationLogs();
await testWorkerContinuesAfterException();

console.log('registration durable processing tests passed');
