import {
  STAFF_CB,
  isStaffCallback,
  requireOperationalRole,
  staffFreezePayment,
  staffUnfreezePayment,
  staffIgnorePayment,
  staffRetryCredit,
  staffCreditSuggested,
  staffAssignAndCredit,
  staffAskPlayer,
  staffMessagePlayer,
  resolveFreeplayGive,
  resolveFreeplayDecline,
  controlCenterText,
  controlCenterButtons,
  deliverStaffReplyToPlayer,
  deliverPlayerNotice,
  postPlayerTopicSystemEvent
} from './staffOperations.js';
import {
  canManageHub,
  canManageStaff,
  canOperatePayments,
  canToggleConfidenceMode,
  isStaffGroupChat,
  normalizeTelegramUserId
} from './operationalRoles.js';
import { OPERATIONAL_ROLES } from './operationalRoles.js';
import {
  confidenceToggleButtons,
  staffManagementButtons,
  staffHubAccessLine,
  paymentCardText,
  paymentCardButtons,
  asTelegramSendExtra,
  assignConfirmText,
  assignConfirmButtons,
  ignoreConfirmText,
  ignoreConfirmButtons,
  hubManagementText,
  hubManagementButtons,
  freeplayCardText,
  freeplayCardButtons,
  freeplayConfirmText,
  freeplayConfirmButtons,
  freeplayIssuedPlayerText,
  freeplayNotLoadedStaffText
} from './staffCards.js';
import { describeRoyalVipHubStatus, ensureRoyalVipHubStorefront } from './royalVipHubManager.js';
import { extractSupportedInboundMedia } from './playerSupportMessaging.js';
import {
  formatStaffGrantResultText,
  formatStaffRevokeResultText,
  grantOperationalRoleWithHubAccess,
  needsHubTelegramRetry,
  revokeOperationalRoleWithHubAccess,
  syncHubChannelAdminAccess
} from './hubDirectMessages.js';

const pendingPrompts = new Map();

export function __resetStaffPendingPromptsForTests() {
  pendingPrompts.clear();
}

function setPending(actorId, payload) {
  pendingPrompts.set(String(actorId), {
    ...payload,
    expiresAt: Date.now() + 10 * 60 * 1000
  });
}

function getPending(actorId) {
  const key = String(actorId);
  const pending = pendingPrompts.get(key);
  if (!pending) return null;
  if (pending.expiresAt && pending.expiresAt < Date.now()) {
    pendingPrompts.delete(key);
    return null;
  }
  return pending;
}

function clearPending(actorId) {
  pendingPrompts.delete(String(actorId));
}

function parseId(prefix, data) {
  const raw = String(data || '');
  if (!raw.startsWith(prefix)) return null;
  const id = Number(raw.slice(prefix.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function currentOperationalActor(store, telegramUserId) {
  const actorId = normalizeTelegramUserId(telegramUserId);
  const role = actorId ? await store.getActiveOperationalRole(actorId) : null;
  if (!role || !canOperatePayments(role.role)) return null;
  return { actorId, role };
}

function logUnauthorizedStaffGroupInbound(ctx, reason) {
  console.warn('[staff-topic] unauthorized_inbound', JSON.stringify({
    telegramUserId: normalizeTelegramUserId(ctx.from?.id),
    chatId: ctx.chat?.id ?? null,
    threadId: ctx.message?.message_thread_id
      ?? ctx.callbackQuery?.message?.message_thread_id
      ?? null,
    reason,
    hasMedia: Boolean(
      ctx.message?.photo
      || ctx.message?.document
      || ctx.message?.video
      || ctx.message?.audio
      || ctx.message?.voice
    )
  }));
}

async function reply(ctx, text, extra = undefined) {
  if (extra) return ctx.reply(text, asTelegramSendExtra(extra));
  return ctx.reply(text);
}

export async function handleStaffCallbackQuery({ ctx, store, bot = null }) {
  const data = ctx.callbackQuery?.data || '';
  if (!isStaffCallback(data) && !isStaffGroupChat(ctx.chat?.id)) return false;
  const actorId = normalizeTelegramUserId(ctx.from?.id);
  const telegramBot = bot || globalThis.telegramBot || null;
  try {
    const role = await requireOperationalRole(store, actorId);

    if (data === STAFF_CB.CTRL || data === 'op:cc') {
      const mode = await store.getConfidenceMode();
      await ctx.answerCbQuery();
      await reply(ctx, controlCenterText(mode.enabled, role.role), controlCenterButtons(role.role));
      return true;
    }

    if (data === STAFF_CB.CONFIDENCE) {
      await requireOperationalRole(store, actorId, canToggleConfidenceMode);
      const mode = await store.getConfidenceMode();
      await ctx.answerCbQuery();
      await reply(ctx, `⚡ Confidence Mode: ${mode.enabled ? 'ON 🟢' : 'OFF 🔴'}`, confidenceToggleButtons());
      return true;
    }

    if (data === STAFF_CB.HUB) {
      await requireOperationalRole(store, actorId, canManageHub);
      await ctx.answerCbQuery();
      await reply(ctx, hubManagementText(), hubManagementButtons());
      return true;
    }

    if (data === STAFF_CB.HUB_REFRESH) {
      await requireOperationalRole(store, actorId, canManageHub);
      const result = await ensureRoyalVipHubStorefront({ store, bot: telegramBot });
      await ctx.answerCbQuery(result.ok ? 'Hub refreshed' : 'Hub refresh failed');
      if (!result.ok && result.reason === 'not_configured') {
        await reply(ctx, '⚠️ Royal Vip Hub is not configured.');
        return true;
      }
      if (!result.ok) {
        await reply(ctx, [
          '❌ Hub sync failed:',
          result.error || 'Bot cannot post/edit messages in Royal Vip Hub.'
        ].join('\n'));
        return true;
      }
      await reply(ctx, result.created
        ? 'Hub storefront created.'
        : (result.edited ? 'Hub storefront updated.' : 'Hub storefront is already current.'));
      return true;
    }

    if (data === STAFF_CB.HUB_STATUS) {
      await requireOperationalRole(store, actorId, canManageHub);
      const state = await store.getHubStorefrontState?.() || {};
      await ctx.answerCbQuery();
      await reply(ctx, describeRoyalVipHubStatus(state).text);
      return true;
    }

    if (data === STAFF_CB.CONF_ON || data === STAFF_CB.CONF_OFF) {
      const next = data === STAFF_CB.CONF_ON;
      const result = await store.setConfidenceMode({ enabled: next, actorTelegramUserId: actorId });
      await ctx.answerCbQuery('Confidence Mode updated');
      await reply(ctx, [
        '⚡ CONFIDENCE MODE CHANGED',
        `${result.previous ? 'ON' : 'OFF'} → ${result.enabled ? 'ON' : 'OFF'}`,
        `By: ${ctx.from?.first_name || actorId}`,
        `Time: ${result.updated_at}`
      ].join('\n'));
      return true;
    }

    if (data === STAFF_CB.PENDING_PAYMENTS) {
      const payments = await store.listPendingReviewPayments?.(15) || [];
      await ctx.answerCbQuery();
      if (!payments.length) {
        await reply(ctx, 'No pending payments.');
        return true;
      }
      for (const payment of payments.slice(0, 8)) {
        await reply(
          ctx,
          paymentCardText(payment),
          paymentCardButtons(payment.id, {
            frozen: payment.routing_status === 'frozen',
            creditFailed: payment.routing_status === 'credit_failed'
          })
        );
      }
      return true;
    }

    if (data === STAFF_CB.PENDING_FREEPLAY) {
      const requests = await store.listPendingFreeplayRequests?.(15) || [];
      await ctx.answerCbQuery();
      if (!requests.length) {
        await reply(ctx, 'No pending Freeplay requests.');
        return true;
      }
      for (const request of requests.slice(0, 8)) {
        await reply(ctx, freeplayCardText(request), freeplayCardButtons(request.id, request.contact_id));
      }
      return true;
    }

    if (data === STAFF_CB.STAFF_LIST) {
      await requireOperationalRole(store, actorId, canManageStaff);
      const roles = await store.listActiveOperationalRoles();
      await ctx.answerCbQuery();
      const lines = ['👥 STAFF', ''];
      const keyboard = staffManagementButtons().inline_keyboard.slice();
      for (const item of roles) {
        const name = item.telegram_display_name || item.telegram_user_id;
        lines.push(String(name));
        lines.push(`Role: ${String(item.role || '').toUpperCase()}`);
        lines.push(staffHubAccessLine(item));
        if (item.telegram_channel_admin_error && needsHubTelegramRetry(item)) {
          lines.push(String(item.telegram_channel_admin_error).slice(0, 180));
        }
        lines.push('');
        if (item.role !== OPERATIONAL_ROLES.ROOT_ADMIN) {
          const row = [];
          if (needsHubTelegramRetry(item)) {
            row.push({ text: 'RETRY TELEGRAM ACCESS', callback_data: `${STAFF_CB.STAFF_RETRY}${item.telegram_user_id}` });
          }
          row.push({ text: '❌ REMOVE STAFF', callback_data: `${STAFF_CB.STAFF_REVOKE}${item.telegram_user_id}` });
          keyboard.push(row);
        }
      }
      await reply(ctx, lines.join('\n').trim(), { inline_keyboard: keyboard });
      return true;
    }

    if (data === STAFF_CB.STAFF_ADD) {
      await requireOperationalRole(store, actorId, canManageStaff);
      setPending(actorId, { kind: 'add_staff' });
      await ctx.answerCbQuery();
      await reply(ctx, 'Send the Telegram user ID to grant Staff access.');
      return true;
    }

    const telegramRetryId = data.startsWith(STAFF_CB.STAFF_RETRY) ? data.slice(STAFF_CB.STAFF_RETRY.length) : null;
    if (telegramRetryId) {
      await requireOperationalRole(store, actorId, canManageStaff);
      const sync = await syncHubChannelAdminAccess({
        store,
        bot: telegramBot,
        telegramUserId: telegramRetryId
      });
      await ctx.answerCbQuery(sync.ok ? 'Hub DM access updated' : 'Still pending');
      await reply(ctx, sync.ok
        ? `Hub DM Access: ✅ for ${telegramRetryId}`
        : `Hub DM Access: ⚠️ Pending\n${sync.error || 'Telegram access is not ready.'}`);
      return true;
    }

    const revokeId = data.startsWith(STAFF_CB.STAFF_REVOKE) ? data.slice(STAFF_CB.STAFF_REVOKE.length) : null;
    if (revokeId) {
      await requireOperationalRole(store, actorId, canManageStaff);
      const result = await revokeOperationalRoleWithHubAccess(store, {
        telegramUserId: revokeId,
        revokedByTelegramUserId: actorId
      }, { bot: telegramBot });
      await ctx.answerCbQuery('Staff removed');
      await reply(ctx, formatStaffRevokeResultText(revokeId, result.telegramAccess));
      return true;
    }

    const freezeId = parseId(STAFF_CB.FREEZE, data);
    if (freezeId) {
      await staffFreezePayment(store, freezeId, actorId);
      await ctx.answerCbQuery('Frozen');
      await reply(ctx, '❄️ Payment frozen. It will not auto-match or auto-credit.');
      return true;
    }
    const unfreezeId = parseId(STAFF_CB.UNFREEZE, data);
    if (unfreezeId) {
      await staffUnfreezePayment(store, unfreezeId, actorId);
      await ctx.answerCbQuery('Unfrozen');
      await reply(ctx, '🔓 Payment returned to review.');
      return true;
    }
    const ignoreId = parseId(STAFF_CB.IGNORE, data);
    if (ignoreId) {
      await requireOperationalRole(store, actorId, canOperatePayments);
      const payment = await store.getPaymentEvent(ignoreId);
      await ctx.answerCbQuery();
      if (!payment) {
        await reply(ctx, 'Payment not found.');
        return true;
      }
      if (payment.routing_status === 'ignored' || payment.routing_status === 'duplicate_ignored') {
        await reply(ctx, 'This event is already ignored.');
        return true;
      }
      await reply(ctx, ignoreConfirmText(payment), ignoreConfirmButtons(ignoreId));
      return true;
    }
    const confirmIgnoreId = parseId(STAFF_CB.IGNORE_CONFIRM, data);
    if (confirmIgnoreId) {
      await requireOperationalRole(store, actorId, canOperatePayments);
      const result = await staffIgnorePayment(store, confirmIgnoreId, actorId);
      await ctx.answerCbQuery(result.alreadyIgnored ? 'Already ignored' : 'Ignored');
      await reply(ctx, result.alreadyIgnored
        ? 'This event is already ignored.'
        : 'Event ignored. It is not a deposit credit event.');
      return true;
    }
    const retryId = parseId(STAFF_CB.RETRY, data);
    if (retryId) {
      await staffRetryCredit(store, retryId, actorId);
      await ctx.answerCbQuery('Retry started');
      return true;
    }
    const creditId = parseId(STAFF_CB.CREDIT, data);
    if (creditId) {
      const result = await staffCreditSuggested(store, creditId, actorId);
      await ctx.answerCbQuery(result.ok ? 'Credited' : 'Credit failed');
      await reply(ctx, result.ok ? 'Payment credited.' : 'Credit failed. Use Retry — the same AppBeg key is kept.');
      return true;
    }
    const reviewId = parseId(STAFF_CB.REVIEW, data);
    if (reviewId) {
      const payment = await store.getPaymentEvent(reviewId);
      await ctx.answerCbQuery();
      if (!payment) {
        await reply(ctx, 'Payment not found.');
        return true;
      }
      await reply(
        ctx,
        paymentCardText(payment),
        paymentCardButtons(payment.id, {
          frozen: payment.routing_status === 'frozen',
          creditFailed: payment.routing_status === 'credit_failed'
        })
      );
      return true;
    }
    const assignId = parseId(STAFF_CB.ASSIGN, data);
    if (assignId) {
      setPending(actorId, { kind: 'assign_username', paymentId: assignId });
      await ctx.answerCbQuery();
      await reply(ctx, 'Enter the registered Royal VIP username to assign this payment.');
      return true;
    }
    const confirmAssignId = parseId(STAFF_CB.ASSIGN_CONFIRM, data);
    if (confirmAssignId) {
      const pending = getPending(actorId);
      if (!pending || pending.kind !== 'assign_confirm' || Number(pending.paymentId) !== confirmAssignId) {
        await ctx.answerCbQuery('Confirmation expired');
        return true;
      }
      const result = await staffAssignAndCredit(store, {
        paymentId: confirmAssignId,
        recipientContactId: pending.recipientContactId,
        payerContactId: pending.payerContactId,
        actorTelegramUserId: actorId
      });
      clearPending(actorId);
      await ctx.answerCbQuery(result.ok ? 'Credited' : 'Credit failed');
      await reply(ctx, result.ok ? 'Payment assigned and credited.' : 'Assigned but AppBeg credit failed. Use Retry Credit.');
      return true;
    }
    const askId = parseId(STAFF_CB.ASK, data);
    if (askId) {
      await staffAskPlayer(store, askId, actorId, { bot: telegramBot });
      await ctx.answerCbQuery('Asked player');
      return true;
    }
    const declineId = parseId(STAFF_CB.FP_DECLINE, data);
    if (declineId) {
      const result = await resolveFreeplayDecline(store, declineId, actorId, ctx.from?.first_name || null);
      await ctx.answerCbQuery(result.ok ? 'Declined' : 'Already resolved');
      if (result.ok) {
        const contact = result.request?.contact_id
          ? await store.getUserProfile(result.request.contact_id)
          : null;
        if (contact) {
          await deliverPlayerNotice({
            store,
            bot: globalThis.telegramBot || null,
            contact,
            text: 'Your Freeplay request was declined.'
          }).catch(() => null);
          await postPlayerTopicSystemEvent({
            store,
            bot: globalThis.telegramBot || null,
            contact,
            text: 'Freeplay request declined.'
          }).catch(() => null);
        }
      }
      return true;
    }
    const giveId = parseId(STAFF_CB.FP_GIVE, data);
    if (giveId) {
      setPending(actorId, { kind: 'fp_amount', requestId: giveId });
      await ctx.answerCbQuery();
      await reply(ctx, 'Enter Freeplay amount:');
      return true;
    }
    const confirmFpId = parseId(STAFF_CB.FP_CONFIRM, data);
    if (confirmFpId) {
      const pending = getPending(actorId);
      if (!pending || pending.kind !== 'fp_confirm' || Number(pending.requestId) !== confirmFpId) {
        await ctx.answerCbQuery('Confirmation expired');
        return true;
      }
      const result = await resolveFreeplayGive(
        store,
        confirmFpId,
        pending.amount,
        actorId,
        ctx.from?.first_name || null
      );
      clearPending(actorId);
      if (!result.ok) {
        await ctx.answerCbQuery('Already resolved');
        return true;
      }
      const approvedBy = ctx.from?.first_name || actorId;
      if (result.issued) {
        await ctx.answerCbQuery('Issued');
        const contact = result.request?.contact_id
          ? await store.getUserProfile(result.request.contact_id)
          : null;
        if (contact) {
          await deliverPlayerNotice({
            store,
            bot: globalThis.telegramBot || null,
            contact,
            text: freeplayIssuedPlayerText(pending.amount)
          }).catch(() => null);
          await postPlayerTopicSystemEvent({
            store,
            bot: globalThis.telegramBot || null,
            contact,
            text: `Freeplay approved and issued: ${pending.amount}`
          }).catch(() => null);
        }
        return true;
      }
      await ctx.answerCbQuery('Approved, not issued');
      await reply(ctx, freeplayNotLoadedStaffText({
        username: result.request?.username,
        amount: pending.amount,
        approvedBy,
        reason: result.error?.code === 'no_proven_appbeg_freeplay_endpoint'
          ? 'AppBeg Freeplay issuance is not configured.'
          : 'AppBeg Freeplay issuance failed. The request was not marked given.'
      }));
      return true;
    }
    const msgContactId = parseId(STAFF_CB.FP_MSG, data);
    if (msgContactId) {
      setPending(actorId, { kind: 'message_player', contactId: msgContactId });
      await ctx.answerCbQuery();
      await reply(ctx, 'Type the message to send this player privately.');
      return true;
    }

    await ctx.answerCbQuery();
    return true;
  } catch (error) {
    await ctx.answerCbQuery(error.code === 'FORBIDDEN' ? 'Not authorized' : (error.message || 'Action failed').slice(0, 180)).catch(() => null);
    return true;
  }
}

export async function handleStaffGroupMessage({ ctx, store, bot }) {
  if (!isStaffGroupChat(ctx.chat?.id)) return false;
  if (ctx.from?.is_bot) return true;
  const actor = await currentOperationalActor(store, ctx.from?.id);
  if (!actor) {
    logUnauthorizedStaffGroupInbound(ctx, 'no_operational_role');
    return true;
  }
  const { actorId } = actor;
  const media = extractSupportedInboundMedia(ctx.message);
  const text = String(ctx.message?.text || ctx.message?.caption || '').trim();
  if (!text && !media) return true;

  const pending = getPending(actorId);
  if (pending && !text) {
    await ctx.reply('Send a text reply for this staff action.');
    return true;
  }
  if (pending?.kind === 'add_staff') {
    try {
      await requireOperationalRole(store, actorId, canManageStaff);
      const granted = await grantOperationalRoleWithHubAccess(store, {
        telegramUserId: text,
        role: OPERATIONAL_ROLES.STAFF,
        grantedByTelegramUserId: actorId,
        telegramDisplayName: ctx.from?.first_name || null
      }, { bot: bot || globalThis.telegramBot || null });
      clearPending(actorId);
      await ctx.reply(formatStaffGrantResultText(text, granted.telegramAccess));
    } catch (error) {
      await ctx.reply(error.message || 'Could not add Staff.');
    }
    return true;
  }
  if (pending?.kind === 'assign_username') {
    const player = await store.findRegisteredRoyalVipPlayerByUsername(text);
    if (!player) {
      await ctx.reply('That username is not a registered Royal VIP player.');
      return true;
    }
    const payment = await store.getPaymentEvent(pending.paymentId);
    setPending(actorId, {
      kind: 'assign_confirm',
      paymentId: pending.paymentId,
      recipientContactId: player.id,
      payerContactId: payment?.payer_contact_id || null
    });
    await ctx.reply(
      assignConfirmText({
        payment,
        recipientUsername: player.royal_vip_username || text,
        amount: payment?.parsed_amount
      }),
      assignConfirmButtons(pending.paymentId)
    );
    return true;
  }
  if (pending?.kind === 'fp_amount') {
    const amount = Number(text.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply('Enter a valid Freeplay amount.');
      return true;
    }
    const request = await store.db?.prepare?.('SELECT * FROM support_requests WHERE id = ?').get(pending.requestId)
      || (await store.listPendingFreeplayRequests?.(50) || []).find((row) => Number(row.id) === Number(pending.requestId));
    setPending(actorId, { kind: 'fp_confirm', requestId: pending.requestId, amount });
    await ctx.reply(freeplayConfirmText(request?.username, amount), freeplayConfirmButtons(pending.requestId));
    return true;
  }
  if (pending?.kind === 'message_player') {
    if (!text) {
      await ctx.reply('Type a text message to send this player privately.');
      return true;
    }
    try {
      const result = await staffMessagePlayer(store, pending.contactId, text, actorId);
      clearPending(actorId);
      await ctx.reply(result.delivered ? 'Message sent privately.' : 'Message saved. Player delivery failed.');
    } catch (error) {
      if (error.code === 'FORBIDDEN') {
        logUnauthorizedStaffGroupInbound(ctx, 'revoked_before_forward');
        clearPending(actorId);
        return true;
      }
      await ctx.reply(error.message || 'Could not message player.');
    }
    return true;
  }

  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return true;
  const topic = await store.getStaffTopicByThread(String(ctx.chat.id), threadId);
  if (!topic) return true;
  const contact = await store.getUserProfile(topic.contact_id);
  if (!contact) return true;
  const liveActor = await currentOperationalActor(store, actorId);
  if (!liveActor) {
    logUnauthorizedStaffGroupInbound(ctx, 'revoked_before_forward');
    return true;
  }
  const delivery = await deliverStaffReplyToPlayer({
    store,
    bot: bot || globalThis.telegramBot || null,
    contact,
    text,
    media,
    actorName: ctx.from?.first_name || liveActor.actorId,
    staffGroupMessageId: ctx.message?.message_id || null
  });
  if (!delivery.delivered && !delivery.duplicate) {
    console.warn('[staff-topic] player_delivery_failed', delivery.error?.message || 'undelivered');
  }
  return true;
}

export { canManageStaff };
