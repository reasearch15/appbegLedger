import { loadSupportAiContactContext } from './supportAiContactContext.js';

function compactMessage(message) {
  return {
    id: message.id,
    direction: message.direction,
    senderType: message.sender_type,
    messageType: message.message_type,
    text: message.text || '',
    sentAt: message.sent_at
  };
}

async function getLatestRelevantPayment(store, contactId) {
  if (!store.db?.prepare) return null;
  let row = null;
  try {
    row = await store.db.prepare(`
      SELECT id, parsed_amount, parsed_sender_name, parsed_payment_app, routing_status, processing_status,
             unmatched_reason, contact_id, deposit_event_id, created_at, message_date
      FROM payment_events
      WHERE contact_id = ?
         OR deposit_event_id IN (
           SELECT id FROM deposit_events WHERE contact_id = ?
         )
      ORDER BY COALESCE(message_date, created_at) DESC, id DESC
      LIMIT 1
    `).get(contactId, contactId);
  } catch (error) {
    console.warn(`[support-ai] support_context_payment_lookup_failed contact=${contactId} error=${error.message}`);
  }
  return row ? {
    id: row.id,
    amount: row.parsed_amount,
    paymentName: row.parsed_sender_name,
    paymentApp: row.parsed_payment_app,
    routingStatus: row.routing_status,
    processingStatus: row.processing_status,
    unmatchedReason: row.unmatched_reason,
    contactId: row.contact_id,
    depositEventId: row.deposit_event_id,
    createdAt: row.created_at,
    messageDate: row.message_date
  } : null;
}

async function getPendingDeposit(store, contactId) {
  if (!store.db?.prepare) return null;
  let row = null;
  try {
    row = await store.db.prepare(`
      SELECT id, payment_tag_display, payment_tag_normalized, status, expires_at, linked_payment_event_id, created_at, updated_at
      FROM deposit_events
      WHERE contact_id = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(contactId);
  } catch (error) {
    console.warn(`[support-ai] support_context_pending_deposit_lookup_failed contact=${contactId} error=${error.message}`);
  }
  return row ? {
    id: row.id,
    paymentTag: row.payment_tag_display || row.payment_tag_normalized || null,
    status: row.status,
    expiresAt: row.expires_at,
    linkedPaymentEventId: row.linked_payment_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

async function getMatchedDeposit(store, contactId) {
  if (!store.db?.prepare) return null;
  let row = null;
  try {
    row = await store.db.prepare(`
      SELECT id, payment_tag_display, payment_tag_normalized, status, linked_payment_event_id, completed_at, created_at, updated_at
      FROM deposit_events
      WHERE contact_id = ?
        AND linked_payment_event_id IS NOT NULL
      ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
      LIMIT 1
    `).get(contactId);
  } catch (error) {
    console.warn(`[support-ai] support_context_matched_deposit_lookup_failed contact=${contactId} error=${error.message}`);
  }
  return row ? {
    id: row.id,
    paymentTag: row.payment_tag_display || row.payment_tag_normalized || null,
    status: row.status,
    linkedPaymentEventId: row.linked_payment_event_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export async function buildSupportContext({ store, contact, contactId = null, recentLimit = 10 }) {
  const id = Number(contactId || contact?.id);
  const resolvedContact = contact || await store.getUserProfile(id);
  if (!resolvedContact) throw new Error('Contact not found.');

  const { context: registrationContext, automationState, paymentWindow } = await loadSupportAiContactContext({
    store,
    contact: resolvedContact
  });
  const messages = await store.listMessagesForUser(resolvedContact.id);
  const recentMessages = messages.slice(-recentLimit).map(compactMessage);
  const coadminSettings = await store.getCoadminSettings?.().catch(() => null) || {};

  return {
    contact: {
      id: resolvedContact.id,
      telegramId: resolvedContact.telegram_id,
      displayName: resolvedContact.display_name,
      username: resolvedContact.username,
      language: resolvedContact.language_code || null,
      status: resolvedContact.registration_status || 'New',
      conversationStatus: resolvedContact.conversation_status || null,
      assignedStaffName: resolvedContact.assigned_staff_name || null,
      botPaused: Boolean(resolvedContact.bot_paused),
      needsStaffReview: Boolean(resolvedContact.needs_staff_review)
    },
    registration: {
      isRegistered: Boolean(registrationContext.is_registered),
      currentStage: registrationContext.registration_phase,
      currentStep: registrationContext.current_step || null,
      status: registrationContext.registration_status,
      pendingVerification: registrationContext.registration_status === 'Pending Verification',
      paymentConfirmed: Boolean(registrationContext.payment_confirmed),
      activePaymentWindow: paymentWindow ? {
        id: paymentWindow.id,
        status: paymentWindow.status,
        flowType: paymentWindow.flow_type || null,
        amount: paymentWindow.first_deposit_amount,
        paymentDisplayName: paymentWindow.payment_display_name,
        expiresAt: paymentWindow.expires_at
      } : null,
      failureReason: automationState?.registration_info?.failure_reason
        || automationState?.registration_info?.registration_failure_reason
        || null
    },
    player: {
      exists: Boolean(registrationContext.appbeg_player_exists),
      username: registrationContext.appbeg_username || null,
      uidPresent: Boolean(registrationContext.appbeg_player_uid),
      accountStatus: registrationContext.account_status || null,
      linkStatus: registrationContext.appbeg_link_status || null
    },
    coadmin: {
      assigned: Boolean(
        automationState?.registration_info?.coadmin_name
        || resolvedContact.assigned_staff_name
        || coadminSettings.coadmin_name
      ),
      displayName: automationState?.registration_info?.coadmin_name || coadminSettings.coadmin_name || null,
      code: automationState?.registration_info?.coadmin_code || coadminSettings.coadmin_code || null
    },
    payments: {
      latestRelevantPayment: await getLatestRelevantPayment(store, resolvedContact.id),
      pendingDeposit: await getPendingDeposit(store, resolvedContact.id),
      matchedDeposit: await getMatchedDeposit(store, resolvedContact.id)
    },
    cashout: {
      activeRequest: null,
      status: null
    },
    conversation: {
      recentMessages
    },
    automation: {
      currentFlow: automationState?.current_flow || null,
      currentStep: automationState?.current_step || null
    }
  };
}
