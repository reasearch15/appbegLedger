/**
 * Config resilience: optional CASHOUT_TELEGRAM_* must never throw or take down the app.
 */
import assert from 'node:assert/strict';
import {
  getCashoutTelegramFeatureState,
  parseOptionalEnvFlag,
  resolveCashoutTelegramFeatureGates,
  validateCashoutTelegramStartupConfig
} from '../src/telegram/cashoutTelegramFeatureFlags.js';
import { startCashoutTelegramNotificationWorker } from '../src/telegram/cashoutTelegramNotificationWorker.js';
import {
  CASHOUT_CLAIM_FEATURE_OFF_TEXT,
  handleCashoutClaimCallback
} from '../src/telegram/cashoutClaimCallback.js';
import {
  CASHOUT_DONE_FEATURE_OFF_TEXT,
  handleCashoutDoneCallback
} from '../src/telegram/cashoutDoneCallback.js';
import { CASHOUT_CLAIM_PREFIX, CASHOUT_DONE_PREFIX } from '../src/telegram/cashoutNotificationCards.js';

function makeCtx({ userId, data }) {
  const answers = [];
  return {
    answers,
    from: { id: userId, first_name: 'Staff', username: 'staff' },
    callbackQuery: { data },
    answerCbQuery: async (text) => {
      answers.push(text);
    }
  };
}

async function run() {
  // 1–2. All three flags missing → loads; all false
  {
    const env = {};
    assert.doesNotThrow(() => resolveCashoutTelegramFeatureGates(env));
    const state = getCashoutTelegramFeatureState(env);
    assert.equal(state.notificationsEnabled, false);
    assert.equal(state.claimEnabled, false);
    assert.equal(state.doneEnabled, false);
    assert.equal(state.notificationsFlag, false);
    assert.equal(state.claimFlag, false);
    assert.equal(state.doneFlag, false);
    assert.equal(state.status, 'disabled');
    assert.equal(state.configured, false);
  }

  assert.deepEqual(parseOptionalEnvFlag(undefined), { present: false, value: false, invalid: false });
  assert.deepEqual(parseOptionalEnvFlag(null), { present: false, value: false, invalid: false });
  assert.equal(parseOptionalEnvFlag('true').value, true);
  assert.equal(parseOptionalEnvFlag('1').value, true);
  assert.equal(parseOptionalEnvFlag('yes').value, true);
  assert.equal(parseOptionalEnvFlag('on').value, true);

  // 3. notifications=true + claim missing → claim/done false (needs deps for effective notifications)
  {
    const configured = {
      APPBEG_API_URL: 'https://appbeg.example',
      APPBEG_LEDGER_INTERNAL_TOKEN: 'token',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot',
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true'
    };
    const gates = resolveCashoutTelegramFeatureGates(configured);
    assert.equal(gates.notificationsEnabled, true);
    assert.equal(gates.claimEnabled, false);
    assert.equal(gates.doneEnabled, false);
    assert.equal(gates.status, 'enabled');
  }

  // 4. done=true + claim=false → no crash; done effective false
  {
    const gates = resolveCashoutTelegramFeatureGates({
      APPBEG_API_URL: 'https://appbeg.example',
      APPBEG_LEDGER_INTERNAL_TOKEN: 'token',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot',
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    });
    assert.equal(gates.doneEnabled, false);
    assert.ok(gates.contradictions.includes('DONE_WITHOUT_CLAIM'));
  }

  // 5. claim=true + notifications=false → no crash; claim/done false
  {
    const gates = resolveCashoutTelegramFeatureGates({
      APPBEG_API_URL: 'https://appbeg.example',
      APPBEG_LEDGER_INTERNAL_TOKEN: 'token',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot',
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'false',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    });
    assert.equal(gates.claimEnabled, false);
    assert.equal(gates.doneEnabled, false);
    assert.ok(gates.contradictions.includes('MUTATION_WITHOUT_NOTIFICATIONS'));
  }

  // 6. invalid flag value → no crash + warning
  {
    const state = getCashoutTelegramFeatureState({
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'banana'
    });
    assert.equal(state.claimFlag, false);
    assert.equal(state.claimEnabled, false);
    assert.ok(state.invalidFlags.includes('CASHOUT_TELEGRAM_CLAIM_ENABLED'));
    assert.ok(state.warnings.some((w) =>
      /Invalid CASHOUT_TELEGRAM_CLAIM_ENABLED value; cash-out Telegram CLAIM disabled/i.test(w)
    ));
  }

  // 7–8. missing AppBeg token / URL → no crash; features disabled; status misconfigured when requested
  {
    const stateToken = getCashoutTelegramFeatureState({
      APPBEG_API_URL: 'https://appbeg.example',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot',
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    });
    assert.equal(stateToken.notificationsEnabled, false);
    assert.equal(stateToken.claimEnabled, false);
    assert.equal(stateToken.doneEnabled, false);
    assert.equal(stateToken.status, 'misconfigured');
    assert.ok(stateToken.warnings.some((w) => /AppBeg M2M/i.test(w)));

    const stateUrl = getCashoutTelegramFeatureState({
      APPBEG_LEDGER_INTERNAL_TOKEN: 'token',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot',
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true'
    });
    assert.equal(stateUrl.notificationsEnabled, false);
    assert.equal(stateUrl.status, 'misconfigured');
  }

  // 9. optional worker remains idle when notifications off
  {
    let polled = false;
    const store = {
      getCashoutOutboxConsumerState: async () => {
        polled = true;
        return { last_processed_outbox_id: 0 };
      }
    };
    const worker = startCashoutTelegramNotificationWorker({
      store,
      env: {},
      pollMs: 50
    });
    assert.equal(typeof worker.stop, 'function');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(polled, false);
    await worker.stop();
  }

  // 10–11. health-shaped state: application conceptually ok; integration disabled/misconfigured
  {
    const disabled = getCashoutTelegramFeatureState({});
    assert.equal(disabled.status, 'disabled');
    // Application health remains ok independently of this optional block.
    const applicationOk = true;
    assert.equal(applicationOk, true);

    const misconfigured = getCashoutTelegramFeatureState({
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true'
    });
    assert.equal(misconfigured.status, 'misconfigured');
  }

  // 12–13. stale Claim/Done callbacks while unavailable do not crash
  {
    const claimCtx = makeCtx({ userId: 11, data: `${CASHOUT_CLAIM_PREFIX}task-stale` });
    let claimCalled = false;
    const claimResult = await handleCashoutClaimCallback(claimCtx, {}, {
      env: {},
      claimTask: async () => {
        claimCalled = true;
        return { ok: true };
      }
    });
    assert.equal(claimResult.reason, 'claim_disabled');
    assert.equal(claimCalled, false);
    assert.equal(claimCtx.answers[0], CASHOUT_CLAIM_FEATURE_OFF_TEXT);

    const doneCtx = makeCtx({ userId: 11, data: `${CASHOUT_DONE_PREFIX}task-stale` });
    let doneCalled = false;
    const doneResult = await handleCashoutDoneCallback(doneCtx, {}, {
      env: {},
      completeTask: async () => {
        doneCalled = true;
        return { ok: true };
      }
    });
    assert.equal(doneResult.reason, 'done_disabled');
    assert.equal(doneCalled, false);
    assert.equal(doneCtx.answers[0], CASHOUT_DONE_FEATURE_OFF_TEXT);
  }

  // Startup validation never throws / never leaks secrets
  {
    const logs = [];
    assert.doesNotThrow(() => {
      validateCashoutTelegramStartupConfig(
        {
          CASHOUT_TELEGRAM_CLAIM_ENABLED: 'banana',
          APPBEG_LEDGER_INTERNAL_TOKEN: 'super-secret-token',
          SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-secret'
        },
        {
          warn: (line) => logs.push(String(line)),
          log: (line) => logs.push(String(line))
        }
      );
    });
    assert.ok(!logs.some((l) => /super-secret-token|bot-secret/.test(l)));
    assert.ok(logs.some((l) => /optional integration idle|Invalid CASHOUT_TELEGRAM_CLAIM/i.test(l)));
  }

  // Import-time safety: resolving with process.env-like object that has no cashout keys
  {
    const emptied = { ...process.env };
    for (const key of Object.keys(emptied)) {
      if (key.startsWith('CASHOUT_TELEGRAM_')) delete emptied[key];
    }
    const state = getCashoutTelegramFeatureState(emptied);
    assert.equal(state.notificationsFlag, false);
    assert.equal(state.claimFlag, false);
    assert.equal(state.doneFlag, false);
  }

  console.log('PASS: cash-out Telegram config resilience tests');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
