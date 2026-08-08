/**
 * Phase 7: cash-out Telegram feature-flag matrix + fail-safe effective gates.
 *
 * NOTIFICATIONS=false → no cards; CLAIM/DONE unavailable
 * CLAIM=false → read-only sync when notifications on; DONE forced off
 * DONE=true only meaningful when CLAIM=true (and notifications on)
 */

function envFlagTrue(raw) {
  const text = String(raw || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
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

/**
 * Effective CLAIM: requires notifications + claim flag.
 * M2M/bot availability is enforced by resolveCashoutTelegramFeatureGates / callbacks.
 */
export function isCashoutTelegramClaimEnabled(env = process.env) {
  const gates = resolveCashoutTelegramFeatureGates(env);
  return gates.claimEnabled;
}

/**
 * Effective DONE: requires notifications + claim + done + deps.
 * Contradictory DONE=true CLAIM=false → DONE disabled (fail-safe).
 */
export function isCashoutTelegramDoneEnabled(env = process.env) {
  const gates = resolveCashoutTelegramFeatureGates(env);
  return gates.doneEnabled;
}

export function isAppBegCashoutM2mConfigured(env = process.env) {
  const base = String(env.APPBEG_API_URL || '').trim();
  const token = String(env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  return Boolean(base && token);
}

export function isSupportNotificationBotConfigured(env = process.env) {
  return Boolean(String(env.SUPPORT_NOTIFICATION_BOT_TOKEN || '').trim());
}

/**
 * Resolve runtime-safe button/callback gates. Missing deps disable mutations.
 */
export function resolveCashoutTelegramFeatureGates(env = process.env) {
  const notificationsFlag = isCashoutTelegramNotificationsEnabled(env);
  const claimFlag = isCashoutTelegramClaimFlagEnabled(env);
  const doneFlag = isCashoutTelegramDoneFlagEnabled(env);
  const m2m = isAppBegCashoutM2mConfigured(env);
  const bot = isSupportNotificationBotConfigured(env);

  const contradictions = [];
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

  const claimEnabled = notificationsFlag && claimFlag && m2m && bot;
  const doneEnabled = claimEnabled && doneFlag;

  return {
    notificationsFlag,
    claimFlag,
    doneFlag,
    m2mConfigured: m2m,
    botConfigured: bot,
    notificationsEnabled: notificationsFlag && bot && m2m,
    claimEnabled,
    doneEnabled,
    contradictions
  };
}

/**
 * Startup validation — logs warnings, never throws / never prints secrets.
 */
export function validateCashoutTelegramStartupConfig(env = process.env, log = console) {
  const gates = resolveCashoutTelegramFeatureGates(env);
  const lines = [];

  lines.push(
    `[cashout-telegram] flags notifications=${gates.notificationsFlag} claim=${gates.claimFlag} done=${gates.doneFlag}`
  );
  lines.push(
    `[cashout-telegram] effective notifications=${gates.notificationsEnabled} claim=${gates.claimEnabled} done=${gates.doneEnabled}`
  );
  lines.push(
    `[cashout-telegram] deps m2m=${gates.m2mConfigured} bot=${gates.botConfigured}`
  );

  for (const code of gates.contradictions) {
    lines.push(`[cashout-telegram] config_warning ${code}`);
    if (code === 'DONE_WITHOUT_CLAIM') {
      lines.push('[cashout-telegram] fail_safe DONE disabled because CLAIM is false');
    }
  }

  if (gates.notificationsFlag && !gates.notificationsEnabled) {
    lines.push('[cashout-telegram] notifications requested but dependencies missing — worker will not mutate safely');
  }

  for (const line of lines) {
    log.warn ? log.warn(line) : log.log(line);
  }

  return gates;
}
