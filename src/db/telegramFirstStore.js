import { normalizeAppBegUsername, parseJsonField } from '../registration/utils.js';
import { normalizePaymentName } from '../payments/matchUtils.js';
import { LEGACY_EVIDENCE_KIND } from '../payments/confidenceEngine.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import {
  OPERATIONAL_ROLES,
  assertNotRootRemoval,
  canManageStaff,
  describeRootAdminEstablishment,
  normalizeTelegramUserId,
  rootAdminTelegramUserIdFromEnv
} from '../telegram/operationalRoles.js';
import { FREEPLAY_DECISION, FREEPLAY_ISSUANCE_STATUS } from '../appbeg/freeplayIssuanceClient.js';

export function attachTelegramFirstStore(store, {
  db,
  nowIso,
  getUserProfile,
  getPaymentEvent,
  getRegistrationPaymentWindow,
  getCoadminSettings,
  listSettingsAuditLog
}) {
  async function getActiveOperationalRole(telegramUserId) {
    const userId = normalizeTelegramUserId(telegramUserId);
    if (!userId) return null;
    return await db.prepare(`
      SELECT * FROM operational_roles
      WHERE telegram_user_id = ? AND revoked_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(userId);
  }

  async function listActiveOperationalRoles() {
    return await db.prepare(`
      SELECT * FROM operational_roles
      WHERE revoked_at IS NULL
      ORDER BY
        CASE role WHEN 'root_admin' THEN 0 WHEN 'coadmin' THEN 1 ELSE 2 END,
        granted_at ASC,
        id ASC
    `).all();
  }

  async function listOperationalRoleHistory(telegramUserId = null) {
    if (telegramUserId) {
      return await db.prepare(`
        SELECT * FROM operational_roles
        WHERE telegram_user_id = ?
        ORDER BY granted_at DESC, id DESC
      `).all(String(telegramUserId));
    }
    return await db.prepare(`
      SELECT * FROM operational_roles
      ORDER BY granted_at DESC, id DESC
    `).all();
  }

  async function bootstrapRootAdminFromEnv(env = process.env) {
    const rootId = rootAdminTelegramUserIdFromEnv(env);
    if (!rootId) return { ok: false, reason: 'missing_root_admin_env' };
    const existingRoot = await db.prepare(`
      SELECT * FROM operational_roles
      WHERE role = 'root_admin' AND revoked_at IS NULL
      LIMIT 1
    `).get();
    if (existingRoot) {
      if (String(existingRoot.telegram_user_id) !== rootId) {
        return { ok: false, reason: 'root_admin_already_bound', role: existingRoot };
      }
      return { ok: true, created: false, role: existingRoot };
    }
    const now = nowIso();
    await db.prepare(`
      INSERT INTO operational_roles (
        telegram_user_id, role, granted_by_telegram_user_id, granted_at, created_at, updated_at
      ) VALUES (?, 'root_admin', ?, ?, ?, ?)
    `).run(rootId, rootId, now, now, now);
    return {
      ok: true,
      created: true,
      role: await getActiveOperationalRole(rootId)
    };
  }

  async function inspectRootAdminBinding(env = process.env) {
    const establishment = describeRootAdminEstablishment(env);
    const bound = await db.prepare(`
      SELECT * FROM operational_roles
      WHERE role = 'root_admin' AND revoked_at IS NULL
      LIMIT 1
    `).get();
    const boundTelegramUserId = bound?.telegram_user_id || null;
    return {
      ...establishment,
      boundTelegramUserId,
      aligned: Boolean(
        establishment.configuredTelegramUserId
        && boundTelegramUserId
        && String(boundTelegramUserId) === String(establishment.configuredTelegramUserId)
      )
    };
  }

  async function grantOperationalRole({
    telegramUserId,
    role,
    grantedByTelegramUserId,
    telegramUsername = null,
    telegramDisplayName = null
  }) {
    const userId = normalizeTelegramUserId(telegramUserId);
    const actorId = normalizeTelegramUserId(grantedByTelegramUserId);
    const normalizedRole = String(role || '').trim();
    if (!userId) {
      const error = new Error('Telegram user ID is required.');
      error.code = 'MISSING_TELEGRAM_USER_ID';
      throw error;
    }
    if (![OPERATIONAL_ROLES.STAFF, OPERATIONAL_ROLES.COADMIN, OPERATIONAL_ROLES.ROOT_ADMIN].includes(normalizedRole)) {
      throw new Error('Invalid operational role.');
    }
    const actor = actorId ? await getActiveOperationalRole(actorId) : null;
    if (normalizedRole === OPERATIONAL_ROLES.ROOT_ADMIN) {
      throw new Error('Root Admin cannot be granted through Staff Management.');
    }
    if (!actor || !canManageStaff(actor.role)) {
      const error = new Error('Not authorized to manage Staff.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (normalizedRole === OPERATIONAL_ROLES.COADMIN && actor.role !== OPERATIONAL_ROLES.ROOT_ADMIN) {
      const error = new Error('Only Root Admin can add Coadmins.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    const existing = await getActiveOperationalRole(userId);
    if (existing) {
      if (existing.role === OPERATIONAL_ROLES.ROOT_ADMIN) {
        assertNotRootRemoval(existing.role);
      }
      if (existing.role === normalizedRole) return { ok: true, created: false, role: existing };
      const error = new Error(`User already has an active ${existing.role} role.`);
      error.code = 'ROLE_EXISTS';
      throw error;
    }
    const now = nowIso();
    await db.prepare(`
      INSERT INTO operational_roles (
        telegram_user_id, role, telegram_username, telegram_display_name,
        granted_by_telegram_user_id, granted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      normalizedRole,
      telegramUsername || null,
      telegramDisplayName || null,
      actorId,
      now,
      now,
      now
    );
    return { ok: true, created: true, role: await getActiveOperationalRole(userId) };
  }

  async function revokeOperationalRole({
    telegramUserId,
    revokedByTelegramUserId
  }) {
    const userId = normalizeTelegramUserId(telegramUserId);
    const actorId = normalizeTelegramUserId(revokedByTelegramUserId);
    const target = await getActiveOperationalRole(userId);
    if (!target) return { ok: true, alreadyRevoked: true };
    assertNotRootRemoval(target.role);
    const actor = actorId ? await getActiveOperationalRole(actorId) : null;
    if (!actor || !canManageStaff(actor.role)) {
      const error = new Error('Not authorized to remove Staff.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (target.role === OPERATIONAL_ROLES.COADMIN && actor.role !== OPERATIONAL_ROLES.ROOT_ADMIN) {
      const error = new Error('Only Root Admin can remove Coadmins.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    const now = nowIso();
    await db.prepare(`
      UPDATE operational_roles
      SET revoked_at = ?, revoked_by_telegram_user_id = ?, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(now, actorId, now, target.id);
    return { ok: true, alreadyRevoked: false, role: await db.prepare('SELECT * FROM operational_roles WHERE id = ?').get(target.id) };
  }

  async function getConfidenceMode() {
    const row = await db.prepare('SELECT * FROM coadmin_settings WHERE id = 1').get();
    return {
      enabled: Boolean(row?.confidence_mode_enabled),
      updated_at: row?.confidence_mode_updated_at || null,
      updated_by: row?.confidence_mode_updated_by || null
    };
  }

  async function setConfidenceMode({ enabled, actorTelegramUserId }) {
    const actorId = normalizeTelegramUserId(actorTelegramUserId);
    const actor = actorId ? await getActiveOperationalRole(actorId) : null;
    if (!actor || (actor.role !== OPERATIONAL_ROLES.ROOT_ADMIN && actor.role !== OPERATIONAL_ROLES.COADMIN)) {
      const error = new Error('Not authorized to change Confidence Mode.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    const current = await getConfidenceMode();
    const next = Boolean(enabled);
    if (current.enabled === next) return { ...current, changed: false };
    const now = nowIso();
    await db.prepare(`
      INSERT INTO coadmin_settings (id, confidence_mode_enabled, confidence_mode_updated_at, confidence_mode_updated_by, updated_at, updated_by)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        confidence_mode_enabled = excluded.confidence_mode_enabled,
        confidence_mode_updated_at = excluded.confidence_mode_updated_at,
        confidence_mode_updated_by = excluded.confidence_mode_updated_by,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(next ? 1 : 0, now, actorId, now, actorId);
    await db.prepare(`
      INSERT INTO operational_settings_audit (settings_key, old_value, new_value, actor_telegram_user_id, created_at)
      VALUES ('confidence_mode', ?, ?, ?, ?)
    `).run(current.enabled ? 'ON' : 'OFF', next ? 'ON' : 'OFF', actorId, now);
    return { enabled: next, updated_at: now, updated_by: actorId, changed: true, previous: current.enabled };
  }

  async function ensureCoadminSettingsRow() {
    const existing = await db.prepare('SELECT id FROM coadmin_settings WHERE id = 1').get();
    if (!existing) {
      await db.prepare('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, ?)').run(nowIso());
    }
  }

  async function getHubStorefrontState() {
    const row = await db.prepare('SELECT * FROM coadmin_settings WHERE id = 1').get();
    return {
      storefrontMessageId: row?.royal_vip_hub_storefront_message_id || null,
      syncedAt: row?.royal_vip_hub_storefront_synced_at || null,
      lastError: row?.royal_vip_hub_storefront_error || null,
      pinned: Boolean(row?.royal_vip_hub_storefront_pinned)
    };
  }

  async function saveHubStorefrontState({
    storefrontMessageId = null,
    syncedAt = null,
    lastError = null,
    pinned = false
  } = {}) {
    await ensureCoadminSettingsRow();
    await db.prepare(`
      UPDATE coadmin_settings
      SET royal_vip_hub_storefront_message_id = ?,
          royal_vip_hub_storefront_synced_at = ?,
          royal_vip_hub_storefront_error = ?,
          royal_vip_hub_storefront_pinned = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      storefrontMessageId || null,
      syncedAt || null,
      lastError || null,
      pinned ? 1 : 0,
      nowIso()
    );
    return getHubStorefrontState();
  }

  async function getControlCenterState() {
    const row = await db.prepare('SELECT * FROM coadmin_settings WHERE id = 1').get();
    return {
      messageId: row?.staff_control_center_message_id || null,
      threadId: row?.staff_control_center_thread_id || null,
      syncedAt: row?.staff_control_center_synced_at || null,
      lastError: row?.staff_control_center_error || null,
      pinned: Boolean(row?.staff_control_center_pinned)
    };
  }

  async function saveControlCenterState({
    messageId = null,
    threadId = null,
    syncedAt = null,
    lastError = null,
    pinned = false
  } = {}) {
    await ensureCoadminSettingsRow();
    await db.prepare(`
      UPDATE coadmin_settings
      SET staff_control_center_message_id = ?,
          staff_control_center_thread_id = ?,
          staff_control_center_synced_at = ?,
          staff_control_center_error = ?,
          staff_control_center_pinned = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      messageId || null,
      threadId || null,
      syncedAt || null,
      lastError || null,
      pinned ? 1 : 0,
      nowIso()
    );
    return getControlCenterState();
  }

  async function ensurePaymentIdentity(displayName) {
    const display = String(displayName || '').trim();
    if (!display) return null;
    const normalized = normalizePaymentName(display);
    if (!normalized) return null;
    const existing = await db.prepare('SELECT * FROM payment_identities WHERE normalized_name = ?').get(normalized);
    if (existing) {
      if (existing.display_name !== display) {
        await db.prepare('UPDATE payment_identities SET display_name = ?, updated_at = ? WHERE id = ?')
          .run(display, nowIso(), existing.id);
        return { ...existing, display_name: display };
      }
      return existing;
    }
    const now = nowIso();
    try {
      const result = await db.prepare(`
        INSERT INTO payment_identities (normalized_name, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(normalized, display, now, now);
      return await db.prepare('SELECT * FROM payment_identities WHERE id = ?').get(result.lastInsertRowid);
    } catch (error) {
      if (!/unique/i.test(String(error.message || ''))) throw error;
      return await db.prepare('SELECT * FROM payment_identities WHERE normalized_name = ?').get(normalized);
    }
  }

  async function listPaymentIdentityEvidence(paymentIdentityId) {
    if (!paymentIdentityId) return [];
    return await db.prepare(`
      SELECT * FROM payment_identity_player_evidence
      WHERE payment_identity_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(paymentIdentityId);
  }

  async function recordPaymentIdentityEvidence({
    paymentIdentityId,
    contactId,
    evidenceKind,
    paymentEventId = null,
    actorTelegramUserId = null,
    relationship = 'payer'
  }) {
    const now = nowIso();
    await db.prepare(`
      INSERT INTO payment_identity_player_evidence (
        payment_identity_id, contact_id, relationship, evidence_kind,
        payment_event_id, actor_telegram_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentIdentityId,
      contactId,
      relationship,
      evidenceKind,
      paymentEventId,
      actorTelegramUserId || null,
      now
    );
  }

  async function recordPaymentDecision({
    paymentEventId,
    paymentIdentityId = null,
    payerContactId = null,
    recipientContactId = null,
    windowId = null,
    classification,
    evidence = [],
    confidenceModeOn = false,
    decisionType,
    actorTelegramUserId = null,
    appbegStatus = null
  }) {
    const now = nowIso();
    await db.prepare(`
      INSERT INTO payment_decisions (
        payment_event_id, payment_identity_id, payer_contact_id, recipient_contact_id,
        window_id, classification, evidence_json, confidence_mode_on, decision_type,
        actor_telegram_user_id, appbeg_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentEventId,
      paymentIdentityId,
      payerContactId,
      recipientContactId,
      windowId,
      classification,
      JSON.stringify(evidence || []),
      confidenceModeOn ? 1 : 0,
      decisionType,
      actorTelegramUserId,
      appbegStatus,
      now
    );
  }

  async function listPaymentDecisions(paymentEventId, limit = 50) {
    return await db.prepare(`
      SELECT * FROM payment_decisions
      WHERE payment_event_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(paymentEventId, Math.min(Math.max(Number(limit) || 50, 1), 200));
  }

  async function findRegisteredRoyalVipPlayerByUsername(username, { coadminUid = null } = {}) {
    const normalized = normalizeAppBegUsername(username);
    if (!normalized) return null;
    const rows = await db.prepare(`
      SELECT
        u.*,
        COALESCE(cas.registration_info_json, '{}') AS registration_info_json
      FROM telegram_users u
      LEFT JOIN contact_automation_state cas ON cas.telegram_user_id = u.id
      WHERE u.registration_status = 'Registered'
        AND TRIM(COALESCE(u.telegram_id, '')) != ''
    `).all();
    for (const row of rows) {
      const info = parseJsonField(row.registration_info_json, {});
      const playerUsername = normalizeAppBegUsername(
        info.preferred_appbeg_username || info.appbeg_username || row.appbeg_account_id
      );
      if (playerUsername !== normalized) continue;
      if (coadminUid) {
        const playerCoadmin = String(info.appbeg_coadmin_uid || info.created_by_coadmin_uid || '').trim();
        if (playerCoadmin && playerCoadmin !== String(coadminUid).trim()) continue;
      }
      return {
        ...row,
        registration_info: info,
        royal_vip_username: info.preferred_appbeg_username || info.appbeg_username || null
      };
    }
    return null;
  }

  async function getStaffTopicForContact(contactId) {
    return await db.prepare('SELECT * FROM telegram_staff_topics WHERE contact_id = ?').get(contactId);
  }

  async function getStaffTopicByThread(staffGroupId, messageThreadId) {
    return await db.prepare(`
      SELECT * FROM telegram_staff_topics
      WHERE staff_group_id = ? AND message_thread_id = ?
    `).get(String(staffGroupId), Number(messageThreadId));
  }

  async function upsertStaffTopic({
    contactId,
    telegramUserId,
    staffGroupId,
    messageThreadId,
    topicName = null
  }) {
    const now = nowIso();
    const existing = await getStaffTopicForContact(contactId);
    if (existing) {
      await db.prepare(`
        UPDATE telegram_staff_topics
        SET telegram_user_id = ?, staff_group_id = ?, message_thread_id = ?,
            topic_name = COALESCE(?, topic_name), last_error = NULL, last_error_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(String(telegramUserId), String(staffGroupId), Number(messageThreadId), topicName, now, existing.id);
      return await getStaffTopicForContact(contactId);
    }
    try {
      await db.prepare(`
        INSERT INTO telegram_staff_topics (
          contact_id, telegram_user_id, staff_group_id, message_thread_id, topic_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(contactId, String(telegramUserId), String(staffGroupId), Number(messageThreadId), topicName, now, now);
    } catch (error) {
      const raced = await getStaffTopicForContact(contactId);
      if (raced) return raced;
      throw error;
    }
    return await getStaffTopicForContact(contactId);
  }

  async function markStaffTopicError(contactId, errorMessage) {
    const now = nowIso();
    await db.prepare(`
      UPDATE telegram_staff_topics
      SET last_error = ?, last_error_at = ?, updated_at = ?
      WHERE contact_id = ?
    `).run(String(errorMessage || '').slice(0, 500), now, now, contactId);
  }

  async function findStaffForwardByGroupMessage(contactId, staffGroupMessageId) {
    const messageId = Number(staffGroupMessageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return null;
    const needle = `%"staffGroupMessageId":${messageId}%`;
    return await db.prepare(`
      SELECT id, telegram_message_id, payload_json
      FROM messages
      WHERE telegram_user_id = ?
        AND direction = 'outgoing'
        AND sender_type = 'staff'
        AND payload_json LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `).get(contactId, needle);
  }

  async function cancelDepositWindow({ contactId, windowId }) {
    const id = Number(windowId);
    const requesterId = Number(contactId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(requesterId) || requesterId <= 0) {
      return { ok: false, reason: 'invalid_ids' };
    }
    const current = await getRegistrationPaymentWindow(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (Number(current.contact_id) !== requesterId && Number(current.requester_contact_id) !== requesterId) {
      return { ok: false, reason: 'stale_window' };
    }
    if (String(current.status || '').toLowerCase() === 'cancelled') {
      const newer = await db.prepare(`
        SELECT id FROM registration_payment_windows
        WHERE contact_id = ? AND status = 'active' AND COALESCE(flow_type, 'registration') = 'deposit'
          AND expires_at > ? AND matched_payment_event_id IS NULL
          AND id != ?
        ORDER BY id DESC LIMIT 1
      `).get(requesterId, nowIso(), id);
      if (newer) {
        return { ok: false, reason: 'stale_window', window: current };
      }
      return { ok: true, reason: 'already_cancelled', window: current };
    }
    if (String(current.status || '').toLowerCase() !== 'active') {
      return { ok: false, reason: 'not_active', window: current };
    }
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE registration_payment_windows
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND contact_id = ? AND status = 'active'
    `).run(now, id, requesterId);
    if (!result.changes) {
      const refreshed = await getRegistrationPaymentWindow(id);
      if (String(refreshed?.status || '').toLowerCase() === 'cancelled') {
        return { ok: true, reason: 'already_cancelled', window: refreshed };
      }
      return { ok: false, reason: 'stale_window', window: refreshed };
    }
    return { ok: true, reason: 'cancelled', window: await getRegistrationPaymentWindow(id) };
  }

  async function listUnmatchedPaymentsForIdentity(normalizedName, { limit = 5 } = {}) {
    if (!normalizedName) return [];
    const rows = await db.prepare(`
      SELECT *
      FROM payment_events
      WHERE routing_status IN ('unmatched', 'needs_confirmation', 'ambiguous', 'searching', 'unrouted')
        AND registration_payment_window_id IS NULL
        AND TRIM(COALESCE(parsed_sender_name, '')) != ''
      ORDER BY message_date DESC, id DESC
      LIMIT 50
    `).all();
    return rows
      .filter((row) => normalizePaymentName(row.parsed_sender_name) === normalizedName)
      .slice(0, Math.min(Math.max(Number(limit) || 5, 1), 20));
  }

  async function claimFreeplayDecision({
    requestId,
    decision,
    amount = null,
    actorTelegramUserId,
    actorName = null
  }) {
    const id = Number(requestId);
    const actorId = normalizeTelegramUserId(actorTelegramUserId);
    if (!Number.isInteger(id) || id <= 0 || !actorId) {
      return { ok: false, reason: 'invalid_claim' };
    }
    if (![FREEPLAY_DECISION.APPROVED, FREEPLAY_DECISION.DECLINED].includes(decision)) {
      return { ok: false, reason: 'invalid_decision' };
    }
    const now = nowIso();
    const terminal = decision === FREEPLAY_DECISION.DECLINED;
    const result = await db.prepare(`
      UPDATE support_requests
      SET decision = ?,
          decided_amount = ?,
          decided_by_telegram_user_id = ?,
          decided_by_name = ?,
          decided_at = ?,
          issuance_status = CASE WHEN ? = 'approved' THEN 'pending' ELSE issuance_status END,
          status = ?,
          completed_by_telegram_user_id = ?,
          completed_by_name = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
        AND kind = 'freeplay'
        AND status IN ('pending', 'claimed')
        AND (decision IS NULL OR decision = '')
    `).run(
      decision,
      amount,
      actorId,
      actorName,
      now,
      decision,
      terminal ? 'completed' : 'claimed',
      terminal ? actorId : null,
      terminal ? actorName : null,
      terminal ? now : null,
      now,
      id
    );
    const row = await db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id);
    if (!result.changes) {
      return {
        ok: false,
        reason: row?.decision ? 'already_resolved' : 'not_found',
        request: row
      };
    }
    return { ok: true, request: row };
  }

  async function updateFreeplayIssuance(requestId, { issuanceStatus, issuanceError = null }) {
    const now = nowIso();
    await db.prepare(`
      UPDATE support_requests
      SET issuance_status = ?, issuance_error = ?, updated_at = ?
      WHERE id = ?
    `).run(issuanceStatus || null, issuanceError, now, requestId);
    return await db.prepare('SELECT * FROM support_requests WHERE id = ?').get(requestId);
  }

  async function beginFreeplayIssuance(requestId, { recoverIssuing = false } = {}) {
    const id = Number(requestId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid_request' };
    const now = nowIso();
    const allowed = recoverIssuing
      ? [
          FREEPLAY_ISSUANCE_STATUS.PENDING,
          FREEPLAY_ISSUANCE_STATUS.FAILED,
          FREEPLAY_ISSUANCE_STATUS.UNAVAILABLE,
          FREEPLAY_ISSUANCE_STATUS.ISSUING
        ]
      : [
          FREEPLAY_ISSUANCE_STATUS.PENDING,
          FREEPLAY_ISSUANCE_STATUS.FAILED,
          FREEPLAY_ISSUANCE_STATUS.UNAVAILABLE
        ];
    const placeholders = allowed.map(() => '?').join(', ');
    const result = await db.prepare(`
      UPDATE support_requests
      SET issuance_status = ?, updated_at = ?
      WHERE id = ?
        AND kind = 'freeplay'
        AND decision = ?
        AND (issuance_status IS NULL OR issuance_status IN (${placeholders}))
    `).run(
      FREEPLAY_ISSUANCE_STATUS.ISSUING,
      now,
      id,
      FREEPLAY_DECISION.APPROVED,
      ...allowed
    );
    const request = await db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id);
    if (!result.changes) {
      return {
        ok: false,
        reason: request?.decision === FREEPLAY_DECISION.GIVEN ? 'already_issued' : 'issuance_locked',
        request
      };
    }
    return { ok: true, request };
  }

  async function markFreeplayGiven(requestId) {
    const id = Number(requestId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid_request' };
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE support_requests
      SET decision = ?,
          issuance_status = ?,
          issuance_error = NULL,
          status = 'completed',
          completed_by_telegram_user_id = decided_by_telegram_user_id,
          completed_by_name = decided_by_name,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
        AND kind = 'freeplay'
        AND decision = ?
        AND issuance_status = ?
    `).run(
      FREEPLAY_DECISION.GIVEN,
      FREEPLAY_ISSUANCE_STATUS.ISSUED,
      now,
      now,
      id,
      FREEPLAY_DECISION.APPROVED,
      FREEPLAY_ISSUANCE_STATUS.ISSUING
    );
    const request = await db.prepare('SELECT * FROM support_requests WHERE id = ?').get(id);
    if (!result.changes) {
      return {
        ok: false,
        reason: request?.decision === FREEPLAY_DECISION.GIVEN ? 'already_issued' : 'not_issuable',
        request
      };
    }
    return { ok: true, request };
  }

  async function listPendingFreeplayRequests(limit = 50) {
    return await db.prepare(`
      SELECT * FROM support_requests
      WHERE kind = 'freeplay'
        AND status IN ('pending', 'claimed')
        AND (decision IS NULL OR decision = '')
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }

  async function listPendingReviewPayments(limit = 20) {
    return await db.prepare(`
      SELECT * FROM payment_events
      WHERE routing_status IN (
        'unmatched', 'needs_confirmation', 'ambiguous', 'searching',
        'unrouted', 'frozen', 'credit_failed', 'manual_review'
      )
      ORDER BY message_date DESC, id DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 20, 1), 50));
  }

  async function listUnmatchedPaymentsForPayer(contactId, { limit = 5 } = {}) {
    const id = Number(contactId);
    if (!Number.isInteger(id) || id <= 0) return [];
    const identities = await db.prepare(`
      SELECT DISTINCT payment_identity_id
      FROM payment_identity_player_evidence
      WHERE contact_id = ?
    `).all(id);
    const found = [];
    const seen = new Set();
    for (const row of identities) {
      const identity = await db.prepare('SELECT * FROM payment_identities WHERE id = ?').get(row.payment_identity_id);
      const matches = await listUnmatchedPaymentsForIdentity(identity?.normalized_name, { limit: 10 });
      for (const payment of matches) {
        if (seen.has(payment.id)) continue;
        seen.add(payment.id);
        found.push(payment);
      }
    }
    return found.slice(0, Math.min(Math.max(Number(limit) || 5, 1), 20));
  }

  async function findActiveDepositWindowForAssignment({ recipientContactId, payerContactId = null } = {}) {
    const recipientId = Number(recipientContactId);
    const payerId = Number(payerContactId || 0) || null;
    if (!Number.isInteger(recipientId) || recipientId <= 0) return null;
    const rows = await db.prepare(`
      SELECT * FROM registration_payment_windows
      WHERE status = 'active'
        AND COALESCE(flow_type, 'registration') = 'deposit'
        AND expires_at > ?
        AND matched_payment_event_id IS NULL
        AND (
          recipient_contact_id = ?
          OR contact_id = ?
          OR requester_contact_id = ?
        )
      ORDER BY id DESC
    `).all(nowIso(), recipientId, recipientId, recipientId);
    return rows.find((row) => {
      const windowRecipient = Number(row.recipient_contact_id || row.contact_id);
      const windowRequester = Number(row.requester_contact_id || row.contact_id);
      if (windowRecipient !== recipientId) return false;
      if (payerId && windowRequester !== payerId && windowRequester !== recipientId) return false;
      return true;
    }) || rows.find((row) => Number(row.recipient_contact_id || row.contact_id) === recipientId) || null;
  }

  async function createStaffAssignmentWindow({
    payerContactId,
    recipientContactId,
    actorTelegramUserId = null
  }) {
    const recipientId = Number(recipientContactId);
    const payerId = Number(payerContactId);
    const knownPayerId = Number.isInteger(payerId) && payerId > 0 ? payerId : null;
    if (!Number.isInteger(recipientId) || recipientId <= 0) {
      throw new Error('Recipient is required for staff assignment.');
    }
    const recipient = await getUserProfile(recipientId);
    if (!recipient) throw new Error('Recipient contact not found.');
    const payer = knownPayerId ? await getUserProfile(knownPayerId) : null;
    if (knownPayerId && !payer) throw new Error('Payer contact not found.');
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await db.prepare(`
      INSERT INTO registration_payment_windows (
        contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
        payment_display_name, first_deposit_amount, expected_payment_cents,
        flow_type, status, expires_at, created_at, updated_at,
        requester_contact_id, recipient_contact_id, recipient_player_uid, recipient_username
      ) VALUES (?, ?, NULL, NULL, NULL, 0, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recipientId,
      String(recipient.telegram_id || actorTelegramUserId || ''),
      PAYMENT_WINDOW_FLOW.STAFF_ASSIGNMENT,
      expiresAt,
      now,
      now,
      knownPayerId,
      recipientId,
      recipient.appbeg_account_id || null,
      recipient.username || null
    );
    return await getRegistrationPaymentWindow(result.lastInsertRowid);
  }

  async function backfillLegacyPaymentIdentityEvidence({ limit = 500 } = {}) {
    const rows = await db.prepare(`
      SELECT w.id AS window_id, w.contact_id, w.payment_display_name, w.matched_payment_event_id
      FROM registration_payment_windows w
      WHERE w.status IN ('completed', 'matched')
        AND w.matched_payment_event_id IS NOT NULL
        AND TRIM(COALESCE(w.payment_display_name, '')) != ''
      ORDER BY w.id ASC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 500, 1), 5000));
    let created = 0;
    for (const row of rows) {
      const identity = await ensurePaymentIdentity(row.payment_display_name);
      if (!identity) continue;
      const existing = await db.prepare(`
        SELECT id FROM payment_identity_player_evidence
        WHERE payment_identity_id = ? AND contact_id = ? AND evidence_kind = ?
        LIMIT 1
      `).get(identity.id, row.contact_id, LEGACY_EVIDENCE_KIND);
      if (existing) continue;
      await recordPaymentIdentityEvidence({
        paymentIdentityId: identity.id,
        contactId: row.contact_id,
        evidenceKind: LEGACY_EVIDENCE_KIND,
        paymentEventId: row.matched_payment_event_id,
        actorTelegramUserId: 'system'
      });
      created += 1;
    }
    return { created, scanned: rows.length };
  }

  Object.assign(store, {
    getActiveOperationalRole,
    listActiveOperationalRoles,
    listOperationalRoleHistory,
    bootstrapRootAdminFromEnv,
    inspectRootAdminBinding,
    grantOperationalRole,
    revokeOperationalRole,
    getConfidenceMode,
    setConfidenceMode,
    getHubStorefrontState,
    saveHubStorefrontState,
    getControlCenterState,
    saveControlCenterState,
    ensurePaymentIdentity,
    listPaymentIdentityEvidence,
    recordPaymentIdentityEvidence,
    recordPaymentDecision,
    listPaymentDecisions,
    findRegisteredRoyalVipPlayerByUsername,
    getStaffTopicForContact,
    getStaffTopicByThread,
    upsertStaffTopic,
    markStaffTopicError,
    findStaffForwardByGroupMessage,
    cancelDepositWindow,
    listUnmatchedPaymentsForIdentity,
    claimFreeplayDecision,
    updateFreeplayIssuance,
    beginFreeplayIssuance,
    markFreeplayGiven,
    listPendingFreeplayRequests,
    listPendingReviewPayments,
    listUnmatchedPaymentsForPayer,
    findActiveDepositWindowForAssignment,
    createStaffAssignmentWindow,
    backfillLegacyPaymentIdentityEvidence
  });
  return store;
}
