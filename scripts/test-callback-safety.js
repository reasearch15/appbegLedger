import assert from 'node:assert/strict';
import {
  EXPIRED_CALLBACK_MESSAGE,
  recordActiveBotMessage,
  validateCallbackFreshness
} from '../src/telegram/callbackSafety.js';

function createStore(initialInfo = {}) {
  let state = {
    current_flow: null,
    current_step: null,
    registration_info: { ...initialInfo }
  };
  return {
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async updateAutomationState(_userId, patch = {}) {
      state = {
        ...state,
        current_flow: patch.currentFlow ?? state.current_flow,
        current_step: patch.currentStep ?? state.current_step,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.getAutomationState();
    }
  };
}

async function run() {
  assert.equal(EXPIRED_CALLBACK_MESSAGE, 'This button has expired. Please use the latest options.');

  const user = { id: 77, telegram_id: 9077 };
  const activeStore = createStore({ active_bot_message_id: 101, active_bot_message_version: 2 });
  const active = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:deposit',
    callbackMessageId: 101
  });
  assert.equal(active.ok, true);
  assert.equal(active.stateChanging, true);

  const doubleClick = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:deposit',
    callbackMessageId: 101
  });
  assert.equal(doubleClick.ok, true);
  assert.equal(doubleClick.activeMessageId, 101);
  console.log('ok current state-changing callback and double click are accepted');

  const stale = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:deposit',
    callbackMessageId: 100
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'expired_callback');
  assert.equal(stale.activeMessageId, 101);
  assert.equal(stale.pressedMessageId, 100);
  console.log('ok stale Deposit callback is rejected before job enqueue');

  const staleRegister = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:register',
    callbackMessageId: 100
  });
  assert.equal(staleRegister.ok, false);
  console.log('ok stale Register callback is rejected before starting a competing flow');

  const noRecordedMenu = await validateCallbackFreshness({
    store: createStore(),
    user,
    action: 'menu:deposit',
    callbackMessageId: 100
  });
  assert.equal(noRecordedMenu.ok, false);
  assert.equal(noRecordedMenu.recoverCurrentStep, true);
  console.log('ok expired callback without a recorded active menu asks caller to recover current step');

  const support = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:support',
    callbackMessageId: 100
  });
  assert.equal(support.ok, true);
  assert.equal(support.stateChanging, false);

  const account = await validateCallbackFreshness({
    store: activeStore,
    user,
    action: 'menu:my_account',
    callbackMessageId: 100
  });
  assert.equal(account.ok, true);
  assert.equal(account.stateChanging, false);
  console.log('ok Support and My Account remain accessible from older messages');

  const edits = [];
  const recordStore = createStore({ active_bot_message_id: 200, active_bot_message_version: 4 });
  const bot = {
    telegram: {
      async editMessageReplyMarkup(chatId, messageId, inlineMessageId, replyMarkup) {
        edits.push({ chatId, messageId, inlineMessageId, replyMarkup });
      }
    }
  };
  const nextState = await recordActiveBotMessage({
    store: recordStore,
    user,
    bot,
    messageId: 201,
    buttons: [[{ text: '🟢 Deposit', data: 'menu:deposit' }, { text: '🔴 Royal VIP', url: 'https://royal.youplatform.org' }]]
  });
  assert.equal(nextState.registration_info.active_bot_message_id, 201);
  assert.equal(nextState.registration_info.active_bot_message_version, 5);
  assert.deepEqual(edits, [{
    chatId: 9077,
    messageId: 200,
    inlineMessageId: undefined,
    replyMarkup: { inline_keyboard: [] }
  }]);
  console.log('ok new callback menu records active message and disables previous keyboard');

  const beforeUrlOnly = nextState.registration_info.active_bot_message_id;
  const afterUrlOnly = await recordActiveBotMessage({
    store: recordStore,
    user,
    bot,
    messageId: 202,
    buttons: [[{ text: '🔴 Royal VIP', url: 'https://royal.youplatform.org' }]]
  });
  assert.equal(afterUrlOnly, null);
  assert.equal((await recordStore.getAutomationState()).registration_info.active_bot_message_id, beforeUrlOnly);
  console.log('ok URL-only buttons do not replace active callback controls');

  console.log('All callback-safety focused checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
