import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDatabaseConfig } from './config.js';
import { createDriver } from './drivers/index.js';
import { migratePostgres } from './migrate-postgres.js';
import { normalizeAppBegUsername, normalizePaymentTag, parseJsonField } from '../registration/utils.js';
import {
  buildDuplicateIndex,
  enrichPlayer,
  computePlayerStats,
  playerMatchesFilter,
  playerMatchesQuery
} from '../registration/playerModel.js';
import { PROFILE_PHOTOS_ENABLED } from '../config/profilePhotos.js';
import {
  normalizeCustomerMessage,
  selectBestTrainingMatch
} from '../telegram/supportAiTrainingRetrieval.js';
import { depositWindowMinutes } from '../payments/constants.js';
import {
  CONVERSATION_STATUSES,
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_QUICK_REPLIES,
  DEFAULT_TAGS,
  REGISTRATION_STATUSES
} from './defaults.js';
import { createQueryHelpers } from './query-helpers.js';
import { normalizeBool, previewUrlFromFilePath, slugifyPaymentMethodKey } from '../payments/methodUtils.js';
import { normalizeAutoRegistrationBotSettings, isMessageAfterBotResumeCheckpoint } from '../telegram/autoRegistrationBot.js';
import { isCustomerSupportAiConfigured } from '../telegram/customerSupportAiConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'schema.sql');

export { REGISTRATION_STATUSES, CONVERSATION_STATUSES, DEFAULT_TAGS, DEFAULT_QUICK_REPLIES, DEFAULT_AUTOMATION_RULES } from './defaults.js';

function pickRowValue(row, key) {
  if (!row) return undefined;
  if (row[key] !== undefined) return row[key];
  const lower = key.toLowerCase();
  if (row[lower] !== undefined) return row[lower];
  return undefined;
}

function normalizeAggregateStats(row, keys) {
  const normalized = {};
  for (const key of keys) {
    const raw = pickRowValue(row, key);
    normalized[key] = Number(raw ?? 0) || 0;
  }
  return normalized;
}

export async function createDataStore(config = resolveDatabaseConfig()) {
  const driver = await createDriver(config);
  const db = driver;
  if (config.dialect === 'postgres') {
    await migratePostgres(driver);
  } else {
    await migrate(driver);
  }

  const sql = createQueryHelpers(config.dialect);

  const nowIso = () => new Date().toISOString();

  function calculateEditDistancePercent(original = '', final = '') {
    const a = String(original || '').trim();
    const b = String(final || '').trim();
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 0;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let lastDiagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const temp = previous[j];
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          lastDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        lastDiagonal = temp;
      }
    }
    return Math.round((previous[b.length] / maxLen) * 10000) / 100;
  }

  function normalizeDisplayName(user) {
    const parts = [user.first_name, user.last_name].filter(Boolean);
    if (parts.length) return parts.join(' ');
    if (user.username) return `@${user.username}`;
    return `Telegram ${user.telegram_id ?? user.id}`;
  }

  async function logEvent({ telegramUserId, eventType, title, body = null, actorName = 'System', metadata = null, createdAt = nowIso() }) {
    await db.prepare(`
      INSERT INTO activity_events (telegram_user_id, event_type, title, body, actor_name, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(telegramUserId, eventType, title, body, actorName, metadata ? JSON.stringify(metadata) : null, createdAt);
  }

  async function upsertTelegramUser(rawUser, seenAt = nowIso()) {
    const telegramId = rawUser.telegram_id ?? rawUser.id;
    if (!telegramId) throw new Error('Telegram user is missing an id.');
    const existing = await db.prepare('SELECT * FROM telegram_users WHERE telegram_id = ?').get(telegramId);
    const displayName = normalizeDisplayName({ ...rawUser, telegram_id: telegramId });

    if (existing) {
      await db.prepare(`
        UPDATE telegram_users
        SET username = ?, first_name = ?, last_name = ?, display_name = ?,
            language_code = ?, phone_number = COALESCE(?, phone_number),
            presence_status = COALESCE(?, presence_status),
            last_online_at = COALESCE(?, last_online_at),
            is_bot = ?, last_seen = ?, updated_at = ?
        WHERE telegram_id = ?
      `).run(
        rawUser.username ?? null,
        rawUser.first_name ?? null,
        rawUser.last_name ?? null,
        displayName,
        rawUser.language_code ?? null,
        rawUser.phone_number ?? rawUser.phone ?? null,
        rawUser.presence_status ?? null,
        rawUser.last_online_at ?? null,
        Boolean(rawUser.is_bot),
        seenAt,
        seenAt,
        telegramId
      );
      return await db.prepare('SELECT * FROM telegram_users WHERE telegram_id = ?').get(telegramId);
    }

    const result = await db.prepare(`
      INSERT INTO telegram_users (
        telegram_id, username, first_name, last_name, display_name, language_code,
        phone_number, presence_status, last_online_at, is_bot, first_seen, last_seen, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      telegramId,
      rawUser.username ?? null,
      rawUser.first_name ?? null,
      rawUser.last_name ?? null,
      displayName,
      rawUser.language_code ?? null,
      rawUser.phone_number ?? rawUser.phone ?? null,
      rawUser.presence_status ?? null,
      rawUser.last_online_at ?? null,
      Boolean(rawUser.is_bot),
      seenAt,
      seenAt,
      seenAt
    );

    await logEvent({
      telegramUserId: result.lastInsertRowid,
      eventType: 'user_created',
      title: 'User Created',
      body: 'Telegram user profile was created from a private bot interaction.',
      createdAt: seenAt
    });

    await assignCoadminToUser(result.lastInsertRowid, 'System');

    return await db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(result.lastInsertRowid);
  }

  async function ensureConversation(userId, activityAt = nowIso()) {
    await db.prepare(`
      INSERT INTO conversations (telegram_user_id, first_message_at, last_message_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_user_id, channel) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(userId, activityAt, activityAt, activityAt);
    return await db.prepare("SELECT * FROM conversations WHERE telegram_user_id = ? AND channel = 'telegram_private'").get(userId);
  }

  async function storeIncomingTelegramMessage(ctx) {
    const message = ctx.message;
    const from = message.from;
    const sentAt = message.date ? new Date(message.date * 1000).toISOString() : nowIso();
    const user = await upsertTelegramUser(from, sentAt);
    const existingMessageCount = (await db.prepare('SELECT COUNT(*) AS count FROM messages WHERE telegram_user_id = ?').get(user.id)).count;
    const conversation = await ensureConversation(user.id, sentAt);
    const messageType = message.text ? 'text' : Object.keys(message).find((key) => !['message_id', 'from', 'chat', 'date'].includes(key)) ?? 'unknown';
    const text = message.text ?? message.caption ?? '';

    const result = await db.prepare(sql.insertOrIgnore(`
      INSERT OR IGNORE INTO messages (
        conversation_id, telegram_user_id, telegram_message_id, direction, sender_type,
        message_type, text, payload_json, sent_at
      )
      VALUES (?, ?, ?, 'incoming', 'telegram_user', ?, ?, ?, ?)
    `) + sql.messageUpsertSuffix()).run(conversation.id, user.id, message.message_id, messageType, text, JSON.stringify(message), sentAt);

    await db.prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?').run(sentAt, nowIso(), conversation.id);

    if (result.changes > 0) {
      await logEvent({
        telegramUserId: user.id,
        eventType: 'incoming_message',
        title: 'Incoming Message',
        body: text || `[${messageType}]`,
        metadata: { conversationId: conversation.id, telegramMessageId: message.message_id },
        createdAt: sentAt
      });

      if (existingMessageCount === 0) {
        await logEvent({
          telegramUserId: user.id,
          eventType: 'first_message',
          title: 'First Message',
          body: text || `[${messageType}]`,
          createdAt: sentAt
        });
      }
    }

    return { user, conversation, inserted: result.changes > 0, firstMessage: result.changes > 0 && existingMessageCount === 0 };
  }

  async function storeOutgoingMessage({ telegramUserId, telegramMessageId, text, payload, senderType = 'staff', staffName = 'Staff', messageType = 'text', source = 'bot_api', sentAt = nowIso() }) {
    const user = await db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(telegramUserId);
    if (!user) throw new Error('Telegram user not found.');
    const conversation = await ensureConversation(user.id, sentAt);

    const result = await db.prepare(sql.insertOrIgnore(`
      INSERT OR IGNORE INTO messages (
        conversation_id, telegram_user_id, telegram_message_id, source, direction, sender_type,
        message_type, text, payload_json, sent_at
      )
      VALUES (?, ?, ?, ?, 'outgoing', ?, ?, ?, ?, ?)
    `) + sql.messageUpsertSuffix()).run(conversation.id, user.id, telegramMessageId ?? null, source, senderType, messageType, text, payload ? JSON.stringify(payload) : null, sentAt);

    await db.prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?').run(sentAt, nowIso(), conversation.id);
    let messageId = result.changes > 0 ? result.lastInsertRowid : null;
    if (result.changes > 0 && !messageId && telegramMessageId != null) {
      const insertedMessage = await db.prepare(`
        SELECT id
        FROM messages
        WHERE conversation_id = ?
          AND telegram_user_id = ?
          AND telegram_message_id = ?
          AND source = ?
          AND direction = 'outgoing'
        ORDER BY id DESC
        LIMIT 1
      `).get(conversation.id, user.id, telegramMessageId, source);
      messageId = insertedMessage?.id ?? null;
    }

    if (result.changes > 0) {
      await logEvent({
        telegramUserId: user.id,
        eventType: 'outgoing_message',
        title: 'Outgoing Message',
        body: text,
        actorName: senderType === 'staff' ? staffName : senderType === 'bot' ? 'Bot' : senderType,
        metadata: { conversationId: conversation.id, telegramMessageId, messageType, source },
        createdAt: sentAt
      });
    }
    return { user, conversation, inserted: result.changes > 0, messageId };
  }

  async function claimOutgoingMessageRequest({ telegramUserId, clientRequestId }) {
    if (!clientRequestId) return { claimed: true, existing: null };
    const insert = await db.prepare(sql.insertOrIgnore(`
      INSERT OR IGNORE INTO outgoing_message_requests (client_request_id, telegram_user_id, created_at)
      VALUES (?, ?, ?)
    `) + (sql.isPostgres ? ' ON CONFLICT (client_request_id, telegram_user_id) DO NOTHING' : '')).run(clientRequestId, telegramUserId, nowIso());
    if (insert.changes > 0) {
      return { claimed: true, existing: null };
    }
    const existing = await db.prepare(`
      SELECT *
      FROM outgoing_message_requests
      WHERE client_request_id = ? AND telegram_user_id = ?
    `).get(clientRequestId, telegramUserId);
    return { claimed: false, existing: existing || null };
  }

  async function completeOutgoingMessageRequest({ telegramUserId, clientRequestId, response, messageId = null }) {
    if (!clientRequestId) return;
    await db.prepare(`
      UPDATE outgoing_message_requests
      SET response_json = ?, message_id = ?, completed_at = ?
      WHERE client_request_id = ? AND telegram_user_id = ?
    `).run(JSON.stringify(response), messageId, nowIso(), clientRequestId, telegramUserId);
  }

  async function releaseOutgoingMessageRequest({ telegramUserId, clientRequestId }) {
    if (!clientRequestId) return;
    await db.prepare(`
      DELETE FROM outgoing_message_requests
      WHERE client_request_id = ? AND telegram_user_id = ? AND response_json IS NULL
    `).run(clientRequestId, telegramUserId);
  }

  async function queueTelegramOutboundMessage({
    contactId,
    telegramUserId,
    body,
    buttons = [],
    localMessageId = null,
    clientRequestId = null,
    mediaPath = null,
    messageType = 'text'
  }) {
    const now = nowIso();
    const normalizedButtons = Array.isArray(buttons)
      ? buttons.map((row) => (Array.isArray(row) ? row : [row]).map((button) => ({
        text: button?.text || button?.label || 'Button',
        data: button?.data || button?.action || button?.callback_data || 'noop',
        label: button?.label || button?.text || 'Button',
        action: button?.action || button?.data || button?.callback_data || 'noop'
      })))
      : [];
    const result = await db.prepare(`
      INSERT INTO telegram_outbound_messages (
        contact_id, telegram_user_id, body, buttons_json, media_path, message_type, status,
        local_message_id, client_request_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      contactId,
      String(telegramUserId),
      body,
      JSON.stringify(normalizedButtons),
      mediaPath || null,
      messageType || 'text',
      localMessageId,
      clientRequestId || null,
      now,
      now
    );
    const buttonCount = normalizedButtons.reduce((sum, row) => sum + row.length, 0);
    if (buttonCount) {
      console.log(`[telegram-outbound] welcome_buttons_queued contact=${contactId} buttons=${buttonCount}`);
    }
    return {
      id: result.lastInsertRowid,
      contactId,
      telegramUserId: String(telegramUserId),
      body,
      buttons: normalizedButtons,
      status: 'pending',
      localMessageId,
      clientRequestId: clientRequestId || null
    };
  }

  async function setTelegramOutboundLocalMessage(outboundId, localMessageId) {
    await db.prepare(`
      UPDATE telegram_outbound_messages
      SET local_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(localMessageId, nowIso(), outboundId);
  }

  async function findExistingBotJobForTelegramMessage({ contactId, incomingTelegramMessageId, jobType = 'inbound_message' }) {
    if (incomingTelegramMessageId == null || incomingTelegramMessageId === '') return null;
    return await db.prepare(`
      SELECT *
      FROM bot_jobs
      WHERE contact_id = ?
        AND job_type = ?
        AND incoming_telegram_message_id = ?
        AND status IN ('pending', 'processing', 'completed')
      ORDER BY id DESC
      LIMIT 1
    `).get(contactId, jobType, incomingTelegramMessageId);
  }

  async function createBotJob({
    contactId,
    telegramUserId,
    messageId = null,
    incomingTelegramMessageId = null,
    jobType = 'inbound_message',
    inputText = '',
    action = null
  }) {
    // Dedupe by Telegram message_id so the same inbound event cannot create duplicate replies.
    // Different message_ids for the same contact must each get their own job.
    if (jobType === 'inbound_message' && incomingTelegramMessageId != null && incomingTelegramMessageId !== '') {
      const existing = await findExistingBotJobForTelegramMessage({
        contactId,
        incomingTelegramMessageId,
        jobType
      });
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }

    const now = nowIso();
    const result = await db.prepare(`
      INSERT INTO bot_jobs (
        contact_id, telegram_user_id, message_id, incoming_telegram_message_id,
        job_type, input_text, action, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      contactId,
      String(telegramUserId),
      messageId,
      incomingTelegramMessageId,
      jobType,
      inputText || null,
      action || null,
      now,
      now
    );
    return await db.prepare('SELECT * FROM bot_jobs WHERE id = ?').get(result.lastInsertRowid);
  }

  async function nudgeBotQueue(jobId) {
    await db.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ('bot_jobs:nudge', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(jobId || Date.now()), nowIso());
  }

  async function reclaimStuckBotJobs({ olderThanMs = Number(process.env.CHATBOT_STUCK_JOB_MS || 120000) } = {}) {
    const cutoff = new Date(Date.now() - Math.max(5000, olderThanMs)).toISOString();
    const result = await db.prepare(`
      UPDATE bot_jobs
      SET status = 'pending',
          worker_id = NULL,
          claimed_at = NULL,
          error_text = COALESCE(error_text, 'Reclaimed stuck processing job'),
          updated_at = ?
      WHERE status = 'processing'
        AND COALESCE(claimed_at, created_at) < ?
    `).run(nowIso(), cutoff);
    return result.changes || 0;
  }

  async function claimNextBotJob(workerId) {
    await reclaimStuckBotJobs();
    const now = nowIso();
    const candidate = await db.prepare(`
      SELECT id
      FROM bot_jobs
      WHERE status = 'pending'
        AND contact_id NOT IN (
          SELECT contact_id FROM bot_jobs WHERE status = 'processing'
        )
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!candidate?.id) return null;

    const updated = await db.prepare(`
      UPDATE bot_jobs
      SET status = 'processing',
          worker_id = ?,
          claimed_at = ?,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(workerId, now, now, candidate.id);

    if (!updated.changes) return null;
    return await db.prepare('SELECT * FROM bot_jobs WHERE id = ?').get(candidate.id);
  }

  async function completeBotJob(jobId, { status = 'completed', errorText = null } = {}) {
    await db.prepare(`
      UPDATE bot_jobs
      SET status = ?,
          error_text = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, errorText, nowIso(), nowIso(), jobId);
  }

  async function resetStuckBotJobs(reason = 'Worker restart') {
    // On restart, re-queue processing jobs instead of failing them forever,
    // so follow-up inbound messages for that contact can run again.
    await db.prepare(`
      UPDATE bot_jobs
      SET status = 'pending',
          worker_id = NULL,
          claimed_at = NULL,
          error_text = COALESCE(error_text, ?),
          updated_at = ?
      WHERE status = 'processing'
    `).run(reason, nowIso());
  }

  async function setBotControl(contactId, {
    botEnabled = null,
    botPaused = null,
    needsStaffReview = null,
    staffReviewReason = null,
    actorName = 'Staff'
  } = {}) {
    const current = await db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(contactId);
    if (!current) throw new Error('Contact not found.');
    const now = nowIso();
    const nextEnabled = botEnabled == null ? Boolean(current.bot_enabled ?? true) : Boolean(botEnabled);
    const nextPaused = botPaused == null ? Boolean(current.bot_paused) : Boolean(botPaused);
    const nextReview = needsStaffReview == null ? Boolean(current.needs_staff_review) : Boolean(needsStaffReview);
    await db.prepare(`
      UPDATE telegram_users
      SET bot_enabled = ?,
          bot_paused = ?,
          needs_staff_review = ?,
          bot_paused_at = ?,
          bot_paused_by = ?,
          staff_review_reason = ?,
          staff_review_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextEnabled,
      nextPaused,
      nextReview,
      nextPaused ? (current.bot_paused_at || now) : null,
      nextPaused ? (current.bot_paused_by || actorName) : null,
      nextReview ? (staffReviewReason || current.staff_review_reason || 'staff_review') : null,
      nextReview ? (current.staff_review_at || now) : null,
      now,
      contactId
    );

    if (botPaused === true) {
      await logEvent({
        telegramUserId: contactId,
        eventType: 'bot_paused',
        title: 'Bot Paused',
        body: 'Staff paused automated replies.',
        actorName,
        metadata: { botPaused: true }
      });
    }
    if (botPaused === false && current.bot_paused) {
      await logEvent({
        telegramUserId: contactId,
        eventType: 'bot_resumed',
        title: 'Bot Resumed',
        body: 'Automated replies resumed.',
        actorName,
        metadata: { botPaused: false }
      });
    }
    return await getUserProfile(contactId);
  }

  async function markBotNeedsStaffReview(contactId, reason = 'handoff', actorName = 'Chatbot') {
    const now = nowIso();
    await db.prepare(`
      UPDATE telegram_users
      SET needs_staff_review = ?,
          bot_paused = ?,
          bot_paused_at = COALESCE(bot_paused_at, ?),
          bot_paused_by = COALESCE(bot_paused_by, ?),
          staff_review_reason = ?,
          staff_review_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(true, true, now, actorName, reason, now, now, contactId);

    await db.prepare(`
      UPDATE conversations
      SET status = 'Waiting', updated_at = ?
      WHERE telegram_user_id = ? AND channel = 'telegram_private'
    `).run(nowIso(), contactId);

    await logEvent({
      telegramUserId: contactId,
      eventType: 'bot_handoff',
      title: 'Bot Handoff Required',
      body: reason,
      actorName,
      metadata: { reason }
    });

    return await getUserProfile(contactId);
  }

  async function findLatestIncomingMessageId(contactId, telegramMessageId = null) {
    if (telegramMessageId != null) {
      const byTelegram = await db.prepare(`
        SELECT id FROM messages
        WHERE telegram_user_id = ?
          AND telegram_message_id = ?
          AND direction = 'incoming'
        ORDER BY id DESC
        LIMIT 1
      `).get(contactId, telegramMessageId);
      if (byTelegram?.id) return byTelegram.id;
    }
    const latest = await db.prepare(`
      SELECT id FROM messages
      WHERE telegram_user_id = ? AND direction = 'incoming'
      ORDER BY sent_at DESC, id DESC
      LIMIT 1
    `).get(contactId);
    return latest?.id || null;
  }

  async function listUsers() {
    return (await db.prepare(`
      SELECT
        u.*,
        COALESCE(stats.total_messages, 0) AS total_messages,
        COALESCE(unread.unread_count, 0) AS unread_count,
        last_msg.text AS last_message,
        last_msg.sent_at AS last_message_at,
        last_msg.direction AS last_message_direction,
        last_msg.sender_type AS last_message_sender_type,
        c.id AS conversation_id,
        c.status AS conversation_status,
        c.assigned_staff_name,
        c.assigned_at,
        c.last_read_at,
        bs.current_screen AS bot_current_screen,
        bs.workflow_key AS bot_workflow_key,
        bs.workflow_step AS bot_workflow_step,
        bs.updated_at AS bot_state_updated_at,
        ${sql.tagsJsonSelect} AS tags_json,
        ${sql.notesTextSelect} AS notes_text
      FROM telegram_users u
      LEFT JOIN conversations c ON c.telegram_user_id = u.id AND c.channel = 'telegram_private'
      LEFT JOIN bot_sessions bs ON bs.telegram_user_id = u.id
      LEFT JOIN (
        SELECT telegram_user_id, COUNT(*) AS total_messages
        FROM messages
        GROUP BY telegram_user_id
      ) stats ON stats.telegram_user_id = u.id
      LEFT JOIN messages last_msg ON last_msg.id = (
        SELECT m.id
        FROM messages m
        WHERE m.telegram_user_id = u.id
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT 1
      )
      LEFT JOIN (
        SELECT
          c2.id AS conversation_id,
          COUNT(m.id) AS unread_count
        FROM conversations c2
        LEFT JOIN messages m
          ON m.conversation_id = c2.id
         AND m.direction = 'incoming'
         AND m.id > COALESCE(c2.last_read_message_id, 0)
        GROUP BY c2.id
      ) unread ON unread.conversation_id = c.id
      ORDER BY u.last_seen DESC, u.id DESC
    `).all()).map(hydrateUser);
  }

  async function getStats() {
    const today = new Date().toISOString().slice(0, 10);
    const firstSeenDay = sql.datePrefixExpr('first_seen');
    const lastSeenDay = sql.datePrefixExpr('last_seen');
    const row = await db.prepare(`
      SELECT
        COUNT(*) AS ${sql.quoteAlias('totalTelegramUsers')},
        SUM(CASE WHEN ${firstSeenDay} = @today THEN 1 ELSE 0 END) AS ${sql.quoteAlias('newToday')},
        SUM(CASE WHEN registration_status = 'Pending' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('pendingRegistration')},
        SUM(CASE WHEN registration_status = 'Registered' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('registeredUsers')},
        SUM(CASE WHEN registration_status = 'Suspended' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('suspendedUsers')},
        SUM(CASE WHEN ${lastSeenDay} = @today THEN 1 ELSE 0 END) AS ${sql.quoteAlias('activeToday')}
      FROM telegram_users
    `).get({ today });

    return normalizeAggregateStats(row, [
      'totalTelegramUsers',
      'newToday',
      'pendingRegistration',
      'registeredUsers',
      'suspendedUsers',
      'activeToday'
    ]);
  }

  async function getUserProfile(id) {
    const user = await db.prepare(`
      SELECT
        u.*,
        COALESCE(stats.total_messages, 0) AS total_messages,
        COALESCE(unread.unread_count, 0) AS unread_count,
        c.id AS conversation_id,
        c.status AS conversation_status,
        c.assigned_staff_name,
        c.assigned_at,
        c.last_read_at,
        bs.current_screen AS bot_current_screen,
        bs.workflow_key AS bot_workflow_key,
        bs.workflow_step AS bot_workflow_step,
        bs.updated_at AS bot_state_updated_at,
        c.first_message_at,
        c.last_message_at,
        ${sql.tagsJsonSelect} AS tags_json
      FROM telegram_users u
      LEFT JOIN conversations c ON c.telegram_user_id = u.id AND c.channel = 'telegram_private'
      LEFT JOIN bot_sessions bs ON bs.telegram_user_id = u.id
      LEFT JOIN (
        SELECT telegram_user_id, COUNT(*) AS total_messages
        FROM messages
        GROUP BY telegram_user_id
      ) stats ON stats.telegram_user_id = u.id
      LEFT JOIN (
        SELECT
          c2.id AS conversation_id,
          COUNT(m.id) AS unread_count
        FROM conversations c2
        LEFT JOIN messages m
          ON m.conversation_id = c2.id
         AND m.direction = 'incoming'
         AND m.id > COALESCE(c2.last_read_message_id, 0)
        GROUP BY c2.id
      ) unread ON unread.conversation_id = c.id
      WHERE u.id = ?
    `).get(id);

    return user ? hydrateUser(user) : null;
  }

  async function listMessagesForUser(id) {
    return await db.prepare(`
      SELECT m.*
      FROM messages m
      WHERE m.telegram_user_id = ?
      ORDER BY m.sent_at ASC, m.id ASC
    `).all(id);
  }

  async function buildConversationContextForTraining(contactId, limit = 8) {
    const rows = await db.prepare(`
      SELECT direction, sender_type, text, message_type, sent_at
      FROM messages
      WHERE telegram_user_id = ?
      ORDER BY sent_at DESC, id DESC
      LIMIT ?
    `).all(contactId, limit);
    return rows.reverse().map((message) => {
      const speaker = message.direction === 'incoming'
        ? 'Customer'
        : message.sender_type === 'staff'
          ? 'Staff'
          : message.sender_type === 'bot'
            ? 'Bot'
            : 'System';
      return `${speaker}: ${message.text || `[${message.message_type || 'message'}]`}`;
    }).join('\n');
  }

  async function getCustomerSupportAiSettings() {
    const existing = await db.prepare('SELECT id FROM coadmin_settings WHERE id = 1').get();
    if (!existing) {
      await db.prepare('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, ?)').run(nowIso());
    }
    const row = await db.prepare(`
      SELECT
        customer_support_ai_mode,
        customer_support_ai_mode_updated_at,
        customer_support_ai_mode_updated_by,
        staff_ai_apprentice_mode_enabled
      FROM coadmin_settings
      WHERE id = 1
    `).get();
    let mode = normalizeContactAiMode(row?.customer_support_ai_mode);
    if (!row?.customer_support_ai_mode && row?.staff_ai_apprentice_mode_enabled === false) {
      mode = 'train';
    }
    return {
      mode,
      configured: isCustomerSupportAiConfigured(),
      updated_at: row?.customer_support_ai_mode_updated_at || null,
      updated_by: row?.customer_support_ai_mode_updated_by || null
    };
  }

  async function setCustomerSupportAiMode(mode, actorName = 'Staff') {
    const current = await getCustomerSupportAiSettings();
    const nextMode = normalizeContactAiMode(mode);
    if (nextMode === current.mode) return current;
    const updatedAt = nowIso();
    await db.prepare(`
      UPDATE coadmin_settings
      SET customer_support_ai_mode = ?,
          customer_support_ai_mode_updated_at = ?,
          customer_support_ai_mode_updated_by = ?,
          staff_ai_apprentice_mode_enabled = ?,
          staff_ai_apprentice_mode_updated_at = ?,
          staff_ai_apprentice_mode_updated_by = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      nextMode,
      updatedAt,
      actorName,
      sql.boolParam(nextMode === 'train'),
      updatedAt,
      actorName,
      updatedAt
    );
    if (nextMode === 'auto') {
      await db.prepare(`
        UPDATE telegram_users
        SET ai_auto_paused = ?,
            updated_at = ?
        WHERE ai_auto_paused = ?
      `).run(sql.boolParam(false), updatedAt, sql.boolParam(true));
    }
    await logSettingsAudit({
      settingsKey: 'customer_support_ai_mode',
      fieldName: 'mode',
      oldValue: current.mode,
      newValue: nextMode,
      actorName
    });
    return await getCustomerSupportAiSettings();
  }

  async function getStaffAiApprenticeSettings() {
    const existing = await db.prepare('SELECT id FROM coadmin_settings WHERE id = 1').get();
    if (!existing) {
      await db.prepare('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, ?)').run(nowIso());
    }
    const row = await db.prepare(`
      SELECT
        staff_ai_apprentice_mode_enabled,
        staff_ai_apprentice_mode_updated_at,
        staff_ai_apprentice_mode_updated_by
      FROM coadmin_settings
      WHERE id = 1
    `).get();
    return {
      enabled: row?.staff_ai_apprentice_mode_enabled === undefined || row?.staff_ai_apprentice_mode_enabled === null
        ? true
        : Boolean(row.staff_ai_apprentice_mode_enabled),
      updated_at: row?.staff_ai_apprentice_mode_updated_at || null,
      updated_by: row?.staff_ai_apprentice_mode_updated_by || null
    };
  }

  function normalizeContactAiMode(value) {
    return String(value || '').trim().toLowerCase() === 'auto' ? 'auto' : 'train';
  }

  function hydrateContactAiSettings(user = {}) {
    return {
      mode: normalizeContactAiMode(user.ai_mode),
      auto_paused: Boolean(user.ai_auto_paused),
      updated_at: user.ai_mode_updated_at || null,
      updated_by: user.ai_mode_updated_by || null
    };
  }

  async function pauseContactAiAuto(contactId, actorName = 'Staff') {
    const globalAi = await getCustomerSupportAiSettings();
    const contact = await db.prepare('SELECT id, ai_auto_paused FROM telegram_users WHERE id = ?').get(contactId);
    if (!contact) throw new Error('Contact not found.');
    if (globalAi.mode !== 'auto' || contact.ai_auto_paused === true) {
      return {
        mode: globalAi.mode,
        auto_paused: contact.ai_auto_paused === true
          || contact.ai_auto_paused === 1
          || contact.ai_auto_paused === '1'
          || contact.ai_auto_paused === 'true',
        updated_at: globalAi.updated_at,
        updated_by: globalAi.updated_by
      };
    }
    const updatedAt = nowIso();
    await db.prepare(`
      UPDATE telegram_users
      SET ai_auto_paused = ?,
          ai_mode_updated_at = ?,
          ai_mode_updated_by = ?,
          updated_at = ?
      WHERE id = ?
    `).run(sql.boolParam(true), updatedAt, actorName, updatedAt, contactId);
    return {
      mode: globalAi.mode,
      auto_paused: true,
      updated_at: updatedAt,
      updated_by: actorName
    };
  }

  async function searchApprovedSupportAiTraining({
    customerMessage,
    contactId = null,
    intent = null,
    contactContext = {},
    language = null,
    limit = 5
  }) {
    const normalizedMessage = normalizeCustomerMessage(customerMessage);
    const rows = await db.prepare(`
      SELECT *
      FROM staff_ai_training_examples
      WHERE approved = ${sql.boolTrue}
        AND TRIM(COALESCE(final_staff_reply, staff_reply, '')) != ''
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC, id DESC
      LIMIT 500
    `).all();

    const examples = rows.map(hydrateStaffAiTrainingExample);
    const rejectedExamples = examples.filter((example) => example.ai_reply_rejected);
    if (rejectedExamples.length) {
      console.log(`[support-ai] support_ai_rejected_reply_excluded contact=${contactId || 'global'} count=${rejectedExamples.length}`);
    }

    const result = selectBestTrainingMatch(examples, {
      customerMessage,
      normalizedMessage,
      intent,
      contactContext,
      language,
      contactId,
      limit
    });

    if (result.matchType === 'exact') {
      console.log(`[support-ai] support_ai_exact_training_match_found contact=${contactId || 'global'} example_id=${result.best?.id || 'n/a'} intent=${intent || 'n/a'}`);
    } else if (result.matchType === 'similar') {
      console.log(`[support-ai] support_ai_similar_training_examples_found contact=${contactId || 'global'} count=${result.examples.length} best_id=${result.best?.id || 'n/a'} score=${result.score}`);
    }

    if (result.reply) {
      console.log(`[support-ai] support_ai_training_examples_used contact=${contactId || 'global'} match=${result.matchType} example_id=${result.best?.id || 'n/a'}`);
    }

    return result;
  }

  async function findStaffAiTrainingReply({ contactId, intent, customerMessage, contactContext, language }) {
    if (customerMessage) {
      const result = await searchApprovedSupportAiTraining({
        customerMessage,
        contactId,
        intent,
        contactContext: contactContext || {},
        language,
        limit: 1
      });
      return result.reply || null;
    }
    const normalizedIntent = String(intent || '').trim();
    if (!normalizedIntent) return null;
    const result = await searchApprovedSupportAiTraining({
      customerMessage: '',
      contactId,
      intent: normalizedIntent,
      contactContext: contactContext || {},
      language,
      limit: 1
    });
    return result.reply || null;
  }

  async function setStaffAiApprenticeModeEnabled(enabled, actorName = 'Staff') {
    const current = await getStaffAiApprenticeSettings();
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === current.enabled) return current;
    const updatedAt = nowIso();
    await db.prepare(`
      UPDATE coadmin_settings
      SET staff_ai_apprentice_mode_enabled = ?,
          staff_ai_apprentice_mode_updated_at = ?,
          staff_ai_apprentice_mode_updated_by = ?,
          updated_at = ?
      WHERE id = 1
    `).run(sql.boolParam(nextEnabled), updatedAt, actorName, updatedAt);
    await logSettingsAudit({
      settingsKey: 'staff_ai_apprentice_mode',
      fieldName: 'enabled',
      oldValue: current.enabled ? 'true' : 'false',
      newValue: nextEnabled ? 'true' : 'false',
      actorName
    });
    return await getStaffAiApprenticeSettings();
  }

  async function createStaffAiTrainingDraft({
    contactId,
    telegramUserId = null,
    incomingMessageId = null,
    customerMessage = '',
    conversationContext = null,
    detectedIntent = null,
    detectedEntities = {},
    aiDraftReply = '',
    language = null,
    sentiment = null,
    confidence = null,
    outcome = 'drafted',
    wasRegistered = null,
    registrationStatus = null,
    registrationStep = null,
    paymentWindowStatus = null,
    appbegPlayerUid = null,
    recommendedAction = null,
    actionExecuted = null,
    actionBlockedReason = null
  }) {
    const contact = await db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(contactId);
    if (!contact) throw new Error('Contact not found.');
    const context = conversationContext ?? await buildConversationContextForTraining(contactId);
    const existing = incomingMessageId
      ? await db.prepare(`
        SELECT *
        FROM staff_ai_training_examples
        WHERE contact_id = ?
          AND incoming_message_id = ?
          AND outcome = 'drafted'
        ORDER BY id DESC
        LIMIT 1
      `).get(contactId, incomingMessageId)
      : null;
    const now = nowIso();
    if (existing) {
      await db.prepare(`
        UPDATE staff_ai_training_examples
        SET telegram_user_id = ?,
            customer_message = ?,
            conversation_context = ?,
            conversation_history = ?,
            detected_intent = ?,
            detected_entities_json = ?,
            entities_json = ?,
            ai_draft_reply = ?,
            ai_reply = ?,
            confidence = ?,
            language = ?,
            sentiment = ?,
            was_registered = ?,
            registration_status = ?,
            registration_step = ?,
            payment_window_status = ?,
            appbeg_player_uid = ?,
            recommended_action = ?,
            action_executed = ?,
            action_blocked_reason = ?,
            created_at = ?
        WHERE id = ?
      `).run(
        String(telegramUserId || contact.telegram_id || ''),
        customerMessage || null,
        context || null,
        context || null,
        detectedIntent || null,
        JSON.stringify(detectedEntities || {}),
        JSON.stringify(detectedEntities || {}),
        aiDraftReply || null,
        aiDraftReply || null,
        confidence == null ? null : Number(confidence),
        language || contact.language_code || null,
        sentiment || null,
        wasRegistered == null ? null : sql.boolParam(wasRegistered),
        registrationStatus || null,
        registrationStep || null,
        paymentWindowStatus || null,
        appbegPlayerUid || null,
        recommendedAction || null,
        actionExecuted == null ? null : sql.boolParam(actionExecuted),
        actionBlockedReason || null,
        now,
        existing.id
      );
      return await getStaffAiTrainingExample(existing.id);
    }
    const result = await db.prepare(`
      INSERT INTO staff_ai_training_examples (
        contact_id, telegram_user_id, incoming_message_id, customer_message, conversation_context,
        conversation_history, detected_intent, detected_entities_json, entities_json, ai_draft_reply,
        ai_reply, outcome, confidence, language, sentiment, was_registered, registration_status,
        registration_step, payment_window_status, appbeg_player_uid, recommended_action,
        action_executed, action_blocked_reason, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contactId,
      String(telegramUserId || contact.telegram_id || ''),
      incomingMessageId || null,
      customerMessage || null,
      context || null,
      context || null,
      detectedIntent || null,
      JSON.stringify(detectedEntities || {}),
      JSON.stringify(detectedEntities || {}),
      aiDraftReply || null,
      aiDraftReply || null,
      outcome,
      confidence == null ? null : Number(confidence),
      language || contact.language_code || null,
      sentiment || null,
      wasRegistered == null ? null : sql.boolParam(wasRegistered),
      registrationStatus || null,
      registrationStep || null,
      paymentWindowStatus || null,
      appbegPlayerUid || null,
      recommendedAction || null,
      actionExecuted == null ? null : sql.boolParam(actionExecuted),
      actionBlockedReason || null,
      now
    );
    return await getStaffAiTrainingExample(result.lastInsertRowid);
  }

  async function getStaffAiTrainingExample(id) {
    const row = await db.prepare('SELECT * FROM staff_ai_training_examples WHERE id = ?').get(id);
    return row ? hydrateStaffAiTrainingExample(row) : null;
  }

  async function getLatestStaffAiTrainingDraftForContact(contactId) {
    const latestIncoming = await db.prepare(`
      SELECT id, text
      FROM messages
      WHERE telegram_user_id = ?
        AND direction = 'incoming'
      ORDER BY id DESC, created_at DESC
      LIMIT 1
    `).get(contactId);
    if (!latestIncoming) return null;

    const row = await db.prepare(`
      SELECT *
      FROM staff_ai_training_examples
      WHERE contact_id = ?
        AND incoming_message_id = ?
        AND draft_status IN ('generating', 'ready')
        AND final_staff_reply IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(contactId, latestIncoming.id);
    return row ? hydrateStaffAiTrainingExample(row) : null;
  }

  async function beginStaffAiDraftGeneration({
    contactId,
    generationId,
    incomingMessageId = null,
    customerMessage = '',
    telegramUserId = null
  }) {
    const contact = await db.prepare('SELECT * FROM telegram_users WHERE id = ?').get(contactId);
    if (!contact) throw new Error('Contact not found.');

    await db.prepare(`
      UPDATE staff_ai_training_examples
      SET draft_status = 'stale',
          outcome = CASE WHEN outcome = 'drafted' THEN 'stale' ELSE outcome END
      WHERE contact_id = ?
        AND draft_status IN ('generating', 'ready')
        AND final_staff_reply IS NULL
    `).run(contactId);

    const state = await ensureAutomationState(contactId);
    await updateAutomationState(contactId, {
      intents: {
        ...state.intents,
        support_ai_active_generation_id: generationId,
        support_ai_active_message_id: incomingMessageId || null
      }
    });

    const now = nowIso();
    const result = await db.prepare(`
      INSERT INTO staff_ai_training_examples (
        contact_id, telegram_user_id, incoming_message_id, customer_message,
        conversation_context, conversation_history, outcome, draft_status, generation_id, created_at
      )
      VALUES (?, ?, ?, ?, '', '', 'drafted', 'generating', ?, ?)
    `).run(
      contactId,
      String(telegramUserId || contact.telegram_id || ''),
      incomingMessageId || null,
      customerMessage || null,
      generationId,
      now
    );
    return await getStaffAiTrainingExample(result.lastInsertRowid);
  }

  async function completeStaffAiDraftGeneration({
    generationId,
    contactId,
    conversationContext = null,
    detectedIntent = null,
    detectedEntities = {},
    aiDraftReply = '',
    language = null,
    sentiment = null,
    confidence = null,
    wasRegistered = null,
    registrationStatus = null,
    registrationStep = null,
    paymentWindowStatus = null,
    appbegPlayerUid = null,
    recommendedAction = null,
    actionExecuted = null,
    actionBlockedReason = null,
    outcome = 'drafted'
  }) {
    const state = await getAutomationState(contactId);
    const activeGenerationId = state?.intents?.support_ai_active_generation_id || null;
    const row = await db.prepare('SELECT * FROM staff_ai_training_examples WHERE generation_id = ?').get(generationId);
    if (!row) return { ready: false, stale: true, draft: null };

    if (activeGenerationId && activeGenerationId !== generationId) {
      await db.prepare(`
        UPDATE staff_ai_training_examples
        SET draft_status = 'stale',
            outcome = CASE WHEN outcome = 'drafted' THEN 'stale' ELSE outcome END
        WHERE generation_id = ?
      `).run(generationId);
      return { ready: false, stale: true, draft: await getStaffAiTrainingExample(row.id) };
    }

    const context = conversationContext ?? row.conversation_context ?? '';
    await db.prepare(`
      UPDATE staff_ai_training_examples
      SET conversation_context = ?,
          conversation_history = ?,
          detected_intent = ?,
          detected_entities_json = ?,
          entities_json = ?,
          ai_draft_reply = ?,
          ai_reply = ?,
          confidence = ?,
          language = ?,
          sentiment = ?,
          was_registered = ?,
          registration_status = ?,
          registration_step = ?,
          payment_window_status = ?,
          appbeg_player_uid = ?,
          recommended_action = ?,
          action_executed = ?,
          action_blocked_reason = ?,
          outcome = ?,
          draft_status = 'ready'
      WHERE generation_id = ?
    `).run(
      context || null,
      context || null,
      detectedIntent || null,
      JSON.stringify(detectedEntities || {}),
      JSON.stringify(detectedEntities || {}),
      aiDraftReply || null,
      aiDraftReply || null,
      confidence == null ? null : Number(confidence),
      language || null,
      sentiment || null,
      wasRegistered == null ? null : sql.boolParam(wasRegistered),
      registrationStatus || null,
      registrationStep || null,
      paymentWindowStatus || null,
      appbegPlayerUid || null,
      recommendedAction || null,
      actionExecuted == null ? null : sql.boolParam(actionExecuted),
      actionBlockedReason || null,
      outcome,
      generationId
    );
    return {
      ready: true,
      stale: false,
      draft: await getStaffAiTrainingExample(row.id)
    };
  }

  async function failStaffAiDraftGeneration({ generationId, contactId }) {
    if (!generationId) return null;
    await db.prepare(`
      UPDATE staff_ai_training_examples
      SET draft_status = 'stale',
          outcome = CASE WHEN outcome = 'drafted' THEN 'stale' ELSE outcome END
      WHERE generation_id = ?
    `).run(generationId);
    const state = await getAutomationState(contactId);
    if (state?.intents?.support_ai_active_generation_id === generationId) {
      await updateAutomationState(contactId, {
        intents: {
          ...state.intents,
          support_ai_active_generation_id: null,
          support_ai_active_message_id: null
        }
      });
    }
    return null;
  }

  async function markStaffAiTrainingFeedback(id, {
    contactId,
    reason,
    outcome = 'feedback'
  } = {}) {
    const row = await db.prepare('SELECT * FROM staff_ai_training_examples WHERE id = ?').get(id);
    if (!row || (contactId && Number(row.contact_id) !== Number(contactId))) return null;
    await db.prepare(`
      UPDATE staff_ai_training_examples
      SET staff_feedback_reason = ?,
          outcome = ?
      WHERE id = ?
    `).run(reason || null, outcome || 'feedback', id);
    return await getStaffAiTrainingExample(id);
  }

  async function completeStaffAiTrainingExampleOnSend({
    trainingExampleId = null,
    contactId,
    telegramUserId = null,
    finalStaffReply,
    staffUserId = null,
    staffUsername = 'Staff',
    outcome = 'sent',
    replyUsed = null,
    staffFeedbackReason = null
  }) {
    const sentAt = nowIso();
    const finalText = String(finalStaffReply || '').trim();
    if (!finalText) return null;
    let row = trainingExampleId
      ? await db.prepare('SELECT * FROM staff_ai_training_examples WHERE id = ?').get(trainingExampleId)
      : await db.prepare(`
        SELECT *
        FROM staff_ai_training_examples
        WHERE contact_id = ?
          AND outcome = 'drafted'
          AND final_staff_reply IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(contactId);
    if (row && Number(row.contact_id) !== Number(contactId)) row = null;
    if (!row) {
      row = await createStaffAiTrainingDraft({
        contactId,
        telegramUserId,
        aiDraftReply: null,
        customerMessage: null,
        detectedIntent: 'manual_staff_reply',
        outcome: 'manual'
      });
    }
    const aiDraft = String(row.ai_draft_reply || row.ai_reply || '').trim();
    const editDistancePercent = aiDraft ? calculateEditDistancePercent(aiDraft, finalText) : null;
    const wasEdited = aiDraft ? aiDraft !== finalText : true;
    const feedback = replyUsed || (wasEdited ? 'bad' : 'good');
    const aiReplyRejected = feedback === 'bad';
    const draftStatus = feedback === 'good' ? 'approved' : 'rejected';
    const normalizedCustomerMessage = normalizeCustomerMessage(row.customer_message || '');
    await db.prepare(`
      UPDATE staff_ai_training_examples
      SET final_staff_reply = ?,
          staff_reply = ?,
          ai_reply = COALESCE(ai_reply, ai_draft_reply),
          staff_user_id = ?,
          staff_username = ?,
          was_edited = ?,
          edit_distance_percent = ?,
          reply_used = ?,
          feedback = ?,
          approved = ?,
          ai_reply_rejected = ?,
          normalized_customer_message = ?,
          draft_status = ?,
          staff_feedback_reason = COALESCE(?, staff_feedback_reason),
          outcome = ?,
          sent_at = ?
      WHERE id = ?
    `).run(
      finalText,
      finalText,
      staffUserId != null ? String(staffUserId) : null,
      staffUsername || 'Staff',
      wasEdited ? 1 : 0,
      editDistancePercent,
      feedback,
      feedback,
      sql.boolParam(true),
      sql.boolParam(aiReplyRejected),
      normalizedCustomerMessage || null,
      draftStatus,
      staffFeedbackReason || null,
      outcome,
      sentAt,
      row.id
    );
    console.log(`[support-ai] support_ai_training_example_saved contact=${contactId} example_id=${row.id} feedback=${feedback} approved=true ai_reply_rejected=${aiReplyRejected}`);
    return await getStaffAiTrainingExample(row.id);
  }

  async function listNotesForUser(id) {
    return await db.prepare(`
      SELECT *
      FROM internal_notes
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id);
  }

  async function listTimelineForUser(id) {
    return await db.prepare(`
      SELECT *
      FROM activity_events
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id);
  }

  async function listTags() {
    return await db.prepare('SELECT * FROM tags ORDER BY name ASC').all();
  }

  async function listQuickReplies() {
    return await db.prepare(`
      SELECT id, label, body
      FROM quick_replies
      WHERE is_active = ${sql.boolTrue}
      ORDER BY sort_order ASC, label ASC
    `).all();
  }

  async function listAutomationRules() {
    return (await db.prepare(`
      SELECT *
      FROM automation_rules
      WHERE enabled = ${sql.boolTrue}
      ORDER BY priority ASC, id ASC
    `).all()).map(hydrateAutomationRule);
  }

  async function ensureAutomationState(userId) {
    await db.prepare(`
      INSERT INTO contact_automation_state (telegram_user_id)
      VALUES (?)
      ON CONFLICT(telegram_user_id) DO NOTHING
    `).run(userId);
    return await getAutomationState(userId);
  }

  async function getAutomationState(userId) {
    const state = await db.prepare('SELECT * FROM contact_automation_state WHERE telegram_user_id = ?').get(userId);
    return state ? hydrateAutomationState(state) : null;
  }

  async function updateAutomationState(userId, patch) {
    const current = await ensureAutomationState(userId);
    const now = nowIso();
    const nextRegistrationInfo = patch.registrationInfo ?? current.registration_info;
    const nextIntents = patch.intents ?? current.intents;
    await db.prepare(`
      UPDATE contact_automation_state
      SET current_flow = ?,
          current_step = ?,
          registration_info_json = ?,
          intents_json = ?,
          last_matched_keyword = ?,
          last_rule_id = ?,
          last_automation_response = ?,
          last_automation_at = ?,
          last_auto_welcome_at = ?,
          info_reviewed_at = ?,
          info_reviewed_by = ?,
          updated_at = ?
      WHERE telegram_user_id = ?
    `).run(
      patch.currentFlow === undefined ? current.current_flow : patch.currentFlow,
      patch.currentStep === undefined ? current.current_step : patch.currentStep,
      JSON.stringify(nextRegistrationInfo || {}),
      JSON.stringify(nextIntents || {}),
      patch.lastMatchedKeyword === undefined ? current.last_matched_keyword : patch.lastMatchedKeyword,
      patch.lastRuleId === undefined ? current.last_rule_id : patch.lastRuleId,
      patch.lastAutomationResponse === undefined ? current.last_automation_response : patch.lastAutomationResponse,
      patch.lastAutomationAt === undefined ? current.last_automation_at : patch.lastAutomationAt,
      patch.lastAutoWelcomeAt === undefined ? current.last_auto_welcome_at : patch.lastAutoWelcomeAt,
      patch.infoReviewedAt === undefined ? current.info_reviewed_at : patch.infoReviewedAt,
      patch.infoReviewedBy === undefined ? current.info_reviewed_by : patch.infoReviewedBy,
      now,
      userId
    );
    return await getAutomationState(userId);
  }

  async function setAutomationIntent(userId, intentKey, value = true) {
    const state = await ensureAutomationState(userId);
    return await updateAutomationState(userId, {
      intents: {
        ...state.intents,
        [intentKey]: value
      }
    });
  }

  async function logAutomationDecision({ userId, messageId = null, incomingTelegramMessageId = null, matchedKeyword = null, rule = null, actionTaken, responseSent = null, metadata = null }) {
    const now = nowIso();
    await db.prepare(`
      INSERT INTO automation_logs (
        telegram_user_id, message_id, incoming_telegram_message_id, matched_keyword, rule_id,
        rule_name, action_taken, response_sent, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      messageId,
      incomingTelegramMessageId,
      matchedKeyword,
      rule?.id ?? null,
      rule?.name ?? null,
      actionTaken,
      responseSent,
      metadata ? JSON.stringify(metadata) : null,
      now
    );
  }

  async function listAutomationLogsForUser(userId) {
    return await db.prepare(`
      SELECT *
      FROM automation_logs
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all(userId);
  }

  async function listStaffAssignees() {
    return await db.prepare(`
      SELECT assigned_staff_name AS name, COUNT(*) AS open_conversations
      FROM conversations
      WHERE assigned_staff_name IS NOT NULL AND assigned_staff_name != ''
      GROUP BY assigned_staff_name
      ORDER BY assigned_staff_name ASC
    `).all();
  }

  async function ensureBotSession(userId) {
    const now = nowIso();
    await db.prepare(`
      INSERT INTO bot_sessions (telegram_user_id, current_screen, state_stack_json, context_json, created_at, updated_at)
      VALUES (?, 'Home', '[]', '{}', ?, ?)
      ON CONFLICT(telegram_user_id) DO NOTHING
    `).run(userId, now, now);
    return await getBotSession(userId);
  }

  async function getBotSession(userId) {
    return await db.prepare('SELECT * FROM bot_sessions WHERE telegram_user_id = ?').get(userId) || null;
  }

  async function setBotScreen(userId, screen, { actorName = 'Bot', pushCurrent = true, workflowKey = null, workflowStep = null, context = null } = {}) {
    const session = await ensureBotSession(userId);
    const now = nowIso();
    const stack = JSON.parse(session.state_stack_json || '[]');
    if (pushCurrent && session.current_screen && session.current_screen !== screen) {
      stack.push(session.current_screen);
    }

    await db.prepare(`
      UPDATE bot_sessions
      SET current_screen = ?,
          workflow_key = ?,
          workflow_step = ?,
          state_stack_json = ?,
          context_json = ?,
          canceled_at = NULL,
          updated_at = ?
      WHERE telegram_user_id = ?
    `).run(
      screen,
      workflowKey,
      workflowStep,
      JSON.stringify(stack.slice(-25)),
      context ? JSON.stringify(context) : session.context_json || '{}',
      now,
      userId
    );

    if (session.current_screen !== screen) {
      await logEvent({
        telegramUserId: userId,
        eventType: 'bot_screen_changed',
        title: 'Bot Screen Changed',
        body: `${session.current_screen || 'None'} to ${screen}`,
        actorName,
        metadata: { from: session.current_screen, to: screen },
        createdAt: now
      });
    }

    return await getBotSession(userId);
  }

  async function goBackBotScreen(userId, actorName = 'Bot') {
    const session = await ensureBotSession(userId);
    const stack = JSON.parse(session.state_stack_json || '[]');
    const previous = stack.pop() || 'Home';
    const now = nowIso();
    await db.prepare(`
      UPDATE bot_sessions
      SET current_screen = ?,
          state_stack_json = ?,
          updated_at = ?
      WHERE telegram_user_id = ?
    `).run(previous, JSON.stringify(stack), now, userId);

    await logEvent({
      telegramUserId: userId,
      eventType: 'bot_screen_changed',
      title: 'Bot Screen Changed',
      body: `${session.current_screen || 'None'} to ${previous}`,
      actorName,
      metadata: { from: session.current_screen, to: previous, action: 'back' },
      createdAt: now
    });

    return await getBotSession(userId);
  }

  async function resetBotState(userId, { actorName = 'Staff', action = 'home' } = {}) {
    const session = await ensureBotSession(userId);
    const now = nowIso();
    await db.prepare(`
      UPDATE bot_sessions
      SET current_screen = 'Home',
          workflow_key = NULL,
          workflow_step = NULL,
          state_stack_json = '[]',
          context_json = '{}',
          canceled_at = CASE WHEN ? = 'cancel' THEN ? ELSE canceled_at END,
          updated_at = ?
      WHERE telegram_user_id = ?
    `).run(action, now, now, userId);

    const titleMap = {
      restart: 'Bot Conversation Restarted',
      home: 'Bot Returned Home',
      cancel: 'Bot Workflow Canceled'
    };
    await logEvent({
      telegramUserId: userId,
      eventType: 'bot_state_control',
      title: titleMap[action] || 'Bot State Reset',
      body: `${session.current_screen || 'None'} to Home`,
      actorName,
      metadata: { from: session.current_screen, to: 'Home', action },
      createdAt: now
    });

    return await getBotSession(userId);
  }

  async function markConversationRead(userId) {
    const conversation = await db.prepare("SELECT * FROM conversations WHERE telegram_user_id = ? AND channel = 'telegram_private'").get(userId);
    if (!conversation) return null;
    const latestIncoming = await db.prepare(`
      SELECT id
      FROM messages
      WHERE conversation_id = ? AND direction = 'incoming'
      ORDER BY id DESC
      LIMIT 1
    `).get(conversation.id);

    const now = nowIso();
    await db.prepare(`
      UPDATE conversations
      SET last_read_message_id = COALESCE(?, last_read_message_id),
          last_read_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(latestIncoming?.id ?? null, now, now, conversation.id);

    return await getUserProfile(userId);
  }

  async function updateConversationStatus(userId, status, actorName = 'Staff') {
    if (!CONVERSATION_STATUSES.includes(status)) {
      throw new Error(`Invalid conversation status: ${status}`);
    }
    const user = await getUserProfile(userId);
    if (!user) return null;
    const conversation = await ensureConversation(userId);
    const previous = conversation.status;
    const now = nowIso();

    await db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, now, conversation.id);

    if (previous !== status) {
      await logEvent({
        telegramUserId: userId,
        eventType: 'conversation_status_changed',
        title: 'Conversation Status Changed',
        body: `${previous} to ${status}`,
        actorName,
        metadata: { from: previous, to: status, conversationId: conversation.id },
        createdAt: now
      });
    }

    return await getUserProfile(userId);
  }

  async function assignConversation(userId, staffName, actorName = 'Staff') {
    const user = await getUserProfile(userId);
    if (!user) return null;
    const conversation = await ensureConversation(userId);
    const normalizedStaffName = String(staffName || '').trim();
    const now = nowIso();

    await db.prepare(`
      UPDATE conversations
      SET assigned_staff_name = ?,
          assigned_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
          updated_at = ?
      WHERE id = ?
    `).run(normalizedStaffName || null, normalizedStaffName || null, now, now, conversation.id);

    await logEvent({
      telegramUserId: userId,
      eventType: 'staff_assignment',
      title: normalizedStaffName ? 'Conversation Assigned' : 'Conversation Unassigned',
      body: normalizedStaffName ? `Assigned to ${normalizedStaffName}` : 'Assignment cleared',
      actorName,
      metadata: { staffName: normalizedStaffName || null, conversationId: conversation.id },
      createdAt: now
    });

    return await getUserProfile(userId);
  }

  async function updateRegistrationStatus(id, registrationStatus, actorName = 'Staff') {
    if (!REGISTRATION_STATUSES.includes(registrationStatus)) {
      throw new Error(`Invalid registration status: ${registrationStatus}`);
    }

    const existing = await getUserProfile(id);
    if (!existing) return null;
    const now = nowIso();

    await db.prepare(`
      UPDATE telegram_users
      SET registration_status = ?,
          registered_at = CASE WHEN ? = 'Registered' THEN COALESCE(registered_at, ?) ELSE registered_at END,
          suspended_at = CASE WHEN ? = 'Suspended' THEN COALESCE(suspended_at, ?) ELSE suspended_at END,
          archived_at = CASE WHEN ? = 'Archived' THEN COALESCE(archived_at, ?) ELSE archived_at END,
          updated_at = ?
      WHERE id = ?
    `).run(registrationStatus, registrationStatus, now, registrationStatus, now, registrationStatus, now, now, id);

    if (existing.registration_status !== registrationStatus) {
      await logEvent({
        telegramUserId: id,
        eventType: 'status_changed',
        title: 'Registration Status Changed',
        body: `${existing.registration_status} to ${registrationStatus}`,
        actorName,
        metadata: { from: existing.registration_status, to: registrationStatus },
        createdAt: now
      });
    }

    return await getUserProfile(id);
  }

  async function startAutomationFlow(userId, flowKey, actorName = 'Staff') {
    const user = await getUserProfile(userId);
    if (!user) return null;
    let step = null;
    if (flowKey === 'registration_info') {
      step = 'appbeg_username';
      await updateRegistrationStatus(userId, 'Collecting Info', actorName);
    }
    const state = await updateAutomationState(userId, {
      currentFlow: flowKey,
      currentStep: step,
      infoReviewedAt: null,
      infoReviewedBy: null
    });
    await logEvent({
      telegramUserId: userId,
      eventType: 'automation_flow_started',
      title: 'Automation Flow Started',
      body: flowKey,
      actorName,
      metadata: { flowKey, step }
    });
    return state;
  }

  async function cancelAutomationFlow(userId, actorName = 'Staff') {
    const state = await updateAutomationState(userId, {
      currentFlow: null,
      currentStep: null
    });
    await logEvent({
      telegramUserId: userId,
      eventType: 'automation_flow_canceled',
      title: 'Automation Flow Canceled',
      body: 'Current automation flow was canceled.',
      actorName
    });
    return state;
  }

  async function resetAutomationState(userId, actorName = 'Staff') {
    const state = await updateAutomationState(userId, {
      currentFlow: null,
      currentStep: null,
      registrationInfo: {},
      intents: {},
      lastMatchedKeyword: null,
      lastRuleId: null,
      lastAutomationResponse: null,
      lastAutomationAt: null,
      infoReviewedAt: null,
      infoReviewedBy: null
    });
    await logEvent({
      telegramUserId: userId,
      eventType: 'automation_state_reset',
      title: 'Automation State Reset',
      body: 'Automation state was reset.',
      actorName
    });
    return state;
  }

  async function logRegistrationFieldChange(userId, fieldName, oldValue, newValue, changedBy = 'System') {
    if (String(oldValue ?? '') === String(newValue ?? '')) return;
    await db.prepare(`
      INSERT INTO registration_info_history (telegram_user_id, field_name, old_value, new_value, changed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, fieldName, oldValue ?? null, newValue ?? null, changedBy, nowIso());
    await logEvent({
      telegramUserId: userId,
      eventType: 'registration_field_changed',
      title: 'Registration Field Changed',
      body: `${fieldName}: ${oldValue || '(empty)'} -> ${newValue || '(empty)'}`,
      actorName: changedBy,
      metadata: { fieldName, oldValue, newValue }
    });
  }

  async function markAutoWelcomeSent(userId) {
    await logEvent({
      telegramUserId: userId,
      eventType: 'auto_welcome_sent',
      title: 'Welcome Sent',
      body: 'Automatic welcome/register prompt was sent.',
      actorName: 'Automation'
    });
    return await updateAutomationState(userId, { lastAutoWelcomeAt: nowIso() });
  }

  async function checkRegistrationDuplicates({ appbegUsername, paymentTag, excludeUserId, allowDuplicate = false }) {
    if (allowDuplicate) return null;
    const normalizedAppBeg = normalizeAppBegUsername(appbegUsername);
    const normalizedPayment = normalizePaymentTag(paymentTag);
    const rows = await db.prepare(`
      SELECT u.id, u.display_name, u.registration_status, cas.registration_info_json
      FROM telegram_users u
      LEFT JOIN contact_automation_state cas ON cas.telegram_user_id = u.id
      WHERE u.id != ?
        AND u.registration_status IN ('Registered', 'Pending Verification', 'Pending')
    `).all(excludeUserId || 0);

    for (const row of rows) {
      const info = parseJsonField(row.registration_info_json, {});
      if (normalizedAppBeg && normalizeAppBegUsername(info.preferred_appbeg_username) === normalizedAppBeg) {
        return `AppBeg username "${appbegUsername}" is already used by ${row.display_name}.`;
      }
      if (normalizedPayment && normalizePaymentTag(info.payment_tag) === normalizedPayment) {
        return `Payment name/tag "${paymentTag}" is already used by ${row.display_name}.`;
      }
    }
    return null;
  }

  async function completeRegistration({ userId, registrationInfo, registrationStatus, registrationMethod, actorName = 'System' }) {
    const user = await getUserProfile(userId);
    if (!user) throw new Error('Contact not found.');
    const mergedInfo = {
      ...((await getAutomationState(userId))?.registration_info || {}),
      ...(await buildCoadminSnapshot()),
      ...(registrationInfo || {})
    };
    if (mergedInfo.preferred_appbeg_username) {
      mergedInfo.preferred_appbeg_username_normalized = normalizeAppBegUsername(mergedInfo.preferred_appbeg_username);
    }
    if (mergedInfo.payment_tag) {
      mergedInfo.payment_tag_normalized = normalizePaymentTag(mergedInfo.payment_tag);
    }
    await updateRegistrationInfo(userId, mergedInfo, actorName);
    await db.prepare(`
      UPDATE telegram_users
      SET registration_method = ?, appbeg_account_id = COALESCE(?, appbeg_account_id), updated_at = ?
      WHERE id = ?
    `).run(registrationMethod || mergedInfo.registration_method || 'telegram', mergedInfo.preferred_appbeg_username || null, nowIso(), userId);
    await updateRegistrationStatus(userId, registrationStatus, actorName);
    await logEvent({
      telegramUserId: userId,
      eventType: 'registration_completed',
      title: 'Registration Completed',
      body: `Registration saved as ${registrationStatus}.`,
      actorName,
      metadata: { registrationStatus, registrationMethod: registrationMethod || mergedInfo.registration_method || 'telegram' }
    });
    return await getUserProfile(userId);
  }

  async function markAppBegPlayerCreated({
    userId,
    playerUid,
    username,
    registrationInfo,
    actorName = 'Staff'
  }) {
    const user = await getUserProfile(userId);
    if (!user) throw new Error('Contact not found.');

    const mergedInfo = {
      ...((await getAutomationState(userId))?.registration_info || {}),
      ...(registrationInfo || {}),
      appbeg_player_uid: playerUid || null,
      appbeg_creation_complete: true,
      ready_to_create_player: false
    };
    await updateRegistrationInfo(userId, mergedInfo, actorName);
    await db.prepare(`
      UPDATE telegram_users
      SET registration_method = COALESCE(registration_method, 'chatbot'),
          appbeg_account_id = ?,
          registration_status = 'Registered',
          registered_at = COALESCE(registered_at, ?),
          updated_at = ?
      WHERE id = ?
    `).run(playerUid || username, nowIso(), nowIso(), userId);

    await logEvent({
      telegramUserId: userId,
      eventType: 'registration_completed',
      title: 'Registration Completed',
      body: 'AppBeg player created and contact marked Registered.',
      actorName,
      metadata: {
        playerUid,
        username
      }
    });

    return await getUserProfile(userId);
  }

  async function manualRegister({ userId, appbegUsername, paymentTag, registrationStatus, notes, staffName = 'Staff', allowDuplicate = false }) {
    const duplicateError = await checkRegistrationDuplicates({
      appbegUsername,
      paymentTag,
      excludeUserId: userId,
      allowDuplicate
    });
    if (duplicateError) throw new Error(duplicateError);
    if (!REGISTRATION_STATUSES.includes(registrationStatus)) {
      throw new Error(`Invalid registration status: ${registrationStatus}`);
    }

    const user = await getUserProfile(userId);
    if (!user) throw new Error('Contact not found.');
    const registrationInfo = {
      ...((await getAutomationState(userId))?.registration_info || {}),
      telegram_user_id: user.telegram_id,
      telegram_username: user.username,
      telegram_display_name: user.display_name,
      telegram_phone: user.phone_number,
      preferred_appbeg_username: appbegUsername,
      payment_tag: paymentTag,
      registration_method: 'manual'
    };
    await completeRegistration({
      userId,
      registrationInfo,
      registrationStatus,
      registrationMethod: 'manual',
      actorName: staffName
    });
    if (notes) {
      await addNote(userId, { staffName, text: notes });
    }
    return await getUserProfile(userId);
  }

  async function listPlayers({ status = 'All', query = '' }) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const rows = await db.prepare(`
      SELECT
        u.*,
        COALESCE(cas.registration_info_json, '{}') AS registration_info_json,
        cas.info_reviewed_at,
        cas.info_reviewed_by,
        cas.current_flow,
        cas.current_step,
        cas.last_automation_at,
        ${sql.tagsJsonSelect} AS tags_json,
        ${sql.notesTextSelect} AS notes_text,
        COALESCE(auto_error.has_error, 0) AS automation_error
      FROM telegram_users u
      LEFT JOIN contact_automation_state cas ON cas.telegram_user_id = u.id
      LEFT JOIN (
        SELECT telegram_user_id, 1 AS has_error
        FROM automation_logs
        WHERE action_taken IN ('error', 'flow_error')
        GROUP BY telegram_user_id
      ) auto_error ON auto_error.telegram_user_id = u.id
      ORDER BY u.last_seen DESC, u.id DESC
    `).all();

    const preliminary = rows.map((row) => enrichPlayer(row, { automationError: Boolean(row.automation_error) }));
    const { appbeg, payment } = buildDuplicateIndex(preliminary);

    const players = preliminary.map((player) => {
      const appbegKey = normalizeAppBegUsername(player.appbeg_username);
      const paymentKey = normalizePaymentTag(player.payment_tag);
      const row = rows.find((entry) => Number(entry.id) === Number(player.id));
      return enrichPlayer(
        row,
        {
          duplicateAppbeg: appbegKey && (appbeg.get(appbegKey)?.length || 0) > 1,
          duplicatePayment: paymentKey && (payment.get(paymentKey)?.length || 0) > 1,
          automationError: Boolean(row?.automation_error)
        }
      );
    });

    return players.filter((player) => playerMatchesFilter(player, status) && playerMatchesQuery(player, normalizedQuery));
  }

  async function listRegisteredPlayersForPaymentMatch(limit = 5000) {
    const players = await listPlayers({ status: 'Registered', query: '' });
    return players.slice(0, Math.min(Math.max(Number(limit) || 5000, 1), 5000));
  }

  async function getPlayerStats() {
    const players = await listPlayers({ status: 'All', query: '' });
    return computePlayerStats(players);
  }

  async function getPlayerDetail(id) {
    const row = await db.prepare(`
      SELECT
        u.*,
        COALESCE(cas.registration_info_json, '{}') AS registration_info_json,
        cas.info_reviewed_at,
        cas.info_reviewed_by,
        cas.current_flow,
        cas.current_step,
        cas.last_automation_at,
        ${sql.tagsJsonSelect} AS tags_json,
        ${sql.notesTextSelect} AS notes_text,
        0 AS automation_error
      FROM telegram_users u
      LEFT JOIN contact_automation_state cas ON cas.telegram_user_id = u.id
      WHERE u.id = ?
    `).get(id);
    if (!row) return null;

    const allPlayers = await listPlayers({ status: 'All', query: '' });
    const player = allPlayers.find((entry) => entry.id === id) || enrichPlayer(row, {});

    const timeline = (await db.prepare(`
      SELECT id, event_type, title, body, actor_name, metadata_json, created_at, 'activity' AS source
      FROM activity_events
      WHERE telegram_user_id = ?
      UNION ALL
      SELECT id, action_taken AS event_type, COALESCE(rule_name, action_taken) AS title, response_sent AS body,
        'Automation' AS actor_name, metadata_json, created_at, 'automation' AS source
      FROM automation_logs
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all(id, id)).map((event) => ({
      ...event,
      metadata: JSON.parse(event.metadata_json || 'null')
    }));

    const automationLogs = await listAutomationLogsForUser(id);
    const notes = await listNotesForUser(id);
    return { player, timeline, automationLogs, notes };
  }

  async function approvePlayer(id, actorName = 'Staff') {
    await markRegistrationInfoReviewed(id, actorName);
    return await updateRegistrationStatus(id, 'Registered', actorName);
  }

  async function rejectPlayer(id, actorName = 'Staff') {
    await markRegistrationInfoReviewed(id, actorName);
    return await updateRegistrationStatus(id, 'Collecting Info', actorName);
  }

  async function reactivatePlayer(id, actorName = 'Staff') {
    return await updateRegistrationStatus(id, 'Registered', actorName);
  }

  async function suspendPlayer(id, actorName = 'Staff') {
    return await updateRegistrationStatus(id, 'Suspended', actorName);
  }

  async function updateRegistrationInfo(userId, registrationInfo, actorName = 'Staff') {
    const current = await ensureAutomationState(userId);
    const previous = current.registration_info || {};
    const next = { ...previous, ...(registrationInfo || {}) };
    for (const field of [
      'preferred_appbeg_username',
      'payment_tag',
      'preferred_game',
      'note',
      'coadmin_name',
      'coadmin_code',
      'appbeg_coadmin_uid'
    ]) {
      if (field in (registrationInfo || {})) {
        await logRegistrationFieldChange(userId, field, previous[field], next[field], actorName);
      }
    }
    const state = await updateAutomationState(userId, {
      registrationInfo: next
    });
    await logEvent({
      telegramUserId: userId,
      eventType: 'registration_info_updated',
      title: 'Registration Info Updated',
      body: 'Stored registration info was edited.',
      actorName,
      metadata: { registrationInfo: next }
    });
    return state;
  }

  async function markRegistrationInfoReviewed(userId, actorName = 'Staff') {
    const state = await updateAutomationState(userId, {
      infoReviewedAt: nowIso(),
      infoReviewedBy: actorName
    });
    await logEvent({
      telegramUserId: userId,
      eventType: 'registration_info_reviewed',
      title: 'Registration Info Reviewed',
      body: 'Stored registration info was marked reviewed.',
      actorName
    });
    return state;
  }

  async function addNote(id, { staffName = 'Staff', text }) {
    const noteText = String(text || '').trim();
    if (!noteText) throw new Error('Note text is required.');
    const user = await getUserProfile(id);
    if (!user) return null;
    const now = nowIso();

    const result = await db.prepare(`
      INSERT INTO internal_notes (telegram_user_id, staff_name, note_text, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, staffName || 'Staff', noteText, now);

    await logEvent({
      telegramUserId: id,
      eventType: 'note_added',
      title: 'Note Added',
      body: noteText,
      actorName: staffName || 'Staff',
      metadata: { noteId: result.lastInsertRowid },
      createdAt: now
    });

    return await db.prepare('SELECT * FROM internal_notes WHERE id = ?').get(result.lastInsertRowid);
  }

  async function setUserTags(id, tagIds, actorName = 'Staff') {
    const user = await getUserProfile(id);
    if (!user) return null;
    const ids = Array.from(new Set((tagIds || []).map(Number).filter(Boolean)));

    await db.exec('BEGIN');
    try {
      await db.prepare('DELETE FROM telegram_user_tags WHERE telegram_user_id = ?').run(id);
      const insert = db.prepare('INSERT INTO telegram_user_tags (telegram_user_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
      for (const tagId of ids) {
        await insert.run(id, tagId);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    await logEvent({
      telegramUserId: id,
      eventType: 'tags_updated',
      title: 'Tags Updated',
      body: 'User tags were updated.',
      actorName,
      metadata: { tagIds: ids }
    });

    return await getUserProfile(id);
  }

  async function updateProfilePhoto(id, { fileId, url }) {
    if (!PROFILE_PHOTOS_ENABLED) return await getUserProfile(id);
    db.prepare('UPDATE telegram_users SET profile_photo_file_id = ?, profile_photo_url = ?, updated_at = ? WHERE id = ?')
      .run(fileId ?? null, url ?? null, nowIso(), id);
    return await getUserProfile(id);
  }

  function buildPaymentEventsQuery({ status = 'All', routingStatus = 'All', query = '', exceptionsOnly = false } = {}) {
    const where = [];
    if (status && status !== 'All') where.push('processing_status = @status');
    if (routingStatus && routingStatus !== 'All') {
      if (routingStatus === 'registration_payment_matched') {
        where.push("routing_status IN ('registration_payment_matched', 'appbeg_owned')");
      } else if (routingStatus === 'manual_review') {
        where.push("routing_status IN ('manual_review', 'untouched_unmatched')");
      } else {
        where.push('routing_status = @routingStatus');
      }
    }
    if (exceptionsOnly) {
      where.push(`routing_status IN ('expired_deposit', 'parse_failed', 'route_failed', 'untouched_unmatched', 'manual_review')`);
    }
    if (String(query || '').trim()) {
      where.push(`(
        lower(COALESCE(message_text, '')) LIKE @query OR
        lower(COALESCE(sender_name, '')) LIKE @query OR
        lower(COALESCE(sender_username, '')) LIKE @query OR
        lower(COALESCE(parsed_recipient_tag, '')) LIKE @query OR
        lower(COALESCE(parsed_payment_app, '')) LIKE @query OR
        lower(COALESCE(parsed_sender_name, '')) LIKE @query OR
        lower(COALESCE(CAST(routing_reason AS TEXT), '')) LIKE @query OR
        CAST(telegram_message_id AS TEXT) LIKE @query
      )`);
    }
    const querySql = `
      SELECT *
      FROM payment_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY message_date DESC, id DESC
      LIMIT @limit
    `;
    return { querySql, where };
  }

  async function listPaymentEvents({ limit = 200, status = 'All', routingStatus = 'All', query = '', exceptionsOnly = false } = {}) {
    const params = {
      limit: Math.min(Math.max(Number(limit) || 200, 1), 1000),
      status,
      routingStatus,
      query: `%${String(query || '').trim().toLowerCase()}%`
    };
    const { querySql, where } = buildPaymentEventsQuery({ status, routingStatus, query, exceptionsOnly });
    console.log('[payments-api] listPaymentEvents', JSON.stringify({
      where,
      orderBy: 'message_date DESC, id DESC',
      limit: params.limit,
      status: params.status,
      routingStatus: params.routingStatus,
      exceptionsOnly: Boolean(exceptionsOnly),
      query: String(query || '').trim() || null
    }));
    const rows = await db.prepare(querySql).all(params);
    const payments = rows.map(hydratePaymentEvent);
    console.log(`[payments-api] payment_visible_in_ui count=${payments.length}`);
    return payments;
  }

  async function getPaymentEvent(id) {
    const event = await db.prepare('SELECT * FROM payment_events WHERE id = ?').get(id);
    return event ? hydratePaymentEvent(event) : null;
  }

  async function getPaymentEventByTelegramMessageId(telegramMessageId) {
    const event = await db.prepare(`
      SELECT *
      FROM payment_events
      WHERE telegram_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(telegramMessageId);
    return event ? hydratePaymentEvent(event) : null;
  }

  async function getPaymentStats() {
    const today = new Date().toISOString().slice(0, 10);
    const messageDay = sql.datePrefixExpr('message_date');
    const row = await db.prepare(`
      SELECT
        SUM(CASE WHEN ${messageDay} = @today THEN 1 ELSE 0 END) AS ${sql.quoteAlias('messagesToday')},
        SUM(CASE WHEN routing_status = 'registered_player_deposit' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('registeredPlayerDeposits')},
        SUM(CASE WHEN routing_status IN ('registration_payment_matched', 'appbeg_owned') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('registrationMatched')},
        SUM(CASE WHEN routing_status IN ('untouched_unmatched', 'manual_review') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('frozenManualReview')},
        SUM(CASE WHEN routing_status = 'expired_deposit' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('expiredWindowMatch')},
        SUM(CASE WHEN routing_status = 'parse_failed' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('parseFailed')},
        SUM(CASE WHEN routing_status = 'ignored' THEN 1 ELSE 0 END) AS ${sql.quoteAlias('ignored')},
        SUM(CASE WHEN routing_status IN ('expired_deposit', 'parse_failed', 'route_failed', 'untouched_unmatched', 'manual_review') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('exceptions')},
        SUM(CASE WHEN routing_status IN ('untouched_unmatched', 'manual_review') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('waiting')},
        SUM(CASE WHEN routing_status = 'unrouted' OR routed_at IS NULL THEN 1 ELSE 0 END) AS ${sql.quoteAlias('unrouted')},
        SUM(CASE WHEN routing_status IN ('registration_payment_matched', 'appbeg_owned') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('appbegOwned')},
        SUM(CASE WHEN processing_status = 'Failed' OR routing_status IN ('parse_failed', 'route_failed', 'expired_deposit') THEN 1 ELSE 0 END) AS ${sql.quoteAlias('failed')},
        COUNT(*) AS ${sql.quoteAlias('totalMessages')}
      FROM payment_events
    `).get({ today });
    return normalizeAggregateStats(row, [
      'messagesToday',
      'registeredPlayerDeposits',
      'registrationMatched',
      'frozenManualReview',
      'expiredWindowMatch',
      'parseFailed',
      'ignored',
      'exceptions',
      'waiting',
      'unrouted',
      'appbegOwned',
      'failed',
      'totalMessages'
    ]);
  }

  async function listUnroutedPaymentEvents(limit = 50) {
    return (await db.prepare(`
      SELECT *
      FROM payment_events
      WHERE routed_at IS NULL
      ORDER BY message_date ASC, id ASC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 50, 1), 500))).map(hydratePaymentEvent);
  }

  async function ensurePaymentIdempotencyKey(paymentEventId, idempotencyKey) {
    await db.prepare(`
      UPDATE payment_events
      SET idempotency_key = ?, updated_at = ?
      WHERE id = ? AND (idempotency_key IS NULL OR idempotency_key = '')
    `).run(idempotencyKey, nowIso(), paymentEventId);
  }

  async function applyPaymentParseResult(paymentEventId, parsed, { parseError = null } = {}) {
    const processingStatus = parsed ? 'Parsed' : 'Failed';
    await db.prepare(`
      UPDATE payment_events
      SET
        parsed_recipient_tag = ?,
        parsed_recipient_tag_normalized = ?,
        parsed_amount = ?,
        parsed_sender_name = ?,
        parsed_payment_datetime = ?,
        parsed_total_in = ?,
        parsed_total_out = ?,
        parsed_payment_app = ?,
        parsed_message_time = ?,
        parse_error = ?,
        processing_status = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      parsed?.recipient_tag ?? null,
      parsed?.recipient_tag_normalized ?? null,
      parsed?.amount ?? null,
      parsed?.payment_sender_name ?? null,
      parsed?.payment_datetime ?? null,
      parsed?.total_in ?? null,
      parsed?.total_out ?? null,
      parsed?.payment_app ?? null,
      parsed?.message_time ?? null,
      parseError,
      processingStatus,
      nowIso(),
      paymentEventId
    );
  }

  async function updatePaymentRouting(paymentEventId, patch) {
    const current = await getPaymentEvent(paymentEventId);
    if (!current) return null;
    const next = {
      routing_status: patch.routing_status ?? current.routing_status,
      routing_owner: patch.routing_owner ?? current.routing_owner,
      routing_reason: patch.routing_reason ?? current.routing_reason,
      contact_id: patch.contact_id ?? current.contact_id,
      deposit_event_id: patch.deposit_event_id ?? current.deposit_event_id,
      registration_payment_window_id: patch.registration_payment_window_id ?? current.registration_payment_window_id,
      teleledger_payment_id: patch.teleledger_payment_id ?? current.teleledger_payment_id,
      teleledger_sync_status: patch.teleledger_sync_status ?? current.teleledger_sync_status,
      routed_at: patch.routed_at ?? current.routed_at,
      handled_by: patch.handled_by ?? current.handled_by
    };
    let processingStatus = current.processing_status;
    if (next.routing_status === 'registered_player_deposit') processingStatus = 'Parsed';
    else if (next.routing_status === 'registration_payment_matched' || next.routing_status === 'appbeg_owned') processingStatus = 'Matched';
    else if (next.routing_status === 'manual_review' || next.routing_status === 'untouched_unmatched') processingStatus = 'Parsed';
    else if (next.routing_status === 'ignored') processingStatus = 'Failed';
    else if (['expired_deposit', 'parse_failed', 'route_failed'].includes(next.routing_status)) processingStatus = 'Failed';

    await db.prepare(`
      UPDATE payment_events
      SET
        routing_status = ?,
        routing_owner = ?,
        routing_reason = ?,
        contact_id = ?,
        deposit_event_id = ?,
        registration_payment_window_id = ?,
        teleledger_payment_id = ?,
        teleledger_sync_status = ?,
        routed_at = ?,
        handled_by = ?,
        processing_status = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.routing_status,
      next.routing_owner,
      next.routing_reason,
      next.contact_id,
      next.deposit_event_id,
      next.registration_payment_window_id,
      next.teleledger_payment_id,
      next.teleledger_sync_status,
      next.routed_at,
      next.handled_by,
      processingStatus,
      nowIso(),
      paymentEventId
    );
    return await getPaymentEvent(paymentEventId);
  }

  async function logPaymentRouting(paymentEventId, step, message, metadata = {}, level = 'info') {
    await db.prepare(`
      INSERT INTO payment_routing_logs (payment_event_id, step, level, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(paymentEventId, step, level, message, JSON.stringify(metadata || {}), nowIso());
  }

  async function listPaymentRoutingLogs(paymentEventId, limit = 100) {
    return (await db.prepare(`
      SELECT *
      FROM payment_routing_logs
      WHERE payment_event_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(paymentEventId, Math.min(Math.max(Number(limit) || 100, 1), 500))).map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata_json || '{}')
    }));
  }

  async function resetPaymentRoutingForReprocess(paymentEventId) {
    await db.prepare(`
      UPDATE payment_events
      SET routing_status = 'unrouted',
          routing_owner = NULL,
          routing_reason = NULL,
          contact_id = NULL,
          deposit_event_id = NULL,
          registration_payment_window_id = NULL,
          teleledger_payment_id = NULL,
          teleledger_sync_status = NULL,
          routed_at = NULL,
          handled_by = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(nowIso(), paymentEventId);
    return await getPaymentEvent(paymentEventId);
  }

  async function markPaymentIgnored(paymentEventId, { staffName = 'Staff' } = {}) {
    await updatePaymentRouting(paymentEventId, {
      routing_status: 'ignored',
      routing_owner: 'appbeg',
      routed_at: new Date().toISOString(),
      handled_by: staffName
    });
    await logPaymentRouting(paymentEventId, 'ignored', 'Payment message marked ignored by staff.', { staffName });
    return await getPaymentEvent(paymentEventId);
  }

  async function manuallyLinkPaymentEvent(paymentEventId, {
    contactId = null,
    registrationPaymentWindowId = null,
    staffName = 'Staff',
    routingStatus = null,
    routingReason = null
  } = {}) {
    const patch = {
      contact_id: contactId,
      registration_payment_window_id: registrationPaymentWindowId,
      routed_at: new Date().toISOString(),
      handled_by: staffName
    };
    if (routingReason) patch.routing_reason = routingReason;
    if (contactId && registrationPaymentWindowId) {
      patch.routing_status = routingStatus || 'registration_payment_matched';
      patch.routing_owner = 'appbeg';
    }
    const payment = await updatePaymentRouting(paymentEventId, patch);
    await logPaymentRouting(paymentEventId, 'manual_link', 'Payment message manually linked by staff.', {
      contactId,
      registrationPaymentWindowId,
      staffName
    });
    return payment;
  }

  async function createDepositEvent({ contactId, paymentTag, paymentTagNormalized, startedBy = 'Staff', notes = '' }) {
    const startedAt = nowIso();
    const expiresAt = new Date(Date.now() + depositWindowMinutes() * 60 * 1000).toISOString();
    const result = await db.prepare(`
      INSERT INTO deposit_events (
        contact_id, payment_tag_normalized, payment_tag_display, status,
        started_at, expires_at, started_by, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      contactId,
      paymentTagNormalized,
      paymentTag,
      startedAt,
      expiresAt,
      startedBy,
      notes || null,
      startedAt,
      startedAt
    );
    return await getDepositEvent(result.lastInsertRowid);
  }

  async function getDepositEvent(id) {
    const row = await db.prepare('SELECT * FROM deposit_events WHERE id = ?').get(id);
    return row ? hydrateDepositEvent(row) : null;
  }

  async function listDepositEvents({ contactId = null, status = 'All', limit = 100 } = {}) {
    const params = { limit: Math.min(Math.max(Number(limit) || 100, 1), 500) };
    const where = [];
    if (contactId) {
      where.push('contact_id = @contactId');
      params.contactId = contactId;
    }
    if (status && status !== 'All') {
      where.push('status = @status');
      params.status = status;
    }
    return (await db.prepare(`
      SELECT *
      FROM deposit_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC, id DESC
      LIMIT @limit
    `).all(params)).map(hydrateDepositEvent);
  }

  async function expireStaleDepositEvents() {
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE deposit_events
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at < ?
    `).run(now, now);
    return result.changes;
  }

  async function findActiveDepositByPaymentTag(paymentTagNormalized) {
    await expireStaleDepositEvents();
    const row = await db.prepare(`
      SELECT *
      FROM deposit_events
      WHERE payment_tag_normalized = ?
        AND status = 'active'
        AND expires_at >= ?
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(paymentTagNormalized, nowIso());
    return row ? hydrateDepositEvent(row) : null;
  }

  async function findLatestExpiredDepositByPaymentTag(paymentTagNormalized) {
    await expireStaleDepositEvents();
    const row = await db.prepare(`
      SELECT *
      FROM deposit_events
      WHERE payment_tag_normalized = ?
        AND status = 'expired'
      ORDER BY expires_at DESC, id DESC
      LIMIT 1
    `).get(paymentTagNormalized);
    return row ? hydrateDepositEvent(row) : null;
  }

  async function completeDepositEvent(depositEventId, { reason = 'payment_received', paymentEventId = null } = {}) {
    const completedAt = nowIso();
    await db.prepare(`
      UPDATE deposit_events
      SET
        status = 'completed',
        completed_at = ?,
        linked_payment_event_id = COALESCE(?, linked_payment_event_id),
        notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' | ' || ? END,
        updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(completedAt, paymentEventId, reason, reason, completedAt, depositEventId);
    return await getDepositEvent(depositEventId);
  }

  async function cancelDepositEvent(depositEventId, { cancelledBy = 'Staff', reason = '' } = {}) {
    const cancelledAt = nowIso();
    await db.prepare(`
      UPDATE deposit_events
      SET
        status = 'cancelled',
        cancelled_at = ?,
        notes = CASE WHEN ? = '' THEN notes ELSE COALESCE(notes, '') || CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE ' | ' END || ? END,
        updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(cancelledAt, reason, reason, cancelledAt, depositEventId);
    return await getDepositEvent(depositEventId);
  }

  async function getPaymentSyncState() {
    return await db.prepare('SELECT * FROM payment_sync_state WHERE id = 1').get() || {
      id: 1,
      status: 'disabled',
      last_synced_message_id: 0,
      imported_messages: 0
    };
  }

  async function updatePaymentSyncState(patch) {
    const current = await getPaymentSyncState();
    const next = { ...current, ...patch, updated_at: nowIso() };
    await db.prepare(`
      INSERT INTO payment_sync_state (
        id, status, last_started_at, last_connected_at, last_sync_started_at, last_sync_completed_at,
        last_error, account_user_id, account_username, telegram_group_id, telegram_group_title,
        last_synced_message_id, imported_messages, updated_at
      )
      VALUES (1, @status, @last_started_at, @last_connected_at, @last_sync_started_at, @last_sync_completed_at,
        @last_error, @account_user_id, @account_username, @telegram_group_id, @telegram_group_title,
        @last_synced_message_id, @imported_messages, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        last_started_at = excluded.last_started_at,
        last_connected_at = excluded.last_connected_at,
        last_sync_started_at = excluded.last_sync_started_at,
        last_sync_completed_at = excluded.last_sync_completed_at,
        last_error = excluded.last_error,
        account_user_id = excluded.account_user_id,
        account_username = excluded.account_username,
        telegram_group_id = excluded.telegram_group_id,
        telegram_group_title = excluded.telegram_group_title,
        last_synced_message_id = excluded.last_synced_message_id,
        imported_messages = excluded.imported_messages,
        updated_at = excluded.updated_at
    `).run({
      status: next.status ?? 'disabled',
      last_started_at: next.last_started_at ?? null,
      last_connected_at: next.last_connected_at ?? null,
      last_sync_started_at: next.last_sync_started_at ?? null,
      last_sync_completed_at: next.last_sync_completed_at ?? null,
      last_error: next.last_error ?? null,
      account_user_id: next.account_user_id ?? null,
      account_username: next.account_username ?? null,
      telegram_group_id: next.telegram_group_id ?? null,
      telegram_group_title: next.telegram_group_title ?? null,
      last_synced_message_id: next.last_synced_message_id ?? 0,
      imported_messages: next.imported_messages ?? 0,
      updated_at: next.updated_at
    });
    return await getPaymentSyncState();
  }

  async function logPaymentListener({ level = 'info', eventType, message, metadata = null }) {
    await db.prepare(`
      INSERT INTO payment_listener_logs (level, event_type, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(level, eventType, message, metadata ? JSON.stringify(metadata) : null, nowIso());
  }

  async function listPaymentListenerLogs(limit = 100) {
    return (await db.prepare(`
      SELECT *
      FROM payment_listener_logs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500))).map((log) => ({
      ...log,
      metadata: parseJsonField(log.metadata_json, null)
    }));
  }

  async function logAccountSync({ level = 'info', eventType, message, metadata = null }) {
    await db.prepare(`
      INSERT INTO account_sync_logs (level, event_type, message, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(level, eventType, message, metadata ? JSON.stringify(metadata) : null, nowIso());
  }

  async function listAccountSyncLogs(limit = 100) {
    return (await db.prepare(`
      SELECT *
      FROM account_sync_logs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500))).map((log) => ({
      ...log,
      metadata: parseJsonField(log.metadata_json, null)
    }));
  }

  async function getContactPreferredMessageSource(telegramUserId) {
    const user = await db.prepare('SELECT telegram_sync_source FROM telegram_users WHERE id = ?').get(telegramUserId);
    if (user?.telegram_sync_source === 'business_account') {
      return 'business_account';
    }
    const businessCount = (await db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE telegram_user_id = ? AND source = 'business_account'
    `).get(telegramUserId))?.count ?? 0;
    if (businessCount > 0) {
      return 'business_account';
    }
    return 'bot_api';
  }

  function normalizeTelegramUsername(value) {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase();
  }

  async function buildCoadminSnapshot(settings = null) {
    const active = settings || (await getCoadminSettings());
    return {
      coadmin_name: active.coadmin_name || null,
      coadmin_code: active.coadmin_code || null,
      appbeg_coadmin_uid: active.appbeg_coadmin_uid || null
    };
  }

  async function coadminSnapshotMatches(info = {}, snapshot = {}) {
    for (const key of ['coadmin_name', 'coadmin_code', 'appbeg_coadmin_uid']) {
      const expected = snapshot[key];
      if (!expected) continue;
      if (String(info[key] ?? '') !== String(expected)) return false;
    }
    return Boolean(snapshot.coadmin_name || snapshot.coadmin_code || snapshot.appbeg_coadmin_uid);
  }

  function contactMatchesCoadminAccount(row, settings) {
    const accountId = settings.telegram_account_id ? String(settings.telegram_account_id).trim() : '';
    const accountUsername = normalizeTelegramUsername(settings.telegram_account_username);
    const rowId = row.telegram_source_account_id ? String(row.telegram_source_account_id).trim() : '';
    const rowUsername = normalizeTelegramUsername(row.telegram_source_account_username);

    if (!accountId && !accountUsername) {
      return true;
    }
    if (rowId && accountId && rowId === accountId) return true;
    if (rowUsername && accountUsername && rowUsername === accountUsername) return true;
    if (!rowId && !rowUsername) return true;
    return false;
  }

  async function listBusinessAccountContactIds(settings = null) {
    const activeSettings = settings || (await getCoadminSettings());
    const rows = await db.prepare(`
      SELECT id, telegram_source_account_id, telegram_source_account_username
      FROM telegram_users
      WHERE telegram_sync_source = 'business_account'
    `).all();
    return rows.filter((row) => contactMatchesCoadminAccount(row, activeSettings)).map((row) => row.id);
  }

  async function stampBusinessSourceAccount(userId, settings) {
    const accountId = settings.telegram_account_id ? String(settings.telegram_account_id).trim() : null;
    const accountUsername = settings.telegram_account_username || null;
    if (!accountId && !accountUsername) return;
    await db.prepare(`
      UPDATE telegram_users
      SET telegram_source_account_id = COALESCE(telegram_source_account_id, ?),
          telegram_source_account_username = COALESCE(telegram_source_account_username, ?),
          updated_at = ?
      WHERE id = ?
    `).run(accountId, accountUsername, nowIso(), userId);
  }

  async function getIncomingMessageSentAt(contactId, telegramMessageId = null) {
    if (telegramMessageId == null || telegramMessageId === '') return null;
    const row = await db.prepare(`
      SELECT sent_at
      FROM messages
      WHERE telegram_user_id = ?
        AND telegram_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(contactId, telegramMessageId);
    return row?.sent_at || null;
  }

  async function getAutoRegistrationBotSettings() {
    const existing = await db.prepare('SELECT id FROM coadmin_settings WHERE id = 1').get();
    if (!existing) {
      await db.prepare('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, ?)').run(nowIso());
    }
    const row = await db.prepare(`
      SELECT
        auto_registration_bot_enabled,
        auto_registration_bot_enabled_at,
        auto_registration_bot_updated_at,
        auto_registration_bot_updated_by
      FROM coadmin_settings
      WHERE id = 1
    `).get();
    return normalizeAutoRegistrationBotSettings(row || {});
  }

  async function isIncomingMessageEligibleForAutoBot(contactId, {
    telegramMessageId = null,
    sentAt = null,
    jobCreatedAt = null
  } = {}) {
    const settings = await getAutoRegistrationBotSettings();
    if (!settings.enabled) {
      return { eligible: false, reason: 'bot_disabled', settings };
    }

    let messageSentAt = sentAt || null;
    if (!messageSentAt && telegramMessageId != null) {
      messageSentAt = await getIncomingMessageSentAt(contactId, telegramMessageId);
    }
    if (!messageSentAt && jobCreatedAt) {
      messageSentAt = jobCreatedAt;
    }
    if (!messageSentAt) {
      return { eligible: false, reason: 'missing_message_timestamp', settings };
    }

    if (!isMessageAfterBotResumeCheckpoint(messageSentAt, settings)) {
      return { eligible: false, reason: 'before_resume_checkpoint', settings, messageSentAt };
    }

    return { eligible: true, reason: 'eligible', settings, messageSentAt };
  }

  async function setAutoRegistrationBotEnabled(enabled, actorName = 'Staff') {
    const current = await getAutoRegistrationBotSettings();
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === current.enabled) {
      return current;
    }

    const updatedAt = nowIso();
    const enabledAt = nextEnabled ? updatedAt : current.enabled_at;

    await db.prepare(`
      UPDATE coadmin_settings
      SET auto_registration_bot_enabled = ?,
          auto_registration_bot_enabled_at = ?,
          auto_registration_bot_updated_at = ?,
          auto_registration_bot_updated_by = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      nextEnabled ? 1 : 0,
      enabledAt,
      updatedAt,
      actorName,
      updatedAt
    );

    await logSettingsAudit({
      settingsKey: 'auto_registration_bot',
      fieldName: 'enabled',
      oldValue: current.enabled ? 'true' : 'false',
      newValue: nextEnabled ? 'true' : 'false',
      actorName
    });

    if (nextEnabled) {
      await logAccountSync({
        eventType: 'auto_registration_bot_enabled',
        message: 'Auto registration bot enabled.',
        metadata: { actorName, enabled_at: enabledAt }
      });
      await logAccountSync({
        eventType: 'bot_resume_checkpoint_created',
        message: 'Auto registration bot resume checkpoint created.',
        metadata: { enabled_at: enabledAt, actorName }
      });
      console.log(`[chatbot] auto_registration_bot_enabled enabled_at=${enabledAt} actor=${actorName}`);
      console.log(`[chatbot] bot_resume_checkpoint_created enabled_at=${enabledAt}`);
    } else {
      await logAccountSync({
        eventType: 'auto_registration_bot_disabled',
        message: 'Auto registration bot disabled. Manual staff chat and payment listeners remain active.',
        metadata: { actorName }
      });
      await logAccountSync({
        eventType: 'payment_listener_still_active',
        message: 'Payment group listener and routing remain active while auto registration bot is disabled.',
        metadata: { actorName }
      });
      console.log(`[chatbot] auto_registration_bot_disabled actor=${actorName}`);
      console.log('[payment-router] payment_listener_still_active');
    }

    return await getAutoRegistrationBotSettings();
  }

  async function getCoadminSettings() {
    let row = await db.prepare('SELECT * FROM coadmin_settings WHERE id = 1').get();
    if (!row) {
      await db.prepare('INSERT INTO coadmin_settings (id, updated_at) VALUES (1, ?)').run(nowIso());
      row = await db.prepare('SELECT * FROM coadmin_settings WHERE id = 1').get();
    }
    const sync = await getTelegramAccountSyncState();
    return {
      coadmin_name: row.coadmin_name || '',
      coadmin_code: row.coadmin_code || '',
      appbeg_coadmin_uid: row.appbeg_coadmin_uid || '',
      telegram_account_username: row.telegram_account_username || sync.account_username || '',
      telegram_account_id: row.telegram_account_id || (sync.account_user_id ? String(sync.account_user_id) : ''),
      staff_ai_apprentice_mode_enabled: row.staff_ai_apprentice_mode_enabled === undefined || row.staff_ai_apprentice_mode_enabled === null
        ? true
        : Boolean(row.staff_ai_apprentice_mode_enabled),
      staff_ai_apprentice_mode_updated_at: row.staff_ai_apprentice_mode_updated_at || null,
      staff_ai_apprentice_mode_updated_by: row.staff_ai_apprentice_mode_updated_by || '',
      updated_at: row.updated_at,
      updated_by: row.updated_by || ''
    };
  }

  async function logSettingsAudit({ settingsKey, fieldName, oldValue, newValue, actorName = 'Staff' }) {
    if (String(oldValue ?? '') === String(newValue ?? '')) return;
    await db.prepare(`
      INSERT INTO settings_audit_log (settings_key, field_name, old_value, new_value, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(settingsKey, fieldName, oldValue ?? null, newValue ?? null, actorName, nowIso());
  }

  async function listSettingsAuditLog(limit = 50) {
    return await db.prepare(`
      SELECT id, settings_key, field_name, old_value, new_value, actor_name, created_at
      FROM settings_audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit);
  }

  async function updateCoadminSettings(patch, actorName = 'Staff', { applyToExisting = true } = {}) {
    const current = await getCoadminSettings();
    const next = {
      coadmin_name: patch.coadmin_name !== undefined ? String(patch.coadmin_name).trim() : current.coadmin_name,
      coadmin_code: patch.coadmin_code !== undefined ? String(patch.coadmin_code).trim() : current.coadmin_code,
      appbeg_coadmin_uid: patch.appbeg_coadmin_uid !== undefined ? String(patch.appbeg_coadmin_uid).trim() : current.appbeg_coadmin_uid,
      telegram_account_username: patch.telegram_account_username !== undefined
        ? String(patch.telegram_account_username).trim().replace(/^@+/, '')
        : current.telegram_account_username,
      telegram_account_id: patch.telegram_account_id !== undefined ? String(patch.telegram_account_id).trim() : current.telegram_account_id
    };

    if (next.telegram_account_id && !/^\d+$/.test(next.telegram_account_id)) {
      throw new Error('Telegram Account ID must be a numeric Telegram user ID.');
    }

    const updatedAt = nowIso();
    await db.prepare(`
      INSERT INTO coadmin_settings (
        id, coadmin_name, coadmin_code, appbeg_coadmin_uid,
        telegram_account_username, telegram_account_id, updated_at, updated_by
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        coadmin_name = excluded.coadmin_name,
        coadmin_code = excluded.coadmin_code,
        appbeg_coadmin_uid = excluded.appbeg_coadmin_uid,
        telegram_account_username = excluded.telegram_account_username,
        telegram_account_id = excluded.telegram_account_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(
      next.coadmin_name || null,
      next.coadmin_code || null,
      next.appbeg_coadmin_uid || null,
      next.telegram_account_username || null,
      next.telegram_account_id || null,
      updatedAt,
      actorName
    );

    for (const fieldName of [
      'coadmin_name',
      'coadmin_code',
      'appbeg_coadmin_uid',
      'telegram_account_username',
      'telegram_account_id'
    ]) {
      if (patch[fieldName] === undefined) continue;
      await logSettingsAudit({
        settingsKey: 'coadmin',
        fieldName,
        oldValue: current[fieldName],
        newValue: next[fieldName],
        actorName
      });
    }

    const settings = await getCoadminSettings();
    const backfill = applyToExisting
      ? await applyCoadminToExistingBusinessContacts(actorName, { settings })
      : { assigned: 0, skipped: 0, total: 0 };
    return { settings, backfill };
  }

  async function assignCoadminToUser(userId, actorName = 'System', options = {}) {
    const snapshot = options.snapshot || (await buildCoadminSnapshot());
    const hasData = snapshot.coadmin_name || snapshot.coadmin_code || snapshot.appbeg_coadmin_uid;
    if (!hasData) {
      return { changed: false, state: await getAutomationState(userId) };
    }

    const current = await ensureAutomationState(userId);
    const previous = current.registration_info || {};
    if (await coadminSnapshotMatches(previous, snapshot)) {
      return { changed: false, state: current };
    }

    const next = { ...previous };
    let changed = false;

    for (const [key, value] of Object.entries(snapshot)) {
      if (!value || next[key] === value) continue;
      await logRegistrationFieldChange(userId, key, previous[key], value, actorName);
      next[key] = value;
      changed = true;
    }

    if (!changed) {
      return { changed: false, state: current };
    }

    await updateAutomationState(userId, { registrationInfo: next });
    const eventType = options.eventType || 'coadmin_assigned';
    const eventTitle = options.eventTitle || 'Coadmin Assigned';
    const label = snapshot.coadmin_name || 'Coadmin';
    const codeSuffix = snapshot.coadmin_code ? ` (${snapshot.coadmin_code})` : '';
    const body = options.eventBody
      || (eventType === 'coadmin_assigned_from_settings'
        ? `Coadmin assigned from settings: ${label}${codeSuffix}.`
        : snapshot.coadmin_name
          ? `Assigned to ${label}${codeSuffix}.`
          : 'Coadmin ownership recorded from settings.');
    await logEvent({
      telegramUserId: userId,
      eventType,
      title: eventTitle,
      body,
      actorName,
      metadata: snapshot
    });
    return { changed: true, state: await getAutomationState(userId) };
  }

  async function applyCoadminToExistingBusinessContacts(actorName = 'Staff', { settings = null } = {}) {
    const activeSettings = settings || (await getCoadminSettings());
    const snapshot = await buildCoadminSnapshot(activeSettings);
    if (!snapshot.coadmin_name && !snapshot.coadmin_code && !snapshot.appbeg_coadmin_uid) {
      return { assigned: 0, skipped: 0, total: 0 };
    }

    const contactIds = await listBusinessAccountContactIds(activeSettings);
    let assigned = 0;
    let skipped = 0;

    for (const userId of contactIds) {
      await stampBusinessSourceAccount(userId, activeSettings);
      const result = await assignCoadminToUser(userId, actorName, {
        snapshot,
        eventType: 'coadmin_assigned_from_settings',
        eventTitle: 'Coadmin Assigned From Settings'
      });
      if (result.changed) assigned += 1;
      else skipped += 1;
    }

    return { assigned, skipped, total: contactIds.length };
  }

  async function getTelegramAccountSyncState() {
    return await db.prepare('SELECT * FROM telegram_account_sync_state WHERE id = 1').get() || {
      id: 1,
      status: 'disabled',
      imported_contacts: 0,
      imported_messages: 0
    };
  }

  async function updateTelegramAccountSyncState(patch) {
    const current = await getTelegramAccountSyncState();
    const next = { ...current, ...patch, updated_at: nowIso() };
    await db.prepare(`
      INSERT INTO telegram_account_sync_state (
        id, status, last_started_at, last_connected_at, last_import_completed_at, last_error,
        account_user_id, account_username, imported_contacts, imported_messages, updated_at
      )
      VALUES (1, @status, @last_started_at, @last_connected_at, @last_import_completed_at, @last_error,
        @account_user_id, @account_username, @imported_contacts, @imported_messages, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        last_started_at = excluded.last_started_at,
        last_connected_at = excluded.last_connected_at,
        last_import_completed_at = excluded.last_import_completed_at,
        last_error = excluded.last_error,
        account_user_id = excluded.account_user_id,
        account_username = excluded.account_username,
        imported_contacts = excluded.imported_contacts,
        imported_messages = excluded.imported_messages,
        updated_at = excluded.updated_at
    `).run({
      status: next.status ?? 'disabled',
      last_started_at: next.last_started_at ?? null,
      last_connected_at: next.last_connected_at ?? null,
      last_import_completed_at: next.last_import_completed_at ?? null,
      last_error: next.last_error ?? null,
      account_user_id: next.account_user_id ?? null,
      account_username: next.account_username ?? null,
      imported_contacts: next.imported_contacts ?? 0,
      imported_messages: next.imported_messages ?? 0,
      updated_at: next.updated_at
    });
    return await getTelegramAccountSyncState();
  }

  function hydratePaymentMethodRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      key: row.key,
      is_active: normalizeBool(row.is_active),
      display_order: Number(row.display_order || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      qr_count: Number(row.qr_count || 0),
      default_qr_label: row.default_qr_label || null,
      has_active_default: normalizeBool(row.has_active_default)
    };
  }

  function hydratePaymentQrRow(row) {
    if (!row) return null;
    const usageCount = Number(row.usage_count || 0);
    return {
      id: row.id,
      payment_method_id: row.payment_method_id,
      label: row.label || '',
      is_active: normalizeBool(row.is_active),
      is_default: normalizeBool(row.is_default),
      created_at: row.created_at,
      updated_at: row.updated_at,
      preview_url: previewUrlFromFilePath(row.file_path),
      usage_count: usageCount,
      in_use: usageCount > 0
    };
  }

  async function listPaymentMethods() {
    const rows = await db.prepare(`
      SELECT m.*,
        (
          SELECT COUNT(*)
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
        ) AS qr_count,
        (
          SELECT q.label
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
            AND q.is_active = ${sql.boolTrue}
            AND q.is_default = ${sql.boolTrue}
          ORDER BY q.updated_at DESC, q.id DESC
          LIMIT 1
        ) AS default_qr_label,
        EXISTS (
          SELECT 1
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
            AND q.is_active = ${sql.boolTrue}
            AND q.is_default = ${sql.boolTrue}
        ) AS has_active_default
      FROM payment_methods m
      ORDER BY m.display_order ASC, m.id ASC
    `).all();
    return rows.map(hydratePaymentMethodRow);
  }

  async function listActivePaymentMethodsForRegistration() {
    const rows = await db.prepare(`
      SELECT *
      FROM payment_methods
      WHERE is_active = ${sql.boolTrue}
      ORDER BY display_order ASC, id ASC
    `).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      key: row.key,
      display_order: Number(row.display_order || 0)
    }));
  }

  async function getPaymentMethod(id) {
    const row = await db.prepare(`
      SELECT m.*,
        (
          SELECT COUNT(*)
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
        ) AS qr_count,
        (
          SELECT q.label
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
            AND q.is_active = ${sql.boolTrue}
            AND q.is_default = ${sql.boolTrue}
          ORDER BY q.updated_at DESC, q.id DESC
          LIMIT 1
        ) AS default_qr_label,
        EXISTS (
          SELECT 1
          FROM payment_qr_codes q
          WHERE q.payment_method_id = m.id
            AND q.is_active = ${sql.boolTrue}
            AND q.is_default = ${sql.boolTrue}
        ) AS has_active_default
      FROM payment_methods m
      WHERE m.id = ?
    `).get(id);
    return hydratePaymentMethodRow(row);
  }

  async function getPaymentMethodByKey(key) {
    const row = await db.prepare('SELECT * FROM payment_methods WHERE key = ?').get(String(key || '').trim().toLowerCase());
    if (!row) return null;
    return await getPaymentMethod(row.id);
  }

  async function createPaymentMethod({ name, key = null, isActive = true, displayOrder = null }) {
    const now = nowIso();
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      const err = new Error('Payment method name is required.');
      err.code = 'INVALID_NAME';
      throw err;
    }
    let normalizedKey = String(key || slugifyPaymentMethodKey(normalizedName)).trim().toLowerCase();
    if (!normalizedKey) normalizedKey = slugifyPaymentMethodKey(normalizedName);
    const existing = await db.prepare('SELECT id FROM payment_methods WHERE key = ?').get(normalizedKey);
    if (existing) {
      const err = new Error('A payment method with this key already exists.');
      err.code = 'DUPLICATE_KEY';
      throw err;
    }
    let order = displayOrder;
    if (order == null) {
      const maxRow = await db.prepare('SELECT MAX(display_order) AS max_order FROM payment_methods').get();
      order = Number(maxRow?.max_order || 0) + 1;
    }
    const result = await db.prepare(`
      INSERT INTO payment_methods (name, key, is_active, display_order, created_at, updated_at)
      VALUES (?, ?, ${sql.boolLiteral(isActive)}, ?, ?, ?)
    `).run(normalizedName, normalizedKey, order, now, now);
    return await getPaymentMethod(result.lastInsertRowid);
  }

  async function updatePaymentMethod(id, patch = {}) {
    const current = await getPaymentMethod(id);
    if (!current) return null;
    const nextName = patch.name !== undefined ? String(patch.name || '').trim() : current.name;
    const nextActive = patch.is_active !== undefined ? Boolean(patch.is_active) : current.is_active;
    let nextOrder = patch.display_order !== undefined ? Number(patch.display_order) : current.display_order;
    if (!nextName) {
      const err = new Error('Payment method name is required.');
      err.code = 'INVALID_NAME';
      throw err;
    }
    if (!Number.isFinite(nextOrder)) nextOrder = current.display_order;
    const now = nowIso();
    await db.prepare(`
      UPDATE payment_methods
      SET name = ?, is_active = ${sql.boolLiteral(nextActive)}, display_order = ?, updated_at = ?
      WHERE id = ?
    `).run(nextName, nextOrder, now, id);
    return await getPaymentMethod(id);
  }

  async function deletePaymentMethod(id) {
    const current = await getPaymentMethod(id);
    if (!current) return null;
    const usageCount = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM registration_payment_windows
      WHERE payment_method_id = ?
    `).get(id);
    if (Number(usageCount?.count || 0) > 0) {
      const err = new Error('Cannot delete a payment method used in registration payments.');
      err.code = 'METHOD_IN_USE';
      throw err;
    }
    const qrs = await listPaymentQrCodes(id);
    await db.prepare('DELETE FROM payment_methods WHERE id = ?').run(id);
    return { action: 'deleted', method: current, qrs };
  }

  async function listPaymentQrCodes(paymentMethodId) {
    const rows = await db.prepare(`
      SELECT q.*,
        (
          SELECT COUNT(*)
          FROM registration_payment_windows w
          WHERE w.payment_qr_code_id = q.id
        ) AS usage_count
      FROM payment_qr_codes q
      WHERE q.payment_method_id = ?
      ORDER BY q.is_default DESC, q.is_active DESC, q.created_at DESC, q.id DESC
    `).all(paymentMethodId);
    return rows.map(hydratePaymentQrRow);
  }

  async function getPaymentQrCode(id) {
    const row = await db.prepare(`
      SELECT q.*,
        (
          SELECT COUNT(*)
          FROM registration_payment_windows w
          WHERE w.payment_qr_code_id = q.id
        ) AS usage_count
      FROM payment_qr_codes q
      WHERE q.id = ?
    `).get(id);
    return hydratePaymentQrRow(row);
  }

  async function getPaymentQrCodeFilePath(id) {
    const row = await db.prepare('SELECT file_path FROM payment_qr_codes WHERE id = ?').get(id);
    return row?.file_path || null;
  }

  async function getActiveDefaultPaymentQr(paymentMethodId) {
    const row = await db.prepare(`
      SELECT q.*
      FROM payment_qr_codes q
      WHERE q.payment_method_id = ?
        AND q.is_active = ${sql.boolTrue}
        AND q.is_default = ${sql.boolTrue}
      ORDER BY q.updated_at DESC, q.id DESC
      LIMIT 1
    `).get(paymentMethodId);
    if (!row) return null;
    return {
      ...hydratePaymentQrRow(row),
      file_path: row.file_path
    };
  }

  async function countPaymentQrUsage(id) {
    const row = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM registration_payment_windows
      WHERE payment_qr_code_id = ?
    `).get(id);
    return Number(row?.count || 0);
  }

  async function createPaymentQrCode({ paymentMethodId, filePath, label = null, isActive = true, isDefault = false }) {
    const now = nowIso();
    const existing = await listPaymentQrCodes(paymentMethodId);
    const shouldDefault = isDefault || existing.length === 0;
    const result = await db.prepare(`
      INSERT INTO payment_qr_codes (
        payment_method_id, label, file_path, is_default, is_active, created_at, updated_at
      )
      VALUES (?, ?, ?, ${sql.boolLiteral(shouldDefault)}, ${sql.boolLiteral(isActive)}, ?, ?)
    `).run(paymentMethodId, label || null, filePath, now, now);
    const id = result.lastInsertRowid;
    if (shouldDefault) {
      await clearDefaultPaymentQrExcept(paymentMethodId, id);
    }
    return await getPaymentQrCode(id);
  }

  async function clearDefaultPaymentQrExcept(paymentMethodId, keepId) {
    const now = nowIso();
    await db.prepare(`
      UPDATE payment_qr_codes
      SET is_default = ${sql.boolFalse}, updated_at = ?
      WHERE payment_method_id = ? AND id != ?
    `).run(now, paymentMethodId, keepId);
  }

  async function updatePaymentQrCode(id, patch = {}) {
    const current = await getPaymentQrCode(id);
    if (!current) return null;

    const nextLabel = patch.label !== undefined ? patch.label : current.label;
    let nextActive = patch.is_active !== undefined ? Boolean(patch.is_active) : current.is_active;
    let nextDefault = patch.is_default !== undefined ? Boolean(patch.is_default) : current.is_default;
    const force = Boolean(patch.force);

    if (!nextActive && nextDefault) nextDefault = false;

    if (!nextActive && current.is_default && !force) {
      const otherDefault = await db.prepare(`
        SELECT id
        FROM payment_qr_codes
        WHERE payment_method_id = ?
          AND id != ?
          AND is_active = ${sql.boolTrue}
          AND is_default = ${sql.boolTrue}
        LIMIT 1
      `).get(current.payment_method_id, id);
      if (!otherDefault) {
        const err = new Error('Cannot deactivate the only active default QR. Set another QR as default first.');
        err.code = 'LAST_ACTIVE_DEFAULT';
        throw err;
      }
      nextDefault = false;
    }

    if (!nextActive && current.is_default && force) nextDefault = false;

    const now = nowIso();
    await db.prepare(`
      UPDATE payment_qr_codes
      SET label = ?, is_active = ${sql.boolLiteral(nextActive)}, is_default = ${sql.boolLiteral(nextDefault)}, updated_at = ?
      WHERE id = ?
    `).run(nextLabel || null, now, id);

    if (nextDefault) {
      await clearDefaultPaymentQrExcept(current.payment_method_id, id);
      await db.prepare(`
        UPDATE payment_qr_codes
        SET is_default = ${sql.boolTrue}, updated_at = ?
        WHERE id = ?
      `).run(now, id);
    }

    return await getPaymentQrCode(id);
  }

  async function setDefaultPaymentQr(id) {
    const current = await getPaymentQrCode(id);
    if (!current) return null;
    if (!current.is_active) {
      const err = new Error('Only an active QR can be set as default.');
      err.code = 'INACTIVE_QR';
      throw err;
    }
    const now = nowIso();
    await clearDefaultPaymentQrExcept(current.payment_method_id, id);
    await db.prepare(`
      UPDATE payment_qr_codes
      SET is_default = ${sql.boolTrue}, updated_at = ?
      WHERE id = ?
    `).run(now, id);
    return await getPaymentQrCode(id);
  }

  async function deletePaymentQrCode(id) {
    const current = await getPaymentQrCode(id);
    if (!current) return null;

    if (current.is_default) {
      const err = new Error('Set another QR as default before deleting the current default.');
      err.code = 'DEFAULT_QR_REQUIRED';
      throw err;
    }

    const usageCount = await countPaymentQrUsage(id);
    if (usageCount > 0) {
      const deactivated = await updatePaymentQrCode(id, { is_active: false, is_default: false });
      return { action: 'deactivated', qr: deactivated, reason: 'in_use' };
    }

    const filePath = await getPaymentQrCodeFilePath(id);
    await db.prepare('DELETE FROM payment_qr_codes WHERE id = ?').run(id);
    return { action: 'deleted', qr: current, file_path: filePath || null };
  }

  async function createRegistrationPaymentWindow({
    contactId,
    telegramUserId,
    paymentMethodId,
    paymentQrCodeId = null,
    paymentDisplayName,
    firstDepositAmount,
    windowMinutes = 5
  }) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMinutes * 60 * 1000).toISOString();
    const nowText = nowIso();
    const result = await db.prepare(`
      INSERT INTO registration_payment_windows (
        contact_id, telegram_user_id, payment_method_id, payment_qr_code_id,
        payment_display_name, first_deposit_amount, status, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      contactId,
      String(telegramUserId),
      paymentMethodId,
      paymentQrCodeId,
      paymentDisplayName || null,
      firstDepositAmount,
      expiresAt,
      nowText,
      nowText
    );
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(result.lastInsertRowid);
  }

  async function getActiveRegistrationPaymentWindow(contactId) {
    return await db.prepare(`
      SELECT *
      FROM registration_payment_windows
      WHERE contact_id = ?
        AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get(contactId);
  }

  async function getRegistrationPaymentWindow(windowId) {
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  }

  async function listActiveRegistrationPaymentWindows(limit = 200) {
    const now = nowIso();
    return await db.prepare(`
      SELECT w.*, pm.name AS payment_method_name, pm.key AS payment_method_key
      FROM registration_payment_windows w
      LEFT JOIN payment_methods pm ON pm.id = w.payment_method_id
      WHERE w.status = 'active'
        AND w.expires_at >= ?
      ORDER BY w.id DESC
      LIMIT ?
    `).all(now, Math.min(Math.max(Number(limit) || 200, 1), 1000));
  }

  async function listExpiredRegistrationPaymentWindowsForMatch(limit = 200) {
    const now = nowIso();
    return await db.prepare(`
      SELECT w.*, pm.name AS payment_method_name, pm.key AS payment_method_key
      FROM registration_payment_windows w
      LEFT JOIN payment_methods pm ON pm.id = w.payment_method_id
      WHERE w.status IN ('active', 'expired')
        AND w.expires_at < ?
      ORDER BY w.expires_at DESC, w.id DESC
      LIMIT ?
    `).all(now, Math.min(Math.max(Number(limit) || 200, 1), 1000));
  }

  async function completeRegistrationPaymentWindow(windowId) {
    const now = nowIso();
    await db.prepare(`
      UPDATE registration_payment_windows
      SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(now, now, windowId);
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  }

  async function expireRegistrationPaymentWindow(windowId, { suppressNotification = false } = {}) {
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE registration_payment_windows
      SET status = 'expired',
          updated_at = ?,
          expiry_notified_at = CASE WHEN ? THEN COALESCE(expiry_notified_at, ?) ELSE expiry_notified_at END
      WHERE id = ? AND status = 'active'
    `).run(now, suppressNotification ? 1 : 0, now, windowId);
    if (!result.changes) {
      return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
    }
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  }

  async function listRegistrationPaymentWindowsForExpiryWorker(limit = 100) {
    const now = nowIso();
    return await db.prepare(`
      SELECT *
      FROM registration_payment_windows
      WHERE expires_at <= ?
        AND status IN ('active', 'expired')
        AND (status = 'active' OR expiry_notified_at IS NULL)
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    `).all(now, limit);
  }

  async function listDueRegistrationPaymentWindows(limit = 100) {
    return await listRegistrationPaymentWindowsForExpiryWorker(limit);
  }

  async function expireRegistrationPaymentWindowIfDue(windowId) {
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE registration_payment_windows
      SET status = 'expired', updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND expires_at <= ?
    `).run(now, windowId, now);
    if (!result.changes) return null;
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  }

  async function claimRegistrationPaymentWindowExpiryNotification(windowId) {
    const now = nowIso();
    const result = await db.prepare(`
      UPDATE registration_payment_windows
      SET expiry_notified_at = ?
      WHERE id = ?
        AND status = 'expired'
        AND expiry_notified_at IS NULL
        AND expires_at <= ?
    `).run(now, windowId, now);
    if (!result.changes) return null;
    return await db.prepare('SELECT * FROM registration_payment_windows WHERE id = ?').get(windowId);
  }

  async function resetRegistrationFlowToIdle(userId, actorName = 'System') {
    const user = await getUserProfile(userId);
    if (!user) return null;
    if (user.registration_status === 'Collecting Info') {
      await updateRegistrationStatus(userId, 'New', actorName);
    }
    return await updateAutomationState(userId, {
      currentFlow: null,
      currentStep: null,
      registrationInfo: {
        telegram_display_name: user.display_name,
        telegram_username: user.username || null,
        telegram_user_id: user.telegram_id
      }
    });
  }

  function toPublicLedgerUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      is_active: row.is_active === undefined || row.is_active === null
        ? true
        : (typeof row.is_active === 'boolean' ? row.is_active : Boolean(row.is_active)),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async function getLedgerUserByUsername(username) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return null;
    return (await db.prepare('SELECT * FROM ledger_users WHERE LOWER(username) = ?').get(normalized)) || null;
  }

  async function getLedgerUserById(id) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const row = await db.prepare('SELECT * FROM ledger_users WHERE id = ?').get(userId);
    return row ? toPublicLedgerUser(row) : null;
  }

  async function listLedgerUsers() {
    const rows = await db.prepare(`
      SELECT id, username, role, is_active, created_at, updated_at
      FROM ledger_users
      ORDER BY username ASC
    `).all();
    return rows.map((row) => toPublicLedgerUser(row));
  }

  async function createLedgerUser({ username, passwordHash, role = 'staff', isActive = true }) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) throw new Error('Username is required.');
    if (!passwordHash) throw new Error('Password hash is required.');
    const safeRole = role === 'admin' ? 'admin' : 'staff';
    const timestamp = nowIso();
    const result = await db.prepare(`
      INSERT INTO ledger_users (username, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      normalized,
      passwordHash,
      safeRole,
      isActive ? 1 : 0,
      timestamp,
      timestamp
    );
    return toPublicLedgerUser(await db.prepare('SELECT * FROM ledger_users WHERE id = ?').get(result.lastInsertRowid));
  }

  async function updateLedgerUser(id, patch = {}) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const current = await db.prepare('SELECT * FROM ledger_users WHERE id = ?').get(userId);
    if (!current) return null;

    const fields = [];
    const values = [];
    if (patch.role !== undefined) {
      fields.push('role = ?');
      values.push(patch.role === 'admin' ? 'admin' : 'staff');
    }
    if (patch.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(patch.is_active ? 1 : 0);
    }
    if (patch.password_hash) {
      fields.push('password_hash = ?');
      values.push(patch.password_hash);
    }
    if (!fields.length) return toPublicLedgerUser(current);

    fields.push('updated_at = ?');
    values.push(nowIso());
    values.push(userId);
    await db.prepare(`UPDATE ledger_users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return toPublicLedgerUser(await db.prepare('SELECT * FROM ledger_users WHERE id = ?').get(userId));
  }

  return {
    db,
    upsertTelegramUser,
    ensureConversation,
    storeIncomingTelegramMessage,
    storeOutgoingMessage,
    claimOutgoingMessageRequest,
    completeOutgoingMessageRequest,
    releaseOutgoingMessageRequest,
    queueTelegramOutboundMessage,
    setTelegramOutboundLocalMessage,
    listUsers,
    getStats,
    getUserProfile,
    listMessagesForUser,
    listNotesForUser,
    listTimelineForUser,
    listTags,
    updateRegistrationStatus,
    listAutomationRules,
    ensureAutomationState,
    getAutomationState,
    updateAutomationState,
    setAutomationIntent,
    logAutomationDecision,
    listAutomationLogsForUser,
    startAutomationFlow,
    cancelAutomationFlow,
    resetAutomationState,
    updateRegistrationInfo,
    markRegistrationInfoReviewed,
    markAutoWelcomeSent,
    checkRegistrationDuplicates,
    completeRegistration,
    markAppBegPlayerCreated,
    manualRegister,
    listPlayers,
    listRegisteredPlayersForPaymentMatch,
    getPlayerStats,
    getPlayerDetail,
    approvePlayer,
    rejectPlayer,
    reactivatePlayer,
    suspendPlayer,
    logRegistrationFieldChange,
    addNote,
    setUserTags,
    listQuickReplies,
    listStaffAssignees,
    ensureBotSession,
    getBotSession,
    setBotScreen,
    goBackBotScreen,
    resetBotState,
    markConversationRead,
    updateConversationStatus,
    assignConversation,
    updateProfilePhoto,
    getTelegramAccountSyncState,
    updateTelegramAccountSyncState,
    logAccountSync,
    listAccountSyncLogs,
    getContactPreferredMessageSource,
    getCoadminSettings,
    getStaffAiApprenticeSettings,
    setStaffAiApprenticeModeEnabled,
    getCustomerSupportAiSettings,
    setCustomerSupportAiMode,
    pauseContactAiAuto,
    findStaffAiTrainingReply,
    searchApprovedSupportAiTraining,
    hydrateContactAiSettings,
    createStaffAiTrainingDraft,
    getStaffAiTrainingExample,
    getLatestStaffAiTrainingDraftForContact,
    beginStaffAiDraftGeneration,
    completeStaffAiDraftGeneration,
    failStaffAiDraftGeneration,
    markStaffAiTrainingFeedback,
    completeStaffAiTrainingExampleOnSend,
    getAutoRegistrationBotSettings,
    setAutoRegistrationBotEnabled,
    isIncomingMessageEligibleForAutoBot,
    getIncomingMessageSentAt,
    updateCoadminSettings,
    buildCoadminSnapshot,
    assignCoadminToUser,
    applyCoadminToExistingBusinessContacts,
    listBusinessAccountContactIds,
    listSettingsAuditLog,
    listPaymentEvents,
    getPaymentEvent,
    getPaymentEventByTelegramMessageId,
    getPaymentStats,
    listUnroutedPaymentEvents,
    ensurePaymentIdempotencyKey,
    applyPaymentParseResult,
    updatePaymentRouting,
    resetPaymentRoutingForReprocess,
    markPaymentIgnored,
    manuallyLinkPaymentEvent,
    logPaymentRouting,
    listPaymentRoutingLogs,
    createDepositEvent,
    getDepositEvent,
    listDepositEvents,
    expireStaleDepositEvents,
    findActiveDepositByPaymentTag,
    findLatestExpiredDepositByPaymentTag,
    completeDepositEvent,
    cancelDepositEvent,
    getPaymentSyncState,
    updatePaymentSyncState,
    logPaymentListener,
    listPaymentListenerLogs,
    createBotJob,
    findExistingBotJobForTelegramMessage,
    nudgeBotQueue,
    claimNextBotJob,
    completeBotJob,
    resetStuckBotJobs,
    reclaimStuckBotJobs,
    setBotControl,
    markBotNeedsStaffReview,
    findLatestIncomingMessageId,
    getActiveDefaultPaymentQr,
    listPaymentMethods,
    listActivePaymentMethodsForRegistration,
    getPaymentMethod,
    getPaymentMethodByKey,
    createPaymentMethod,
    updatePaymentMethod,
    deletePaymentMethod,
    listPaymentQrCodes,
    getPaymentQrCode,
    getPaymentQrCodeFilePath,
    countPaymentQrUsage,
    createPaymentQrCode,
    updatePaymentQrCode,
    setDefaultPaymentQr,
    deletePaymentQrCode,
    createRegistrationPaymentWindow,
    getActiveRegistrationPaymentWindow,
    getRegistrationPaymentWindow,
    listActiveRegistrationPaymentWindows,
    listExpiredRegistrationPaymentWindowsForMatch,
    completeRegistrationPaymentWindow,
    expireRegistrationPaymentWindow,
    listDueRegistrationPaymentWindows,
    listRegistrationPaymentWindowsForExpiryWorker,
    expireRegistrationPaymentWindowIfDue,
    claimRegistrationPaymentWindowExpiryNotification,
    resetRegistrationFlowToIdle,
    getLedgerUserByUsername,
    getLedgerUserById,
    listLedgerUsers,
    createLedgerUser,
    updateLedgerUser,
    toPublicLedgerUser
  };
}

function hydrateUser(user) {
  const aiMode = String(user.ai_mode || '').trim().toLowerCase() === 'auto' ? 'auto' : 'train';
  const aiAutoPaused = user.ai_auto_paused === true
    || user.ai_auto_paused === 1
    || user.ai_auto_paused === '1'
    || user.ai_auto_paused === 'true';
  return {
    ...user,
    bot_enabled: user.bot_enabled === undefined || user.bot_enabled === null ? true : Boolean(user.bot_enabled),
    bot_paused: Boolean(user.bot_paused),
    needs_staff_review: Boolean(user.needs_staff_review),
    ai_mode: aiMode,
    ai_auto_paused: aiAutoPaused,
    tags: parseJsonField(user.tags_json, []).filter((tag) => tag && tag.id),
    tags_json: undefined
  };
}

function hydrateAutomationRule(rule) {
  return {
    ...rule,
    keywords: parseJsonField(rule.keywords_json, []),
    buttons: parseJsonField(rule.buttons_json, [])
  };
}

function hydrateAutomationState(state) {
  return {
    ...state,
    registration_info: parseJsonField(state.registration_info_json, {}),
    intents: parseJsonField(state.intents_json, {}),
    last_auto_welcome_at: state.last_auto_welcome_at
  };
}

function hydrateStaffAiTrainingExample(row) {
  return {
    ...row,
    id: row.id != null ? Number(row.id) : row.id,
    contact_id: row.contact_id != null ? Number(row.contact_id) : row.contact_id,
    incoming_message_id: row.incoming_message_id != null ? Number(row.incoming_message_id) : row.incoming_message_id,
    detected_entities: parseJsonField(row.detected_entities_json, {}),
    conversation_history: row.conversation_history || row.conversation_context || '',
    entities: parseJsonField(row.entities_json || row.detected_entities_json, {}),
    ai_reply: row.ai_reply || row.ai_draft_reply || '',
    staff_reply: row.staff_reply || row.final_staff_reply || '',
    was_edited: Boolean(row.was_edited),
    was_registered: row.was_registered === true || row.was_registered === 1 || row.was_registered === '1',
    action_executed: row.action_executed === true || row.action_executed === 1 || row.action_executed === '1',
    edit_distance_percent: row.edit_distance_percent == null ? null : Number(row.edit_distance_percent),
    confidence: row.confidence == null ? null : Number(row.confidence),
    recommended_action: row.recommended_action || parseJsonField(row.entities_json, {}).recommended_action || null,
    approved: row.approved === true || row.approved === 1 || row.approved === '1',
    feedback: row.feedback || row.reply_used || null,
    ai_reply_rejected: row.ai_reply_rejected === true || row.ai_reply_rejected === 1 || row.ai_reply_rejected === '1',
    normalized_customer_message: row.normalized_customer_message || null,
    generation_id: row.generation_id || null,
    draft_status: row.draft_status || (row.final_staff_reply ? (row.feedback === 'bad' ? 'rejected' : 'approved') : 'ready')
  };
}

function hydratePlayer(row) {
  const info = parseJsonField(row.registration_info_json, {});
  const tags = parseJsonField(row.tags_json, []).filter((tag) => tag && tag.id);
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    display_name: row.display_name,
    username: row.username,
    registration_status: row.registration_status,
    registration_method: row.registration_method || info.registration_method || null,
    appbeg_username: info.preferred_appbeg_username || row.appbeg_account_id || null,
    payment_tag: info.payment_tag || null,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
    first_seen: row.first_seen,
    phone_number: row.phone_number,
    info_reviewed_at: row.info_reviewed_at,
    info_reviewed_by: row.info_reviewed_by,
    notes_text: row.notes_text || '',
    tags,
    registration_info: info
  };
}

function hydratePaymentEvent(event) {
  let raw_payload = {};
  try {
    raw_payload = JSON.parse(event.raw_payload_json || '{}');
  } catch {
    raw_payload = { parseError: true };
  }
  return {
    ...event,
    id: event.id != null ? Number(event.id) : event.id,
    telegram_message_id: event.telegram_message_id != null ? Number(event.telegram_message_id) : event.telegram_message_id,
    contact_id: event.contact_id != null ? Number(event.contact_id) : event.contact_id,
    registration_payment_window_id: event.registration_payment_window_id != null
      ? Number(event.registration_payment_window_id)
      : event.registration_payment_window_id,
    raw_payload
  };
}

function hydrateDepositEvent(event) {
  return {
    ...event,
    window_minutes: depositWindowMinutes()
  };
}

async function migrateLegacyChimeQrData(db) {
  const hasChimeTable = await tableExists(db, 'chime_qr_codes');
  if (!hasChimeTable) return;

  const now = new Date().toISOString();
  let chimeMethod = await db.prepare("SELECT id FROM payment_methods WHERE key = 'chime'").get();
  if (!chimeMethod) {
    const result = await db.prepare(`
      INSERT INTO payment_methods (name, key, is_active, display_order, created_at, updated_at)
      VALUES ('Chime', 'chime', 1, 1, ?, ?)
    `).run(now, now);
    chimeMethod = { id: result.lastInsertRowid };
  }

  const legacyRows = await db.prepare('SELECT * FROM chime_qr_codes').all();
  const legacyIdMap = new Map();

  for (const row of legacyRows) {
    const existing = await db.prepare('SELECT id FROM payment_qr_codes WHERE file_path = ?').get(row.file_path);
    if (existing) {
      legacyIdMap.set(row.id, existing.id);
      continue;
    }
    const result = await db.prepare(`
      INSERT INTO payment_qr_codes (
        payment_method_id, label, file_path, is_default, is_active, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      chimeMethod.id,
      row.label || null,
      row.file_path,
      row.is_default ? 1 : 0,
      row.is_active ? 1 : 0,
      row.created_at || now,
      row.updated_at || now
    );
    legacyIdMap.set(row.id, result.lastInsertRowid);
  }

  const windowColumns = await db.prepare("PRAGMA table_info(registration_payment_windows)").all();
  const columnNames = new Set(windowColumns.map((col) => col.name));
  if (columnNames.has('qr_code_id')) {
    const windows = await db.prepare(`
      SELECT id, qr_code_id, chime_payment_name, payment_app
      FROM registration_payment_windows
      WHERE payment_qr_code_id IS NULL
    `).all();
    for (const window of windows) {
      const mappedQrId = window.qr_code_id ? legacyIdMap.get(window.qr_code_id) || null : null;
      await db.prepare(`
        UPDATE registration_payment_windows
        SET payment_method_id = COALESCE(payment_method_id, ?),
            payment_qr_code_id = COALESCE(payment_qr_code_id, ?),
            payment_display_name = COALESCE(payment_display_name, ?)
        WHERE id = ?
      `).run(chimeMethod.id, mappedQrId, window.chime_payment_name || null, window.id);
    }
  }
}

async function migrate(db) {
  await db.exec('PRAGMA foreign_keys = OFF');
  const schema = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_users'").get()?.sql || '';
  if (schema && (!schema.includes("'Archived'") || !schema.includes("'Collecting Info'"))) {
    await db.exec(`
      ALTER TABLE telegram_users RENAME TO telegram_users_old;
    `);
  }

  await db.exec(fs.readFileSync(schemaPath, 'utf8'));

  if (await tableExists(db, 'telegram_users_old')) {
    await db.exec(`
      INSERT INTO telegram_users (
        id, telegram_id, username, first_name, last_name, display_name, language_code,
        is_bot, registration_status, appbeg_account_id, registered_at, suspended_at,
        first_seen, last_seen, created_at, updated_at
      )
      SELECT
        id, telegram_id, username, first_name, last_name, display_name, language_code,
        is_bot,
        CASE
          WHEN registration_status IN ('New', 'Collecting Info', 'Pending', 'Pending Verification', 'Registered', 'Suspended', 'Archived') THEN registration_status
          ELSE 'New'
        END,
        appbeg_account_id, registered_at, suspended_at,
        first_seen, last_seen, created_at, updated_at
      FROM telegram_users_old;
      DROP TABLE telegram_users_old;
    `);
  }

  const conversationSchema = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get()?.sql || '';
  if (
    await tableReferences(db, 'conversations', 'telegram_users_old') ||
    await tableReferences(db, 'messages', 'telegram_users_old') ||
    (conversationSchema && !conversationSchema.includes("'Waiting'"))
  ) {
    await rebuildConversationTables(db);
  }

  if (
    await tableReferences(db, 'activity_events', 'telegram_users_old') ||
    await tableReferences(db, 'bot_sessions', 'telegram_users_old') ||
    await tableReferences(db, 'internal_notes', 'telegram_users_old') ||
    await tableReferences(db, 'telegram_user_tags', 'telegram_users_old') ||
    await tableReferences(db, 'contact_automation_state', 'telegram_users_old') ||
    await tableReferences(db, 'automation_logs', 'telegram_users_old')
  ) {
    await rebuildUserChildTables(db);
  }

  for (const column of [
    ['phone_number', 'TEXT'],
    ['presence_status', 'TEXT'],
    ['last_online_at', 'TEXT'],
    ['profile_photo_file_id', 'TEXT'],
    ['profile_photo_url', 'TEXT'],
    ['staff_assignee_id', 'TEXT'],
    ['appbeg_link_status', 'TEXT'],
    ['payment_profile_status', 'TEXT'],
    ['verification_status', 'TEXT'],
    ['archived_at', 'TEXT'],
    ['telegram_sync_source', 'TEXT'],
    ['telegram_source_account_id', 'TEXT'],
    ['telegram_source_account_username', 'TEXT'],
    ['registration_method', 'TEXT'],
    ['bot_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['bot_paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['needs_staff_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['bot_paused_at', 'TEXT'],
    ['bot_paused_by', 'TEXT'],
    ['staff_review_reason', 'TEXT'],
    ['staff_review_at', 'TEXT'],
    ['ai_mode', "TEXT NOT NULL DEFAULT 'train'"],
    ['ai_auto_paused', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['ai_mode_updated_at', 'TEXT'],
    ['ai_mode_updated_by', 'TEXT']
  ]) {
    await addColumnIfMissing(db, 'telegram_users', column[0], column[1]);
  }

  await addColumnIfMissing(db, 'contact_automation_state', 'last_auto_welcome_at', 'TEXT');

  await addColumnIfMissing(db, 'messages', 'source', "TEXT NOT NULL DEFAULT 'bot_api'");

  for (const column of [
    ['parsed_recipient_tag', 'TEXT'],
    ['parsed_recipient_tag_normalized', 'TEXT'],
    ['parsed_amount', 'REAL'],
    ['parsed_sender_name', 'TEXT'],
    ['parsed_payment_datetime', 'TEXT'],
    ['parsed_total_in', 'REAL'],
    ['parsed_total_out', 'REAL'],
    ['parse_error', 'TEXT'],
    ['routing_status', "TEXT NOT NULL DEFAULT 'unrouted'"],
    ['routing_owner', 'TEXT'],
    ['contact_id', 'INTEGER'],
    ['deposit_event_id', 'INTEGER'],
    ['teleledger_payment_id', 'TEXT'],
    ['teleledger_sync_status', 'TEXT'],
    ['idempotency_key', 'TEXT'],
    ['routed_at', 'TEXT'],
    ['handled_by', 'TEXT'],
    ['parsed_payment_app', 'TEXT'],
    ['parsed_message_time', 'TEXT'],
    ['registration_payment_window_id', 'INTEGER'],
    ['routing_reason', 'TEXT']
  ]) {
    await addColumnIfMissing(db, 'payment_events', column[0], column[1]);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS deposit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
      payment_tag_normalized TEXT NOT NULL,
      payment_tag_display TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      started_by TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      notes TEXT,
      linked_payment_event_id INTEGER REFERENCES payment_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_routing_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_event_id INTEGER NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec('CREATE INDEX IF NOT EXISTS idx_payment_events_routing_status ON payment_events(routing_status, message_date DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_deposit_events_tag_status ON deposit_events(payment_tag_normalized, status, expires_at DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_payment_routing_logs_payment ON payment_routing_logs(payment_event_id, created_at DESC)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_idempotency_key ON payment_events(idempotency_key) WHERE idempotency_key IS NOT NULL');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS account_sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_account_sync_logs_created ON account_sync_logs(created_at DESC)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS registration_info_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_registration_info_history_user_created ON registration_info_history(telegram_user_id, created_at DESC)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS outgoing_message_requests (
      client_request_id TEXT NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      response_json TEXT,
      message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      PRIMARY KEY (client_request_id, telegram_user_id),
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_outbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      buttons_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
      error_text TEXT,
      telegram_message_id INTEGER,
      local_message_id INTEGER,
      client_request_id TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (local_message_id) REFERENCES messages(id) ON DELETE SET NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_outbound_status_created ON telegram_outbound_messages(status, created_at ASC, id ASC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_outbound_contact_created ON telegram_outbound_messages(contact_id, created_at DESC)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_outbound_client_request ON telegram_outbound_messages(client_request_id, contact_id) WHERE client_request_id IS NOT NULL');
  await addColumnIfMissing(db, 'telegram_outbound_messages', 'buttons_json', "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing(db, 'telegram_outbound_messages', 'media_path', 'TEXT');
  await addColumnIfMissing(db, 'telegram_outbound_messages', 'message_type', "TEXT NOT NULL DEFAULT 'text'");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_qr_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_method_id INTEGER NOT NULL,
      label TEXT,
      file_path TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS registration_payment_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      payment_method_id INTEGER,
      payment_qr_code_id INTEGER,
      payment_display_name TEXT,
      first_deposit_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      expiry_notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE SET NULL,
      FOREIGN KEY (payment_qr_code_id) REFERENCES payment_qr_codes(id) ON DELETE SET NULL
    )
  `);

  await addColumnIfMissing(db, 'registration_payment_windows', 'payment_method_id', 'INTEGER');
  await addColumnIfMissing(db, 'registration_payment_windows', 'payment_qr_code_id', 'INTEGER');
  await addColumnIfMissing(db, 'registration_payment_windows', 'payment_display_name', 'TEXT');
  await addColumnIfMissing(db, 'registration_payment_windows', 'expiry_notified_at', 'TEXT');

  await db.exec('CREATE INDEX IF NOT EXISTS idx_payment_methods_active_order ON payment_methods(is_active, display_order ASC, id ASC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_payment_qr_codes_method_default ON payment_qr_codes(payment_method_id, is_active, is_default, updated_at DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_registration_payment_windows_contact_status ON registration_payment_windows(contact_id, status, expires_at DESC)');

  await migrateLegacyChimeQrData(db);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bot_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      message_id INTEGER,
      incoming_telegram_message_id INTEGER,
      job_type TEXT NOT NULL DEFAULT 'inbound_message',
      input_text TEXT,
      action TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      worker_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_bot_jobs_status_created ON bot_jobs(status, created_at ASC, id ASC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_created ON bot_jobs(contact_id, created_at DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_bot_jobs_contact_telegram_message ON bot_jobs(contact_id, job_type, incoming_telegram_message_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS coadmin_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      coadmin_name TEXT,
      coadmin_code TEXT,
      appbeg_coadmin_uid TEXT,
      telegram_account_username TEXT,
      telegram_account_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )
  `);
  await addColumnIfMissing(db, 'coadmin_settings', 'auto_registration_bot_enabled', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(db, 'coadmin_settings', 'auto_registration_bot_enabled_at', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'auto_registration_bot_updated_at', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'auto_registration_bot_updated_by', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'staff_ai_apprentice_mode_enabled', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(db, 'coadmin_settings', 'staff_ai_apprentice_mode_updated_at', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'staff_ai_apprentice_mode_updated_by', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'customer_support_ai_mode', "TEXT NOT NULL DEFAULT 'train'");
  await addColumnIfMissing(db, 'coadmin_settings', 'customer_support_ai_mode_updated_at', 'TEXT');
  await addColumnIfMissing(db, 'coadmin_settings', 'customer_support_ai_mode_updated_by', 'TEXT');
  await db.prepare('INSERT OR IGNORE INTO coadmin_settings (id, updated_at) VALUES (1, CURRENT_TIMESTAMP)').run();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff_ai_training_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      telegram_user_id TEXT,
      incoming_message_id INTEGER,
      customer_message TEXT,
      conversation_context TEXT,
      detected_intent TEXT,
      detected_entities_json TEXT NOT NULL DEFAULT '{}',
      ai_draft_reply TEXT,
      final_staff_reply TEXT,
      staff_user_id TEXT,
      staff_username TEXT,
      was_edited INTEGER NOT NULL DEFAULT 0,
      edit_distance_percent REAL,
      staff_feedback_reason TEXT,
      outcome TEXT NOT NULL DEFAULT 'drafted',
      language TEXT,
      sentiment TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      FOREIGN KEY (contact_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (incoming_message_id) REFERENCES messages(id) ON DELETE SET NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_contact_created ON staff_ai_training_examples(contact_id, created_at DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_outcome_created ON staff_ai_training_examples(outcome, created_at DESC)');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'conversation_history', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'entities_json', "TEXT NOT NULL DEFAULT '{}'");
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'ai_reply', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'staff_reply', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'reply_used', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'confidence', 'REAL');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'was_registered', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'registration_status', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'registration_step', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'payment_window_status', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'appbeg_player_uid', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'recommended_action', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'action_executed', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'action_blocked_reason', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'approved', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'feedback', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'ai_reply_rejected', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'normalized_customer_message', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'generation_id', 'TEXT');
  await addColumnIfMissing(db, 'staff_ai_training_examples', 'draft_status', "TEXT NOT NULL DEFAULT 'ready'");
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_generation_id ON staff_ai_training_examples(generation_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_contact_message_status ON staff_ai_training_examples(contact_id, incoming_message_id, draft_status)');
  await db.exec(`
    UPDATE staff_ai_training_examples
    SET draft_status = 'approved'
    WHERE sent_at IS NOT NULL
      AND TRIM(COALESCE(final_staff_reply, staff_reply, '')) != ''
      AND COALESCE(feedback, reply_used) = 'good'
      AND draft_status = 'ready'
  `);
  await db.exec(`
    UPDATE staff_ai_training_examples
    SET draft_status = 'rejected'
    WHERE sent_at IS NOT NULL
      AND TRIM(COALESCE(final_staff_reply, staff_reply, '')) != ''
      AND COALESCE(feedback, reply_used) = 'bad'
      AND draft_status = 'ready'
  `);
  await db.exec(`
    UPDATE staff_ai_training_examples
    SET draft_status = 'stale'
    WHERE outcome = 'drafted'
      AND final_staff_reply IS NULL
      AND draft_status = 'ready'
      AND incoming_message_id IS NOT NULL
      AND incoming_message_id != (
        SELECT id FROM messages
        WHERE telegram_user_id = staff_ai_training_examples.contact_id
          AND direction = 'incoming'
        ORDER BY id DESC
        LIMIT 1
      )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_normalized_message ON staff_ai_training_examples(normalized_customer_message)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_staff_ai_training_approved_sent ON staff_ai_training_examples(approved, sent_at DESC)');
  await db.exec(`
    UPDATE staff_ai_training_examples
    SET approved = ${sql.boolTrue},
        feedback = COALESCE(feedback, reply_used, CASE WHEN was_edited = 0 THEN 'good' ELSE 'bad' END),
        ai_reply_rejected = CASE
          WHEN COALESCE(feedback, reply_used) = 'bad' THEN ${sql.boolTrue}
          WHEN was_edited = 1 AND COALESCE(feedback, reply_used) IS NULL THEN ${sql.boolTrue}
          ELSE ${sql.boolFalse}
        END
    WHERE sent_at IS NOT NULL
      AND TRIM(COALESCE(final_staff_reply, staff_reply, '')) != ''
      AND approved = ${sql.boolFalse}
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settings_key TEXT NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created ON settings_audit_log(created_at DESC)');

  for (const tag of DEFAULT_TAGS) {
    await db.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)').run(tag.name, tag.color);
  }

  for (const reply of DEFAULT_QUICK_REPLIES) {
    await db.prepare(`
      INSERT INTO quick_replies (label, body, sort_order)
      VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET
        body = excluded.body,
        sort_order = excluded.sort_order,
        updated_at = CURRENT_TIMESTAMP
    `).run(reply.label, reply.body, reply.sort_order);
  }

  for (const rule of DEFAULT_AUTOMATION_RULES) {
    await db.prepare(`
      INSERT INTO automation_rules (
        name, keywords_json, match_type, contact_status_condition, response_type,
        response_message, buttons_json, flow_key, intent_key, conversation_status,
        enabled, priority, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET
        keywords_json = excluded.keywords_json,
        match_type = excluded.match_type,
        contact_status_condition = excluded.contact_status_condition,
        response_type = excluded.response_type,
        response_message = excluded.response_message,
        buttons_json = excluded.buttons_json,
        flow_key = excluded.flow_key,
        intent_key = excluded.intent_key,
        conversation_status = excluded.conversation_status,
        priority = excluded.priority,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      rule.name,
      JSON.stringify(rule.keywords),
      rule.match_type,
      rule.contact_status_condition,
      rule.response_type,
      rule.response_message,
      JSON.stringify(rule.buttons || []),
      rule.flow_key ?? null,
      rule.intent_key ?? null,
      rule.conversation_status ?? null,
      rule.priority
    );
  }

  await db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_status_assignee ON conversations(status, assigned_staff_name)');
  await db.exec('DROP INDEX IF EXISTS idx_messages_unique_telegram_incoming');
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_source_telegram
    ON messages(source, conversation_id, telegram_message_id, direction)
    WHERE telegram_message_id IS NOT NULL`);
  await db.exec(`INSERT INTO telegram_account_sync_state (id, status, updated_at)
    VALUES (1, 'disabled', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING`);
  await db.exec(`INSERT INTO payment_sync_state (id, status, updated_at)
    VALUES (1, 'disabled', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_users_username ON ledger_users(username)');

  const users = await db.prepare('SELECT id, created_at, first_seen FROM telegram_users').all();
  const eventCount = await db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE telegram_user_id = ? AND event_type = ?');
  const insertEvent = db.prepare(`
    INSERT INTO activity_events (telegram_user_id, event_type, title, body, actor_name, metadata_json, created_at)
    VALUES (?, ?, ?, ?, 'System', NULL, ?)
  `);
  for (const user of users) {
    db.prepare(`
      INSERT INTO bot_sessions (telegram_user_id, current_screen, state_stack_json, context_json)
      VALUES (?, 'Home', '[]', '{}')
      ON CONFLICT(telegram_user_id) DO NOTHING
    `).run(user.id);

    if (eventCount.get(user.id, 'user_created').count === 0) {
      insertEvent.run(user.id, 'user_created', 'User Created', 'Telegram user profile exists in the CRM.', user.first_seen || user.created_at);
    }
    if (eventCount.get(user.id, 'first_message').count === 0) {
      const firstMessage = await db.prepare('SELECT text, message_type, sent_at FROM messages WHERE telegram_user_id = ? ORDER BY sent_at ASC, id ASC LIMIT 1').get(user.id);
      if (firstMessage) {
        insertEvent.run(user.id, 'first_message', 'First Message', firstMessage.text || `[${firstMessage.message_type}]`, firstMessage.sent_at);
      }
    }
  }

  await db.exec('PRAGMA foreign_keys = ON');
}

async function tableExists(db, tableName) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

async function tableReferences(db, tableName, referenceName) {
  const sql = (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName))?.sql || '';
  return sql.includes(referenceName);
}

async function rebuildConversationTables(db) {
  await db.exec(`
    DROP INDEX IF EXISTS idx_messages_unique_telegram_incoming;
    DROP INDEX IF EXISTS idx_conversations_user;
    DROP INDEX IF EXISTS idx_messages_conversation_sent;

    ALTER TABLE messages RENAME TO messages_rebuild_old;
    ALTER TABLE conversations RENAME TO conversations_rebuild_old;

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'telegram_private',
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Waiting', 'Closed')),
      assigned_staff_name TEXT,
      assigned_at TEXT,
      last_read_message_id INTEGER,
      last_read_at TEXT,
      registration_context_json TEXT,
      payment_context_json TEXT,
      appbeg_context_json TEXT,
      first_message_at TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      UNIQUE (telegram_user_id, channel)
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      telegram_message_id INTEGER,
      source TEXT NOT NULL DEFAULT 'bot_api',
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      sender_type TEXT NOT NULL CHECK (sender_type IN ('telegram_user', 'bot', 'staff', 'system')),
      message_type TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      payload_json TEXT,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
    );

    INSERT INTO conversations (
      id, telegram_user_id, channel, status, registration_context_json, payment_context_json,
      appbeg_context_json, first_message_at, last_message_at, created_at, updated_at
    )
    SELECT
      id,
      telegram_user_id,
      channel,
      CASE
        WHEN status = 'closed' THEN 'Closed'
        WHEN status = 'archived' THEN 'Closed'
        WHEN status = 'Waiting' THEN 'Waiting'
        WHEN status = 'Closed' THEN 'Closed'
        ELSE 'Open'
      END,
      registration_context_json,
      payment_context_json,
      appbeg_context_json, first_message_at, last_message_at, created_at, updated_at
    FROM conversations_rebuild_old;

    INSERT INTO messages (
      id, conversation_id, telegram_user_id, telegram_message_id, source, direction, sender_type,
      message_type, text, payload_json, sent_at, created_at
    )
    SELECT
      id, conversation_id, telegram_user_id, telegram_message_id, 'bot_api', direction, sender_type,
      message_type, text, payload_json, sent_at, created_at
    FROM messages_rebuild_old;

    DROP TABLE messages_rebuild_old;
    DROP TABLE conversations_rebuild_old;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_source_telegram
      ON messages(source, conversation_id, telegram_message_id, direction)
      WHERE telegram_message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations(telegram_user_id);

    CREATE INDEX IF NOT EXISTS idx_conversations_status_assignee
      ON conversations(status, assigned_staff_name);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent
      ON messages(conversation_id, sent_at ASC, id ASC);
  `);
}

async function rebuildUserChildTables(db) {
  await db.exec(`
    DROP INDEX IF EXISTS idx_notes_user_created;
    DROP INDEX IF EXISTS idx_activity_user_created;
    DROP INDEX IF EXISTS idx_bot_sessions_user;
    DROP INDEX IF EXISTS idx_automation_logs_user_created;

    ALTER TABLE activity_events RENAME TO activity_events_rebuild_old;
    ALTER TABLE bot_sessions RENAME TO bot_sessions_rebuild_old;
    ALTER TABLE internal_notes RENAME TO internal_notes_rebuild_old;
    ALTER TABLE telegram_user_tags RENAME TO telegram_user_tags_rebuild_old;
  `);

  if (await tableExists(db, 'contact_automation_state')) {
    await db.exec('ALTER TABLE contact_automation_state RENAME TO contact_automation_state_rebuild_old;');
  }
  if (await tableExists(db, 'automation_logs')) {
    await db.exec('ALTER TABLE automation_logs RENAME TO automation_logs_rebuild_old;');
  }

  await db.exec(`
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      actor_name TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
    );

    CREATE TABLE bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      current_screen TEXT NOT NULL DEFAULT 'Home',
      workflow_key TEXT,
      workflow_step TEXT,
      state_stack_json TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      canceled_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
    );

    CREATE TABLE internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      staff_name TEXT NOT NULL,
      note_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE
    );

    CREATE TABLE telegram_user_tags (
      telegram_user_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (telegram_user_id, tag_id),
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE contact_automation_state (
      telegram_user_id INTEGER PRIMARY KEY,
      current_flow TEXT,
      current_step TEXT,
      registration_info_json TEXT NOT NULL DEFAULT '{}',
      intents_json TEXT NOT NULL DEFAULT '{}',
      last_matched_keyword TEXT,
      last_rule_id INTEGER,
      last_automation_response TEXT,
      last_automation_at TEXT,
      info_reviewed_at TEXT,
      info_reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (last_rule_id) REFERENCES automation_rules(id) ON DELETE SET NULL
    );

    CREATE TABLE automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      message_id INTEGER,
      incoming_telegram_message_id INTEGER,
      matched_keyword TEXT,
      rule_id INTEGER,
      rule_name TEXT,
      action_taken TEXT NOT NULL,
      response_sent TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
      FOREIGN KEY (rule_id) REFERENCES automation_rules(id) ON DELETE SET NULL
    );

    INSERT INTO activity_events SELECT * FROM activity_events_rebuild_old;
    INSERT INTO bot_sessions SELECT * FROM bot_sessions_rebuild_old;
    INSERT INTO internal_notes SELECT * FROM internal_notes_rebuild_old;
    INSERT INTO telegram_user_tags SELECT * FROM telegram_user_tags_rebuild_old;

    DROP TABLE activity_events_rebuild_old;
    DROP TABLE bot_sessions_rebuild_old;
    DROP TABLE internal_notes_rebuild_old;
    DROP TABLE telegram_user_tags_rebuild_old;

    CREATE INDEX IF NOT EXISTS idx_notes_user_created
      ON internal_notes(telegram_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_user_created
      ON activity_events(telegram_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bot_sessions_user
      ON bot_sessions(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_automation_logs_user_created
      ON automation_logs(telegram_user_id, created_at DESC);
  `);

  if (await tableExists(db, 'contact_automation_state_rebuild_old')) {
    const oldColumns = (await db.prepare('PRAGMA table_info(contact_automation_state_rebuild_old)').all()).map((column) => column.name);
    if (oldColumns.includes('telegram_user_id')) {
      await db.exec(`
        INSERT OR IGNORE INTO contact_automation_state (
          telegram_user_id, current_flow, current_step, registration_info_json, intents_json,
          last_matched_keyword, last_rule_id, last_automation_response, last_automation_at,
          info_reviewed_at, info_reviewed_by, created_at, updated_at
        )
        SELECT
          telegram_user_id, current_flow, current_step, registration_info_json, intents_json,
          last_matched_keyword, last_rule_id, last_automation_response, last_automation_at,
          info_reviewed_at, info_reviewed_by, created_at, updated_at
        FROM contact_automation_state_rebuild_old;
      `);
    }
    await db.exec('DROP TABLE contact_automation_state_rebuild_old;');
  }

  if (await tableExists(db, 'automation_logs_rebuild_old')) {
    await db.exec(`
      INSERT OR IGNORE INTO automation_logs (
        id, telegram_user_id, message_id, incoming_telegram_message_id, matched_keyword,
        rule_id, rule_name, action_taken, response_sent, metadata_json, created_at
      )
      SELECT
        id, telegram_user_id, message_id, incoming_telegram_message_id, matched_keyword,
        rule_id, rule_name, action_taken, response_sent, metadata_json, created_at
      FROM automation_logs_rebuild_old;
      DROP TABLE automation_logs_rebuild_old;
    `);
  }
}

async function addColumnIfMissing(db, tableName, columnName, columnType) {
  const columns = (await db.prepare(`PRAGMA table_info(${tableName})`).all()).map((column) => column.name);
  if (!columns.includes(columnName)) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}
