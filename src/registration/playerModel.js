import { normalizeAppBegUsername, normalizePaymentTag, parseJsonField } from './utils.js';

export function statusSlug(status) {
  return String(status || 'unknown').trim().toLowerCase().replace(/\s+/g, '-');
}

export function registrationTimeoutHours() {
  return Number(process.env.REGISTRATION_TIMEOUT_HOURS || 72);
}

export function computeRegistrationProgress(player, info = {}) {
  const steps = [
    {
      key: 'telegram',
      label: 'Telegram Connected',
      done: Boolean(player.telegram_id)
    },
    {
      key: 'appbeg',
      label: 'AppBeg Username',
      done: Boolean(info.preferred_appbeg_username || player.appbeg_account_id)
    },
    {
      key: 'payment',
      label: 'Payment Tag',
      done: Boolean(info.payment_tag)
    },
    {
      key: 'submitted',
      label: 'Submitted for Review',
      done: ['Pending Verification', 'Registered'].includes(player.registration_status)
    }
  ];
  const completed = steps.filter((step) => step.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    percent: Math.round((completed / steps.length) * 100)
  };
}

export function buildDuplicateIndex(players) {
  const appbeg = new Map();
  const payment = new Map();

  for (const player of players) {
    const appbegKey = normalizeAppBegUsername(player.appbeg_username);
    const paymentKey = normalizePaymentTag(player.payment_tag);
    if (appbegKey) {
      if (!appbeg.has(appbegKey)) appbeg.set(appbegKey, []);
      appbeg.get(appbegKey).push(player.id);
    }
    if (paymentKey) {
      if (!payment.has(paymentKey)) payment.set(paymentKey, []);
      payment.get(paymentKey).push(player.id);
    }
  }

  return { appbeg, payment };
}

export function computeAttentionFlags(player, context = {}) {
  const flags = [];
  const info = player.registration_info || {};
  const progress = player.registration_progress || computeRegistrationProgress(player, info);
  const timeoutMs = registrationTimeoutHours() * 60 * 60 * 1000;

  if (context.duplicateAppbeg) {
    flags.push({ type: 'duplicate_appbeg', label: 'Duplicate AppBeg username', severity: 'high' });
  }
  if (context.duplicatePayment) {
    flags.push({ type: 'duplicate_payment', label: 'Duplicate payment tag', severity: 'high' });
  }

  if (player.registration_status === 'Collecting Info' && player.updated_at) {
    const staleMs = Date.now() - new Date(player.updated_at).getTime();
    if (staleMs > timeoutMs) {
      flags.push({ type: 'registration_timed_out', label: 'Registration timed out', severity: 'medium' });
    }
  }

  if (['New', 'Collecting Info'].includes(player.registration_status) && progress.percent < 100) {
    const missing = progress.steps.filter((step) => !step.done && step.key !== 'submitted').map((step) => step.label);
    if (missing.length) {
      flags.push({ type: 'missing_info', label: `Missing: ${missing.join(', ')}`, severity: 'medium' });
    }
  }

  if (player.registration_status === 'Pending Verification' && !player.info_reviewed_at) {
    flags.push({ type: 'manual_review', label: 'Manual review required', severity: 'high' });
  }

  if (context.automationError) {
    flags.push({ type: 'automation_error', label: 'Automation error', severity: 'high' });
  }

  if (player.registration_status === 'Suspended' && player.suspended_at) {
    const suspendedMs = Date.now() - new Date(player.suspended_at).getTime();
    if (suspendedMs > timeoutMs * 2) {
      flags.push({ type: 'registration_expired', label: 'Registration expired', severity: 'low' });
    }
  }

  return flags;
}

export function enrichPlayer(row, context = {}) {
  if (!row) {
    throw new Error('Cannot enrich player without a telegram_users row.');
  }
  const info = parseJsonField(row.registration_info_json, {});
  const tags = parseJsonField(row.tags_json, []).filter((tag) => tag && tag.id);
  const player = {
    id: Number(row.id),
    telegram_id: row.telegram_id,
    display_name: row.display_name,
    username: row.username,
    phone_number: row.phone_number,
    registration_status: row.registration_status || 'New',
    registration_method: row.registration_method || info.registration_method || null,
    appbeg_username: info.preferred_appbeg_username || row.appbeg_account_id || null,
    payment_tag: info.payment_tag || null,
    coadmin_name: info.coadmin_name || null,
    coadmin_code: info.coadmin_code || null,
    appbeg_coadmin_uid: info.appbeg_coadmin_uid || null,
    registered_at: row.registered_at,
    suspended_at: row.suspended_at,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    updated_at: row.updated_at,
    info_reviewed_at: row.info_reviewed_at,
    info_reviewed_by: row.info_reviewed_by,
    notes_text: row.notes_text || '',
    tags,
    registration_info: info,
    current_flow: row.current_flow || null,
    current_step: row.current_step || null,
    last_automation_at: row.last_automation_at || null
  };

  player.registration_progress = computeRegistrationProgress(player, info);
  player.attention_flags = computeAttentionFlags(player, context);
  player.needs_attention = player.attention_flags.length > 0;
  player.status_slug = statusSlug(player.registration_status);
  return player;
}

export function playerMatchesFilter(player, status) {
  if (status === 'All') return true;
  if (status === 'Not Registered') return player.registration_status === 'New';
  if (status === 'Needs Attention') return player.needs_attention;
  return player.registration_status === status;
}

export function playerMatchesQuery(player, normalizedQuery) {
  if (!normalizedQuery) return true;
  const haystack = [
    player.display_name,
    player.username,
    player.telegram_id,
    player.registration_status,
    player.appbeg_username,
    player.payment_tag,
    player.registration_method,
    player.phone_number,
    player.notes_text,
    player.coadmin_name,
    player.coadmin_code,
    player.appbeg_coadmin_uid,
    ...(player.tags || []).map((tag) => tag.name),
    ...(player.attention_flags || []).map((flag) => flag.label)
  ].join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

export function computePlayerStats(players) {
  const stats = {
    total: players.length,
    new: 0,
    collectingInfo: 0,
    pendingVerification: 0,
    registered: 0,
    suspended: 0,
    needsAttention: 0
  };

  for (const player of players) {
    if (player.registration_status === 'New') stats.new += 1;
    if (player.registration_status === 'Collecting Info') stats.collectingInfo += 1;
    if (player.registration_status === 'Pending Verification') stats.pendingVerification += 1;
    if (player.registration_status === 'Registered') stats.registered += 1;
    if (player.registration_status === 'Suspended') stats.suspended += 1;
    if (player.needs_attention) stats.needsAttention += 1;
  }

  return stats;
}
