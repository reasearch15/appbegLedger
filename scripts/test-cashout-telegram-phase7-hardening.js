import assert from 'node:assert/strict';
import {
  isCashoutTelegramClaimEnabled,
  isCashoutTelegramDoneEnabled,
  resolveCashoutTelegramFeatureGates,
  validateCashoutTelegramStartupConfig
} from '../src/telegram/cashoutTelegramFeatureFlags.js';
import {
  consumeCashoutTelegramCallbackRateLimit,
  resetCashoutTelegramCallbackRateLimitsForTests
} from '../src/telegram/cashoutTelegramCallbackRateLimit.js';
import {
  buildCashoutNotificationCard,
  buildCashoutNotificationReplyMarkup,
  isCashoutTelegramDoneEnabled as cardDoneEnabled
} from '../src/telegram/cashoutNotificationCards.js';

async function run() {
  const configured = {
    APPBEG_API_URL: 'https://appbeg.example',
    APPBEG_LEDGER_INTERNAL_TOKEN: 'token',
    SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot'
  };

  // --- Feature flag matrix ---
  {
    const gates = resolveCashoutTelegramFeatureGates({
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    });
    assert.ok(gates.contradictions.includes('DONE_WITHOUT_CLAIM'));
    assert.equal(gates.doneEnabled, false);
    assert.equal(gates.claimEnabled, false);
  }

  {
    const gates = resolveCashoutTelegramFeatureGates({
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'false',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    });
    assert.equal(gates.claimEnabled, false);
    assert.equal(gates.doneEnabled, false);
    assert.ok(gates.contradictions.includes('MUTATION_WITHOUT_NOTIFICATIONS'));
  }

  {
    const gates = resolveCashoutTelegramFeatureGates({
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
      // missing m2m + bot
    });
    assert.equal(gates.claimEnabled, false);
    assert.equal(gates.doneEnabled, false);
    assert.ok(gates.contradictions.includes('FEATURE_WITHOUT_APPBEG_M2M'));
    assert.ok(gates.contradictions.includes('NOTIFICATIONS_WITHOUT_BOT_TOKEN'));
  }

  assert.equal(
    isCashoutTelegramClaimEnabled({
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true'
    }),
    true
  );

  assert.equal(
    isCashoutTelegramClaimEnabled({
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true'
    }),
    false
  );

  assert.equal(
    isCashoutTelegramDoneEnabled({
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'true',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    }),
    true
  );

  assert.equal(
    cardDoneEnabled({
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
    }),
    false
  );

  const logs = [];
  validateCashoutTelegramStartupConfig(
    {
      ...configured,
      CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
      CASHOUT_TELEGRAM_DONE_ENABLED: 'true',
      APPBEG_LEDGER_INTERNAL_TOKEN: 'secret-token-should-not-appear',
      SUPPORT_NOTIFICATION_BOT_TOKEN: 'bot-secret'
    },
    {
      warn: (line) => logs.push(String(line)),
      log: (line) => logs.push(String(line))
    }
  );
  assert.ok(logs.some((l) => /DONE disabled|DONE_WITHOUT_CLAIM|CLAIM is false/i.test(l)));
  assert.ok(!logs.some((l) => /secret-token-should-not-appear/.test(l)));
  assert.ok(!logs.some((l) => /bot-secret/.test(l)));

  // --- Rate limit ---
  resetCashoutTelegramCallbackRateLimitsForTests();
  for (let i = 0; i < 20; i += 1) {
    assert.equal(consumeCashoutTelegramCallbackRateLimit({ key: 'claim:11', limit: 20 }).allowed, true);
  }
  assert.equal(consumeCashoutTelegramCallbackRateLimit({ key: 'claim:11', limit: 20 }).allowed, false);

  // --- Attribution card wording (Ledger card builder) ---
  const claimed = {
    taskId: 't1',
    status: 'in_progress',
    playerUsername: 'p',
    amountNpr: 100,
    assignedHandlerUsername: 'CoadminA',
    operationalClaim: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramDisplayName: 'Picasso',
      telegramUsername: 'picasso'
    }
  };
  const claimedCard = buildCashoutNotificationCard(claimed);
  assert.match(claimedCard, /Claimed via Telegram by: Picasso/);
  assert.doesNotMatch(claimedCard, /Handler: CoadminA/);

  const tgComplete = {
    ...claimed,
    status: 'completed',
    completedAt: '2026-08-08T12:05:00.000Z',
    operationalCompletion: {
      actionSource: 'telegram',
      telegramUserId: '11',
      telegramDisplayName: 'Picasso',
      telegramUsername: 'picasso',
      telegramCompletedAt: '2026-08-08T12:05:00.000Z'
    }
  };
  assert.match(buildCashoutNotificationCard(tgComplete), /Completed via Telegram by: Picasso/);

  const humanAfterClaim = {
    ...claimed,
    status: 'completed',
    completedAt: '2026-08-08T12:06:00.000Z',
    operationalCompletion: null
  };
  const humanCard = buildCashoutNotificationCard(humanAfterClaim);
  assert.match(humanCard, /Handler: CoadminA/);
  assert.doesNotMatch(humanCard, /Completed via Telegram/);

  // DONE button fail-safe when claim off even if doneEnabled option forced false by env path
  assert.deepEqual(
    buildCashoutNotificationReplyMarkup(claimed, {
      env: {
        ...configured,
        CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
        CASHOUT_TELEGRAM_CLAIM_ENABLED: 'false',
        CASHOUT_TELEGRAM_DONE_ENABLED: 'true'
      },
      viewerTelegramUserId: '11'
    }),
    { inline_keyboard: [] }
  );

  console.log('PASS: Phase 7 cash-out Telegram hardening tests');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
