import assert from 'node:assert/strict';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import {
  HELP_HOME_ACTION,
  HELP_TOPIC_PREFIX,
  helpCenterTopicKeys
} from '../src/telegram/royalVipHelpCenter.js';
import { validateCallbackFreshness } from '../src/telegram/callbackSafety.js';

function createStore({ currentFlow = null, currentStep = null, registrationInfo = {} } = {}) {
  let state = {
    current_flow: currentFlow,
    current_step: currentStep,
    registration_info: {
      payment_display_name: 'Amy Fei',
      payment_name: 'Amy Fei',
      appbeg_player_uid: 'playeruid123456',
      appbeg_creation_complete: true,
      ...registrationInfo
    }
  };
  const calls = { updates: [] };
  return {
    calls,
    async ensureAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async getAutomationState() {
      return this.ensureAutomationState();
    },
    async updateAutomationState(_id, patch = {}) {
      calls.updates.push(patch);
      state = {
        ...state,
        current_flow: patch.currentFlow ?? state.current_flow,
        current_step: patch.currentStep ?? state.current_step,
        registration_info: patch.registrationInfo
          ? { ...state.registration_info, ...patch.registrationInfo }
          : state.registration_info
      };
      return this.ensureAutomationState();
    },
    async getActiveRegistrationPaymentWindow() {
      return null;
    },
    async getRegistrationDefaultPaymentQr() {
      return null;
    },
    async listActivePaymentMethodsForRegistration() {
      return [];
    }
  };
}

function guestContact() {
  return {
    id: 11,
    telegram_id: 5011,
    display_name: 'Guest',
    registration_status: 'New',
    active_messaging_source: 'bot_api'
  };
}

function registeredContact() {
  return {
    id: 77,
    telegram_id: 9077,
    display_name: 'Amy',
    registration_status: 'Registered',
    appbeg_account_id: 'playeruid123456',
    appbeg_link_status: 'linked',
    active_messaging_source: 'bot_api'
  };
}

async function run() {
  const previousAppBegStore = globalThis.appbegStore;
  globalThis.appbegStore = {
    configured: true,
    async getPlayerByUid() {
      return { uid: 'playeruid123456', status: 'active', username: 'AmyVip01' };
    }
  };

  const home = await decideBotReply({
    store: createStore(),
    contact: guestContact(),
    action: HELP_HOME_ACTION
  });
  assert.equal(home.kind, 'help_center_home');
  assert.match(home.replies[0].text, /Royal VIP Help Center/);
  assert.match(home.replies[0].text, /read-only/);
  assert.ok(home.replies[0].buttons.flat().some((button) => button.data === `${HELP_TOPIC_PREFIX}playing`));
  assert.ok(home.replies[0].buttons.flat().some((button) => button.data === 'bot:main_menu'));
  console.log('ok Help opens guided Royal VIP Help Center home');

  for (const key of helpCenterTopicKeys()) {
    const decision = await decideBotReply({
      store: createStore(),
      contact: registeredContact(),
      action: `${HELP_TOPIC_PREFIX}${key}`
    });
    assert.equal(decision.kind, `help_center_${key}`);
    assert.equal(decision.statePatch, null);
    assert.equal(decision.escalate, false);
    assert.ok(decision.replies[0].buttons.flat().some((button) => button.data === HELP_HOME_ACTION));
    assert.ok(decision.replies[0].buttons.flat().some((button) => button.data === 'bot:main_menu'));
    assert.doesNotMatch(decision.replies[0].text, /AppBeg/);
  }
  console.log('ok every Help Center topic opens with Back/Home navigation');

  const deposits = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}deposits`
  });
  assert.match(deposits.replies[0].text, /Loading coins is now handled through the Royal VIP Telegram bot/);
  assert.match(deposits.replies[0].text, /Tap \*\*Deposit\*\* from the bot's main menu/);
  assert.match(deposits.replies[0].text, /Royal VIP balance will be updated automatically/);
  assert.doesNotMatch(deposits.replies[0].text, /Load Coin|Load coin/i);
  assert.doesNotMatch(deposits.replies[0].text, /payment reference/i);
  assert.doesNotMatch(deposits.replies[0].text, /payment note|remark/i);
  assert.doesNotMatch(deposits.replies[0].text, /10-minute/i);
  assert.doesNotMatch(deposits.replies[0].text, /staff.*match/i);
  assert.doesNotMatch(deposits.replies[0].text, /16-digit code/);

  const previousBot = globalThis.telegramBot;
  globalThis.telegramBot = { botInfo: { username: 'ConfiguredRoyalVipBot' } };
  const depositsWithBotLink = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}deposits`
  });
  const openBotButton = depositsWithBotLink.replies[0].buttons.flat()
    .find((button) => button.text === '🚀 Open Royal VIP Bot');
  assert.equal(openBotButton.url, 'https://t.me/ConfiguredRoyalVipBot');
  assert.ok(depositsWithBotLink.replies[0].buttons.flat().some((button) => button.data === HELP_HOME_ACTION));
  assert.ok(depositsWithBotLink.replies[0].buttons.flat().some((button) => button.data === 'bot:main_menu'));
  globalThis.telegramBot = previousBot;

  const cashouts = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}cashouts`
  });
  assert.match(cashouts.replies[0].text, /QR/);
  assert.match(cashouts.replies[0].text, /Payment App/);
  assert.match(cashouts.replies[0].text, /Cashout Successful/);

  const vault = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}vault`
  });
  assert.match(vault.replies[0].text, /game username/);
  assert.match(vault.replies[0].text, /game password/);
  assert.match(vault.replies[0].text, /Reset password/);
  const freePlay = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}free_play`
  });
  assert.match(freePlay.replies[0].text, /FreePlay Gift Box/);
  assert.match(freePlay.replies[0].text, /referral rewards/);
  console.log('ok Help reflects inspected Royal VIP deposit, cashout, Vault, and Free Play features');

  const activeRegistrationStore = createStore({
    currentFlow: 'bot_registration',
    currentStep: 'enter_appbeg_password',
    registrationInfo: { appbeg_password: 'Secret123' }
  });
  const registrationHelp = await decideBotReply({
    store: activeRegistrationStore,
    contact: { ...guestContact(), registration_status: 'Collecting Info' },
    action: `${HELP_TOPIC_PREFIX}getting_started`
  });
  assert.equal(registrationHelp.statePatch, null);
  assert.equal(activeRegistrationStore.calls.updates.length, 0);
  assert.equal((await activeRegistrationStore.getAutomationState()).current_step, 'enter_appbeg_password');

  const activeDepositStore = createStore({
    currentFlow: 'registered_deposit',
    currentStep: 'deposit_amount'
  });
  const depositHelp = await decideBotReply({
    store: activeDepositStore,
    contact: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}faq`
  });
  assert.equal(depositHelp.statePatch, null);
  assert.equal(activeDepositStore.calls.updates.length, 0);
  assert.equal((await activeDepositStore.getAutomationState()).current_step, 'deposit_amount');
  console.log('ok Help is read-only and does not interrupt registration or deposit state');

  const mainMenu = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: 'bot:main_menu'
  });
  assert.match(mainMenu.replies[0].text, /Welcome back/);

  const support = await decideBotReply({
    store: createStore(),
    contact: registeredContact(),
    action: 'menu:support'
  });
  assert.equal(support.kind, 'contact_support');
  assert.match(support.replies[0].text, /support team/i);
  console.log('ok Help Home/Main Menu and Support navigation work');

  const staleHelp = await validateCallbackFreshness({
    store: createStore({ registrationInfo: { active_bot_message_id: 200 } }),
    user: registeredContact(),
    action: `${HELP_TOPIC_PREFIX}playing`,
    callbackMessageId: 100
  });
  assert.equal(staleHelp.ok, true);
  assert.equal(staleHelp.stateChanging, false);
  console.log('ok Help topic callbacks are read-only for callback freshness checks');

  globalThis.appbegStore = previousAppBegStore;
  console.log('All Royal VIP Help Center focused checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
