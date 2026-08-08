/**
 * Phase 7+: cash-out Telegram feature-flag matrix.
 * OPTIONAL integration — missing/invalid config must NEVER throw or stop AppbegLedger.
 *
 * Hierarchy: notifications → claim → done
 * Missing flags default false. Invalid values → false + warning.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

/**
 * Parse an optional boolean env flag.
 * Missing → false (not invalid).
 * Recognized false/true → that value.
 * Anything else → false + invalid=true.
 */
export function parseOptionalEnvFlag(raw) {
  if (raw == null) {
    return { present: false, value: false, invalid: false };
  }
  const text = String(raw).trim();
  if (text === '') {
    return { present: true, value: false, invalid: false };
  }
  const lower = text.toLowerCase();
  if (TRUE_VALUES.has(lower)) {
    return { present: true, value: true, invalid: false };
  }
  if (FALSE_VALUES.has(lower)) {
    return { present: true, value: false, invalid: false };
  }
  return { present: true, value: false, invalid: true };
}

function envFlagTrue(raw) {
  return parseOptionalEnvFlag(raw).value === true;
}

export function isCashoutTelegramNotificationsEnabled(env = process.env) {
  return envFlagTrue(env.CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED);
}

export function isCashoutTelegramClaimFlagEnabled(env = process.env) {
  return envFlagTrue(env.CASHOUT_TELEGRAM_CLAIM_ENABLED);
}

export function isCashoutTelegramDoneFlagEnabled(env = process.env) {
  return envFlagTrue(env.CASHOUT_TELEGRAM_DONE_ENABLED);
}

export function isAppBegCashoutM2mConfigured(env = process.env) {
  try {
    const base = String(env.APPBEG_API_URL || '').trim();
    const token = String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
    return Boolean(base && token);
  } catch {
    return false;
  }
}

export function isSupportNotificationBotConfigured(env = process.env) {
  try {
    return Boolean(String(env.SUPPORT_NOTIFICATION_BOT_TOKEN || '').trim());
  } catch {
    return false;
  }
}

/**
 * Resolve runtime-safe gates. Never throws.
 */
export function resolveCashoutTelegramFeatureGates(env = process.env) {
  try {
    const notificationsParsed = parseOptionalEnvFlag(env.CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED);
    const claimParsed = parseOptionalEnvFlag(env.CASHOUT_TELEGRAM_CLAIM_ENABLED);
    const doneParsed = parseOptionalEnvFlag(env.CASHOUT_TELEGRAM_DONE_ENABLED);

    const notificationsFlag = notificationsParsed.value;
    const claimFlag = claimParsed.value;
    const doneFlag = doneParsed.value;
    const m2m = isAppBegCashoutM2mConfigured(env);
    const bot = isSupportNotificationBotConfigured(env);

    const contradictions = [];
    const invalidFlags = [];

    if (notificationsParsed.invalid) {
      invalidFlags.push('CASHOUT_TELEGRAM_NOTIFICATIONS_ENABLED');
    }
    if (claimParsed.invalid) {
      invalidFlags.push('CASHOUT_TELEGRAM_CLAIM_ENABLED');
    }
    if (doneParsed.invalid) {
      invalidFlags.push('CASHOUT_TELEGRAM_DONE_ENABLED');
    }

    if (doneFlag && !claimFlag) {
      contradictions.push('DONE_WITHOUT_CLAIM');
    }
    if ((claimFlag || doneFlag) && !notificationsFlag) {
      contradictions.push('MUTATION_WITHOUT_NOTIFICATIONS');
    }
    if (notificationsFlag && !bot) {
      contradictions.push('NOTIFICATIONS_WITHOUT_BOT_TOKEN');
    }
    if ((notificationsFlag || claimFlag || doneFlag) && !m2m) {
      contradictions.push('FEATURE_WITHOUT_APPBEG_M2M');
    }

    const notificationsEnabled = notificationsFlag && bot && m2m;
    const claimEnabled = notificationsEnabled && claimFlag;
    const doneEnabled = claimEnabled && doneFlag;

    let status = 'disabled';
    if (notificationsFlag || claimFlag || doneFlag) {
      if (notificationsEnabled || claimEnabled || doneEnabled) {
        status = 'enabled';
      } else {
        status = 'misconfigured';
      }
    }

    return {
      notificationsFlag,
      claimFlag,
      doneFlag,
      m2mConfigured: m2m,
      botConfigured: bot,
      notificationsEnabled,
      claimEnabled,
      doneEnabled,
      contradictions,
      invalidFlags,
      configured: Boolean(m2m && bot),
      status
    };
  } catch {
    return {
      notificationsFlag: false,
      claimFlag: false,
      doneFlag: false,
      m2mConfigured: false,
      botConfigured: false,
      notificationsEnabled: false,
      claimEnabled: false,
      doneEnabled: false,
      contradictions: ['RESOLVE_FAILED'],
      invalidFlags: [],
      configured: false,
      status: 'disabled'
    };
  }
}

/**
 * Canonical optional-feature state for health / startup. Never throws.
 */
export function getCashoutTelegramFeatureState(env = process.env) {
  const gates = resolveCashoutTelegramFeatureGates(env);
  const warnings = [];

  for (const name of gates.invalidFlags || []) {
    const short = name
      .replace('CASHOUT_TELEGRAM_', '')
      .replace('_ENABLED', '');
    warnings.push(
      `Invalid ${name} value; cash-out Telegram ${short} disabled.`
    );
  }
  for (const code of gates.contradictions || []) {
    if (code === 'DONE_WITHOUT_CLAIM') {
      warnings.push('CASHOUT_TELEGRAM_DONE_ENABLED is true but CLAIM is false; DONE disabled.');
    } else if (code === 'MUTATION_WITHOUT_NOTIFICATIONS') {
      warnings.push('CLAIM/DONE requested while notifications are false; mutations disabled.');
    } else if (code === 'NOTIFICATIONS_WITHOUT_BOT_TOKEN') {
      warnings.push('Cash-out Telegram notifications requested but SUPPORT_NOTIFICATION_BOT_TOKEN is missing; feature disabled.');
    } else if (code === 'FEATURE_WITHOUT_APPBEG_M2M') {
      warnings.push('Cash-out Telegram feature requested but AppBeg M2M URL/token is missing; feature disabled.');
    } else if (code === 'RESOLVE_FAILED') {
      warnings.push('Cash-out Telegram feature state could not be resolved; feature disabled.');
    }
  }

  return {
    notificationsEnabled: gates.notificationsEnabled,
    claimEnabled: gates.claimEnabled,
    doneEnabled: gates.doneEnabled,
    notificationsFlag: gates.notificationsFlag,
    claimFlag: gates.claimFlag,
    doneFlag: gates.doneFlag,
    configured: gates.configured,
    m2mConfigured: gates.m2mConfigured,
    botConfigured: gates.botConfigured,
    status: gates.status,
    contradictions: gates.contradictions,
    invalidFlags: gates.invalidFlags,
    warnings
  };
}

export function isCashoutTelegramClaimEnabled(env = process.env) {
  return resolveCashoutTelegramFeatureGates(env).claimEnabled;
}

export function isCashoutTelegramDoneEnabled(env = process.env) {
  return resolveCashoutTelegramFeatureGates(env).doneEnabled;
}

/**
 * Startup validation — logs warnings only. Never throws / never prints secrets.
 */
export function validateCashoutTelegramStartupConfig(env = process.env, log = console) {
  try {
    const state = getCashoutTelegramFeatureState(env);
    const emit = typeof log?.warn === 'function' ? log.warn.bind(log) : console.warn;

    emit(
      `[cashout-telegram] flags notifications=${state.notificationsFlag} claim=${state.claimFlag} done=${state.doneFlag}`
    );
    emit(
      `[cashout-telegram] effective notifications=${state.notificationsEnabled} claim=${state.claimEnabled} done=${state.doneEnabled} status=${state.status}`
    );
    emit(
      `[cashout-telegram] deps m2m=${state.m2mConfigured} bot=${state.botConfigured} configured=${state.configured}`
    );

    for (const warning of state.warnings) {
      emit(`[cashout-telegram] ${warning}`);
    }

    if (state.status === 'disabled') {
      emit('[cashout-telegram] optional integration idle (disabled or unconfigured)');
    }

    return state;
  } catch (error) {
    try {
      console.warn('[cashout-telegram] startup validation skipped', {
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // ignore logging failure
    }
    return getCashoutTelegramFeatureState({});
  }
}
