import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { CONVERSATION_STATUSES, createDataStore, DEFAULT_TAGS, REGISTRATION_STATUSES } from './db/index.js';
import { resolveDatabaseConfig } from './db/config.js';
import { startTelegramListener } from './telegram/bot.js';
import { renderMenu } from './telegram/menuEngine.js';
import { startRegistrationFlow } from './telegram/automationEngine.js';
import { processAutomationActionForContact, processAutomationForContact } from './telegram/processAutomation.js';
import { enqueueChatbotJob } from './telegram/chatbotProcessor.js';
import { isBotActiveForContact, isChatbotButtonAction } from './telegram/chatbotEngine.js';
import { startChatbotWorker } from './telegram/chatbotWorker.js';
import { startPaymentWindowExpiryWorker } from './telegram/paymentWindowExpiryWorker.js';
import { startTelegramAccountSync, stopTelegramAccountSync } from './telegram/accountSyncProcess.js';
import { startPaymentTelegramSync, stopPaymentTelegramSync } from './telegram/paymentSyncProcess.js';
import { listenerRoles } from './config/listeners.js';
import { routePaymentEvent, routeUnprocessedPayments, startDepositEventForContact } from './payments/router.js';
import { requestLogger } from './middleware/requestLogger.js';
import { wrapAsyncHandlers, notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { createSessionMiddleware, isAuthExemptPath, isAuthenticated, requireAuth, requireAdmin } from './middleware/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPaymentMethodRoutes } from './routes/paymentMethods.js';
import { isDebugEnabled } from './config/debug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const mediaDir = path.join(rootDir, 'data', 'media');
const port = Number(process.env.PORT || 4300);
const app = express();
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
wrapAsyncHandlers(app);
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});
let store;

async function initStore() {
  const dbConfig = resolveDatabaseConfig();
  store = await createDataStore(dbConfig);
  if (dbConfig.dialect === 'postgres') {
    try {
      const url = new URL(dbConfig.databaseUrl);
      console.log(`Database: postgres @ ${url.hostname}:${url.port || '5432'}${url.pathname}`);
    } catch {
      console.log('Database: postgres (remote)');
    }
  } else {
    console.log(`Database: sqlite (${dbConfig.databasePath})`);
  }
}

await initStore();

const sessionMiddleware = createSessionMiddleware();

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use(requestLogger());

registerAuthRoutes(app, { store });

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (isAuthExemptPath(req.path, req.method)) return next();
  return requireAuth(store)(req, res, next);
});

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(express.static(publicDir, { index: false }));
app.use('/media', (req, res, next) => {
  requireAuth(store)(req, res, () => express.static(mediaDir)(req, res, next));
});

registerHealthRoutes(app, { store });
registerPaymentMethodRoutes(app, { store, rootDir, requireAdmin });

app.get('/api/stats', async (req, res) => {
  res.json({ stats: await store.getStats() });
});

app.get('/api/users', async (req, res) => {
  res.json({ users: await store.listUsers() });
});

app.get('/api/contacts', async (req, res) => {
  res.json({ contacts: await store.listUsers() });
});

app.get('/api/users/:id', async (req, res) => {
  const user = await store.getUserProfile(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    user,
    messages: await store.listMessagesForUser(user.id),
    notes: await store.listNotesForUser(user.id),
    timeline: await store.listTimelineForUser(user.id),
    tags: await store.listTags()
  });
});

app.get('/api/contacts/:id', async (req, res) => {
  const user = await store.getUserProfile(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Contact not found.' });
  res.json({
    contact: user,
    messages: await store.listMessagesForUser(user.id),
    notes: await store.listNotesForUser(user.id),
    timeline: await store.listTimelineForUser(user.id),
    tags: await store.listTags(),
    quickReplies: await store.listQuickReplies(),
    automationState: await store.getAutomationState(user.id),
    automationLogs: await store.listAutomationLogsForUser(user.id)
  });
});

app.get('/api/tags', async (req, res) => {
  res.json({ tags: await store.listTags() });
});

app.get('/api/quick-replies', async (req, res) => {
  res.json({ quickReplies: await store.listQuickReplies() });
});

app.get('/api/staff-assignees', async (req, res) => {
  res.json({ staff: await store.listStaffAssignees() });
});

app.get('/api/players', async (req, res) => {
  res.json({
    players: await store.listPlayers({
      status: req.query.status || 'All',
      query: req.query.query || ''
    })
  });
});

app.get('/api/players/stats', async (req, res) => {
  res.json({ stats: await store.getPlayerStats() });
});

app.get('/api/players/:id', async (req, res) => {
  const detail = await store.getPlayerDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: 'Player not found.' });
  res.json(detail);
});

app.post('/api/players/:id/actions/:action', async (req, res) => {
  const id = Number(req.params.id);
  const actorName = req.body.staffName || 'Staff';
  const player = await store.getUserProfile(id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  try {
    let contact = player;
    switch (req.params.action) {
      case 'approve':
        contact = await store.approvePlayer(id, actorName);
        break;
      case 'reject':
        contact = await store.rejectPlayer(id, actorName);
        break;
      case 'suspend':
        contact = await store.suspendPlayer(id, actorName);
        break;
      case 'reactivate':
        contact = await store.reactivatePlayer(id, actorName);
        break;
      case 'register':
        contact = await store.startAutomationFlow(id, 'registration_info', actorName);
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${req.params.action}` });
    }
    io.emit('players:changed', { playerId: id });
    io.emit('player:updated', { playerId: id });
    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('contact:changed', { contactId: id, userId: id });
    res.json({ ok: true, contact });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/settings/registration', async (req, res) => {
  res.json({
    settings: {
      completionStatus: process.env.REGISTRATION_FLOW_COMPLETION_STATUS || 'Pending Verification',
      welcomeCooldownHours: Number(process.env.WELCOME_COOLDOWN_HOURS || 24)
    },
    registrationStatuses: REGISTRATION_STATUSES
  });
});

function parseCoadminRequestBody(body = {}) {
  return {
    coadmin_name: body.coadmin_name ?? body.coadminName ?? '',
    coadmin_code: body.coadmin_code ?? body.coadminCode ?? '',
    appbeg_coadmin_uid: body.appbeg_coadmin_uid ?? body.appbegCoadminUid ?? '',
    telegram_account_username: body.telegram_account_username ?? body.telegramAccountUsername ?? '',
    telegram_account_id: body.telegram_account_id ?? body.telegramAccountId ?? ''
  };
}

async function coadminSettingsResponse({ settings, backfill = null, auditLog = null, message = null } = {}) {
  return {
    ok: true,
    message: message || 'Settings saved successfully.',
    settings,
    backfill,
    audit_log: auditLog ?? await store.listSettingsAuditLog(30)
  };
}

async function handleCoadminSettingsGet(req, res) {
  res.json({
    ok: true,
    settings: await store.getCoadminSettings(),
    audit_log: await store.listSettingsAuditLog(30)
  });
}

async function handleCoadminSettingsSave(req, res) {
  try {
    const patch = parseCoadminRequestBody(req.body);
    const actorName = req.body.staff_name || req.body.staffName || 'Staff';
    const { settings, backfill } = await store.updateCoadminSettings(patch, actorName, {
      applyToExisting: req.body.apply_to_existing !== false && req.body.applyToExisting !== false
    });
    io.emit('settings:changed');
    if (backfill.assigned > 0) {
      io.emit('contacts:changed');
      io.emit('users:changed');
      io.emit('players:changed');
    }
    res.json(await coadminSettingsResponse({
      settings,
      backfill,
      message: 'Settings saved successfully.'
    }));
  } catch (error) {
    console.error('[coadmin-settings] save failed:', error);
    res.status(400).json({ ok: false, error: error.message });
  }
}

async function handleCoadminSettingsApply(req, res) {
  try {
    const actorName = req.body.staff_name || req.body.staffName || 'Staff';
    const backfill = await store.applyCoadminToExistingBusinessContacts(actorName);
    if (backfill.assigned > 0) {
      io.emit('contacts:changed');
      io.emit('users:changed');
      io.emit('players:changed');
    }
    res.json(await coadminSettingsResponse({
      settings: await store.getCoadminSettings(),
      backfill,
      message: 'Coadmin assignment applied to existing contacts.'
    }));
  } catch (error) {
    console.error('[coadmin-settings] apply failed:', error);
    res.status(400).json({ ok: false, error: error.message });
  }
}

app.get('/api/coadmin-settings', handleCoadminSettingsGet);
app.post('/api/coadmin-settings', requireAdmin, handleCoadminSettingsSave);
app.post('/api/coadmin-settings/apply', requireAdmin, handleCoadminSettingsApply);

app.get('/api/settings/coadmin', handleCoadminSettingsGet);
app.patch('/api/settings/coadmin', requireAdmin, handleCoadminSettingsSave);
app.post('/api/settings/coadmin/apply', requireAdmin, handleCoadminSettingsApply);

app.get('/api/settings/audit-log', requireAdmin, async (req, res) => {
  res.json({ auditLog: await store.listSettingsAuditLog(Number(req.query.limit || 50)) });
});

app.post('/api/contacts/:id/registration/check-duplicates', async (req, res) => {
  try {
    const duplicateError = await store.checkRegistrationDuplicates({
      appbegUsername: req.body.appbegUsername,
      paymentTag: req.body.paymentTag,
      excludeUserId: Number(req.params.id),
      allowDuplicate: Boolean(req.body.allowDuplicate)
    });
    res.json({ ok: !duplicateError, error: duplicateError });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contacts/:id/registration/manual', async (req, res) => {
  try {
    const contact = await store.manualRegister({
      userId: Number(req.params.id),
      appbegUsername: req.body.appbegUsername,
      paymentTag: req.body.paymentTag,
      registrationStatus: req.body.registrationStatus || 'Registered',
      notes: req.body.notes,
      staffName: req.body.staffName || 'Staff',
      allowDuplicate: Boolean(req.body.allowDuplicate)
    });
    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('players:changed', { playerId: contact.id });
    io.emit('player:updated', { playerId: contact.id });
    io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    res.json({ contact });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/contacts/:id/registration-status', async (req, res) => {
  try {
    const contact = await store.updateRegistrationStatus(
      Number(req.params.id),
      req.body.registrationStatus,
      req.body.staffName || 'Staff'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('players:changed', { playerId: contact.id });
    io.emit('player:updated', { playerId: contact.id });
    io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    res.json({ contact });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/telegram-account-sync/status', async (req, res) => {
  res.json({
    sync: await store.getTelegramAccountSyncState(),
    logs: await store.listAccountSyncLogs(20)
  });
});

app.get('/api/payment-sync/status', async (req, res) => {
  res.json({ sync: await store.getPaymentSyncState() });
});

app.get('/api/payment-stats', async (req, res) => {
  res.json({ stats: await store.getPaymentStats() });
});

app.get('/api/payments', async (req, res) => {
  res.json({
    payments: await store.listPaymentEvents({
      limit: req.query.limit || 200,
      status: req.query.status || 'All',
      routingStatus: req.query.routingStatus || 'All',
      query: req.query.query || '',
      exceptionsOnly: req.query.exceptionsOnly === 'true'
    })
  });
});

app.get('/api/payments/exceptions', async (req, res) => {
  res.json({
    payments: await store.listPaymentEvents({
      limit: req.query.limit || 200,
      exceptionsOnly: true,
      query: req.query.query || ''
    })
  });
});

app.get('/api/payments/:id', async (req, res) => {
  const payment = await store.getPaymentEvent(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: 'Payment event not found.' });
  res.json({
    payment,
    sync: await store.getPaymentSyncState(),
    logs: await store.listPaymentListenerLogs(50),
    routingLogs: await store.listPaymentRoutingLogs(payment.id, 100)
  });
});

app.post('/api/payments/:id/route', async (req, res) => {
  try {
    const result = await routePaymentEvent(store, Number(req.params.id));
    if (!result.ok) return res.status(400).json({ error: result.error || 'Routing failed.' });
    io.emit('payments:changed');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payments/route-pending', async (req, res) => {
  try {
    const results = await routeUnprocessedPayments(store, { limit: req.body?.limit || 50 });
    io.emit('payments:changed');
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deposit-events', async (req, res) => {
  res.json({
    deposits: await store.listDepositEvents({
      contactId: req.query.contactId ? Number(req.query.contactId) : null,
      status: req.query.status || 'All',
      limit: req.query.limit || 100
    })
  });
});

app.post('/api/contacts/:id/deposit-events', async (req, res) => {
  try {
    const deposit = await startDepositEventForContact(store, {
      contactId: Number(req.params.id),
      startedBy: req.body.startedBy || 'Staff',
      notes: req.body.notes || ''
    });
    io.emit('payments:changed');
    res.json({ deposit });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/deposit-events/:id/cancel', async (req, res) => {
  try {
    const deposit = await store.cancelDepositEvent(Number(req.params.id), {
      cancelledBy: req.body.cancelledBy || 'Staff',
      reason: req.body.reason || 'Cancelled by staff'
    });
    if (!deposit) return res.status(404).json({ error: 'Deposit event not found.' });
    res.json({ deposit });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/internal/telegram-account-sync/notify', async (req, res) => {
  if (req.get('X-Sync-Token') !== (process.env.SYNC_NOTIFY_TOKEN || 'change_this_local_sync_token')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body?.payload || {};
  const notifyType = req.body?.type || 'unknown';

  try {
    const CHATBOT_ENABLED = process.env.CHATBOT_ENABLED !== 'false';

    if (req.body?.type === 'message' && payload.contactId && payload.direction === 'incoming' && payload.text) {
      const user = await store.getUserProfile(payload.contactId);
      if (user) {
        console.log(`[chatbot] inbound message saved contact=${user.id} telegram_message_id=${payload.telegramMessageId || 'n/a'} text_len=${String(payload.text || '').length}`);
        if (CHATBOT_ENABLED && isBotActiveForContact(user)) {
          const messageId = await store.findLatestIncomingMessageId(user.id, payload.telegramMessageId || null);
          await enqueueChatbotJob(store, {
            contactId: user.id,
            telegramUserId: user.telegram_id,
            messageId,
            incomingTelegramMessageId: payload.telegramMessageId || null,
            jobType: 'inbound_message',
            inputText: payload.text
          });
        } else if (!user.bot_paused && !user.needs_staff_review) {
          console.log(`[chatbot] bot job skipped reason=legacy_automation_fallback contact=${user.id}`);
          await processAutomationForContact({
            store,
            user,
            message: { text: payload.text, message_id: payload.telegramMessageId },
            inserted: true,
            rootDir,
            bot: globalThis.telegramBot,
            io
          });
        } else {
          console.log(`[chatbot] bot job skipped reason=${user.needs_staff_review ? 'needs_staff_review' : 'bot_paused'} contact=${user.id}`);
        }
      }
    }

    if (req.body?.type === 'callback' && payload.contactId && payload.action) {
      const user = await store.getUserProfile(payload.contactId);
      if (user) {
        const action = payload.action;
        if (CHATBOT_ENABLED && isBotActiveForContact(user) && isChatbotButtonAction(action)) {
          console.log(`[chatbot] callback received contact=${user.id} action=${action}`);
          await enqueueChatbotJob(store, {
            contactId: user.id,
            telegramUserId: user.telegram_id,
            jobType: 'callback_action',
            inputText: '',
            action
          });
        } else if (!user.bot_paused && !user.needs_staff_review) {
          await processAutomationActionForContact({
            store,
            user,
            action,
            rootDir,
            bot: globalThis.telegramBot,
            io
          });
        }
      }
    }
  } catch (error) {
    console.error('Account sync automation failed:', error.message);
  }

  const affectsContacts = Boolean(payload.contactId || notifyType === 'message' || notifyType === 'callback');
  const affectsStats = notifyType === 'message';
  const affectsSyncStatus = ['connected', 'import_started', 'import_complete', 'error'].includes(notifyType);

  io.emit('telegram-sync:changed', {
    type: notifyType,
    payload,
    contactId: payload.contactId || null,
    telegramId: payload.telegramId || null,
    affectsContacts,
    affectsStats,
    affectsSyncStatus
  });
  if (payload.contactId) {
    io.emit('message:new', {
      contactId: payload.contactId,
      userId: payload.contactId,
      telegramId: payload.telegramId
    });
  }
  res.json({ ok: true });
});

app.post('/api/internal/payment-sync/notify', async (req, res) => {
  if (req.get('X-Sync-Token') !== (process.env.SYNC_NOTIFY_TOKEN || 'change_this_local_sync_token')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  io.emit('payment-sync:changed', req.body);
  io.emit('payments:changed');

  const telegramMessageId = req.body?.payload?.telegramMessageId;
  if (telegramMessageId) {
    io.emit('payment:new', { telegramMessageId });
  }

  try {
    if (req.body?.type === 'message' && telegramMessageId) {
      const payment = await store.getPaymentEventByTelegramMessageId(telegramMessageId);
      if (payment) {
        await routePaymentEvent(store, payment.id);
        io.emit('payments:changed');
        io.emit('payment:routed', { paymentId: payment.id, telegramMessageId });
      }
    }

    if (req.body?.type === 'sync_complete') {
      const results = await routeUnprocessedPayments(store, { limit: 100 });
      if (results.length) {
        io.emit('payments:changed');
      }
    }
  } catch (error) {
    console.error('[payment-router]', error);
  }

  res.json({ ok: true });
});

app.patch('/api/users/:id/status', async (req, res) => {
  try {
    const user = await store.updateRegistrationStatus(
      Number(req.params.id),
      req.body.registrationStatus,
      req.body.staffName || 'Staff'
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });
    io.emit('users:changed');
    io.emit('user:changed', { userId: user.id });
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/contacts/:id/conversation-status', async (req, res) => {
  try {
    const contact = await store.updateConversationStatus(
      Number(req.params.id),
      req.body.status,
      req.body.staffName || 'Staff'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    res.json({ contact });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contacts/:id/assign', async (req, res) => {
  const contact = await store.assignConversation(
    Number(req.params.id),
    req.body.staffName,
    req.body.actorName || req.body.currentStaffName || 'Staff'
  );
  if (!contact) return res.status(404).json({ error: 'Contact not found.' });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
  res.json({ contact });
});

app.post('/api/contacts/:id/mark-read', async (req, res) => {
  const contactId = Number(req.params.id);
  const existing = await store.getUserProfile(contactId);
  if (!existing) return res.status(404).json({ error: 'Contact not found.' });
  const contact = await store.markConversationRead(contactId) || existing;
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('contact:changed', { contactId, userId: contactId });
  res.json({ ok: true, contactId, unreadCount: 0, contact });
});

app.post('/api/contacts/:id/read', async (req, res) => {
  const contactId = Number(req.params.id);
  const existing = await store.getUserProfile(contactId);
  if (!existing) return res.status(404).json({ error: 'Contact not found.' });
  const contact = await store.markConversationRead(contactId) || existing;
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('contact:changed', { contactId, userId: contactId });
  res.json({ ok: true, contactId, unreadCount: 0, contact });
});

app.post('/api/contacts/:id/bot-state', async (req, res) => {
  const contact = await store.getUserProfile(Number(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found.' });

  const action = ['restart', 'home', 'cancel'].includes(req.body.action) ? req.body.action : 'home';
  const session = await store.resetBotState(contact.id, {
    actorName: req.body.staffName || 'Staff',
    action
  });

  let menuSent = false;
  let menuError = null;
  if (process.env.TELEGRAM_BOT_TOKEN && globalThis.telegramBot && req.body.sendMenu !== false) {
    try {
      await renderMenu({
        bot: globalThis.telegramBot,
        store,
        user: contact,
        screenName: session.current_screen,
        registered: contact.registration_status === 'Registered'
      });
      menuSent = true;
    } catch (error) {
      menuError = error.message;
    }
  }

  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
  if (menuSent) io.emit('message:new', { contactId: contact.id, userId: contact.id, telegramId: contact.telegram_id });

  res.json({ session, menuSent, menuError });
});

app.post('/api/contacts/:id/bot-control', async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const action = String(req.body.action || '').toLowerCase();
    const staffName = req.body.staffName || 'Staff';
    const existing = await store.getUserProfile(contactId);
    if (!existing) return res.status(404).json({ error: 'Contact not found.' });

    let contact;
    if (action === 'pause') {
      contact = await store.setBotControl(contactId, {
        botPaused: true,
        actorName: staffName
      });
    } else if (action === 'resume') {
      contact = await store.setBotControl(contactId, {
        botPaused: false,
        needsStaffReview: false,
        actorName: staffName
      });
    } else if (action === 'takeover') {
      contact = await store.setBotControl(contactId, {
        botPaused: true,
        needsStaffReview: true,
        staffReviewReason: 'staff_takeover',
        actorName: staffName
      });
      await store.cancelAutomationFlow(contactId, staffName).catch(() => null);
    } else {
      return res.status(400).json({ error: 'Invalid action. Use pause, resume, or takeover.' });
    }

    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
    res.json({ contact, action });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/contacts/:id/automation/start-flow', async (req, res) => {
  const contact = await store.getUserProfile(Number(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found.' });
  const flowKey = req.body.flowKey || 'registration_info';
  let automationState;
  let messageSent = false;
  if (flowKey === 'registration_info' && process.env.TELEGRAM_BOT_TOKEN && globalThis.telegramBot && req.body.sendMessage !== false) {
    const { createReplySender } = await import('./telegram/messageDelivery.js');
    const sendReply = createReplySender({ store, user: contact, rootDir, bot: globalThis.telegramBot });
    await startRegistrationFlow({ sendReply, store, user: contact, actorName: req.body.staffName || 'Staff' });
    automationState = await store.getAutomationState(contact.id);
    messageSent = true;
  } else {
    automationState = await store.startAutomationFlow(contact.id, flowKey, req.body.staffName || 'Staff');
  }
  io.emit('contacts:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
  if (messageSent) io.emit('message:new', { contactId: contact.id, userId: contact.id, telegramId: contact.telegram_id });
  res.json({ automationState, messageSent });
});

app.post('/api/contacts/:id/automation/cancel', async (req, res) => {
  const automationState = await store.cancelAutomationFlow(Number(req.params.id), req.body.staffName || 'Staff');
  io.emit('contacts:changed');
  io.emit('contact:changed', { contactId: Number(req.params.id), userId: Number(req.params.id) });
  res.json({ automationState });
});

app.post('/api/contacts/:id/automation/reset', async (req, res) => {
  const automationState = await store.resetAutomationState(Number(req.params.id), req.body.staffName || 'Staff');
  io.emit('contacts:changed');
  io.emit('contact:changed', { contactId: Number(req.params.id), userId: Number(req.params.id) });
  res.json({ automationState });
});

app.patch('/api/contacts/:id/registration-info', async (req, res) => {
  const automationState = await store.updateRegistrationInfo(
    Number(req.params.id),
    req.body.registrationInfo || {},
    req.body.staffName || 'Staff'
  );
  io.emit('contacts:changed');
  io.emit('contact:changed', { contactId: Number(req.params.id), userId: Number(req.params.id) });
  res.json({ automationState });
});

app.post('/api/contacts/:id/registration-info/review', async (req, res) => {
  const automationState = await store.markRegistrationInfoReviewed(Number(req.params.id), req.body.staffName || 'Staff');
  io.emit('contacts:changed');
  io.emit('contact:changed', { contactId: Number(req.params.id), userId: Number(req.params.id) });
  res.json({ automationState });
});

app.post('/api/users/:id/notes', async (req, res) => {
  try {
    const note = await store.addNote(Number(req.params.id), {
      staffName: req.body.staffName || 'Staff',
      text: req.body.text ?? req.body.notes
    });
    if (!note) return res.status(404).json({ error: 'User not found.' });
    io.emit('users:changed');
    io.emit('user:changed', { userId: Number(req.params.id) });
    res.status(201).json({ note });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/users/:id/notes-legacy', async (req, res) => {
  try {
    const note = await store.addNote(Number(req.params.id), {
      staffName: req.body.staffName || 'Staff',
      text: req.body.text
    });
    if (!note) return res.status(404).json({ error: 'User not found.' });
    io.emit('users:changed');
    io.emit('user:changed', { userId: Number(req.params.id) });
    res.status(201).json({ note });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/users/:id/tags', async (req, res) => {
  const user = await store.setUserTags(Number(req.params.id), req.body.tagIds || [], req.body.staffName || 'Staff');
  if (!user) return res.status(404).json({ error: 'User not found.' });
  io.emit('users:changed');
  io.emit('user:changed', { userId: user.id });
  res.json({ user });
});

app.post('/api/contacts/:id/notes', async (req, res) => {
  try {
    const note = await store.addNote(Number(req.params.id), {
      staffName: req.body.staffName || 'Staff',
      text: req.body.text
    });
    if (!note) return res.status(404).json({ error: 'Contact not found.' });
    io.emit('contacts:changed');
    io.emit('users:changed');
    io.emit('contact:changed', { contactId: Number(req.params.id), userId: Number(req.params.id) });
    res.status(201).json({ note });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/contacts/:id/tags', async (req, res) => {
  const contact = await store.setUserTags(Number(req.params.id), req.body.tagIds || [], req.body.staffName || 'Staff');
  if (!contact) return res.status(404).json({ error: 'Contact not found.' });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('contact:changed', { contactId: contact.id, userId: contact.id });
  res.json({ contact });
});

async function sendTelegramMessage(req, res) {
  const user = await store.getUserProfile(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required.' });

  // Staff override: pause bot for this contact so automations don't collide.
  if (!user.bot_paused) {
    try {
      await store.setBotControl(user.id, {
        botPaused: true,
        actorName: req.body.staffName || 'Staff'
      });
    } catch (error) {
      console.warn('[chatbot] auto-pause on staff send failed:', error.message);
    }
  }

  const clientRequestId = String(req.body.client_request_id || req.body.clientRequestId || '').trim();
  const claim = await store.claimOutgoingMessageRequest({
    telegramUserId: user.id,
    clientRequestId
  });

  if (!claim.claimed) {
    const existing = claim.existing;
    if (existing?.response_json) {
      return res.status(201).json({ ...JSON.parse(existing.response_json), duplicate: true });
    }
    return res.status(409).json({ error: 'An identical send request is already in progress.' });
  }

  const preferredSource = await store.getContactPreferredMessageSource(user.id);
  const accountSyncEnabled = process.env.TELEGRAM_ACCOUNT_SYNC_ENABLED === 'true';
  const botEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && globalThis.telegramBot);

  try {
    let response;
    let storedMessageId = null;

    if (preferredSource === 'business_account' && accountSyncEnabled) {
      const temporaryTelegramMessageId = -Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
      const stored = await store.storeOutgoingMessage({
        telegramUserId: user.id,
        telegramMessageId: temporaryTelegramMessageId,
        text,
        payload: {
          queued: true,
          clientRequestId: clientRequestId || null,
          sync_kind: 'queued',
          source: 'business_account'
        },
        senderType: 'staff',
        staffName: req.body.staffName || 'Staff',
        source: 'business_account',
        sentAt: new Date().toISOString()
      });
      storedMessageId = stored.messageId;
      const outbound = await store.queueTelegramOutboundMessage({
        contactId: user.id,
        telegramUserId: user.telegram_id,
        body: text,
        localMessageId: storedMessageId,
        clientRequestId
      });
      console.log(`[telegram-outbound] queued id=${outbound.id} contact=${user.id} telegram=${user.telegram_id}`);
      await store.db.prepare(`
        INSERT INTO sync_state (key, value, updated_at)
        VALUES ('outbound_queue:nudge', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(outbound.id), new Date().toISOString());
      response = {
        ok: true,
        source: 'business_account',
        queued: true,
        outboundId: outbound.id,
        messageId: storedMessageId
      };
    } else if (botEnabled) {
      const telegramResponse = await globalThis.telegramBot.telegram.sendMessage(user.telegram_id, text);
      const stored = await store.storeOutgoingMessage({
        telegramUserId: user.id,
        telegramMessageId: telegramResponse.message_id,
        text,
        payload: telegramResponse,
        senderType: 'staff',
        staffName: req.body.staffName || 'Staff',
        source: 'bot_api'
      });
      storedMessageId = stored.messageId;
      response = { ok: true, source: 'bot_api', messageId: storedMessageId };
    } else if (preferredSource === 'business_account') {
      return res.status(400).json({
        error: 'This contact uses the business Telegram account. Enable TELEGRAM_ACCOUNT_SYNC_ENABLED and run npm run telegram:login.'
      });
    } else {
      return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN is required to send Telegram messages.' });
    }

    await store.completeOutgoingMessageRequest({
      telegramUserId: user.id,
      clientRequestId,
      response,
      messageId: storedMessageId
    });

    io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
    io.emit('contacts:changed');
    io.emit('users:changed');
    res.status(201).json(response);
  } catch (error) {
    await store.releaseOutgoingMessageRequest({
      telegramUserId: user.id,
      clientRequestId
    });
    res.status(500).json({ error: error.message });
  }
}

app.post('/api/users/:id/messages', sendTelegramMessage);

app.post('/api/contacts/:id/messages', sendTelegramMessage);

app.get('*', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(publicDir, 'index.html'));
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const userId = socket.request.session?.ledgerUserId;
  if (!userId) return next(new Error('Authentication required'));
  return next();
});

io.on('connection', (socket) => {
  socket.emit('connected', { ok: true });
});

globalThis.telegramBot = startTelegramListener({
  token: process.env.TELEGRAM_BOT_TOKEN,
  store,
  io
});

globalThis.telegramAccountSync = await startTelegramAccountSync({
  rootDir,
  store,
  io
});

globalThis.paymentTelegramSync = await startPaymentTelegramSync({
  rootDir,
  store,
  io
});

globalThis.chatbotWorker = startChatbotWorker({ store, io });
globalThis.paymentWindowExpiryWorker = startPaymentWindowExpiryWorker({ store, io });

async function shutdownWorkers(signal = 'shutdown') {
  console.log(`Stopping background workers (${signal})...`);
  await Promise.all([
    stopTelegramAccountSync(),
    stopPaymentTelegramSync(),
    globalThis.chatbotWorker?.stop?.(),
    globalThis.paymentWindowExpiryWorker?.stop?.(),
    Promise.resolve(globalThis.telegramBot?.stop?.(signal))
  ]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await shutdownWorkers(signal);
    process.exit(0);
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

server.listen(port, () => {
  console.log(`Royal VIP Coadmin foundation running at http://localhost:${port}`);
  if (isDebugEnabled()) {
    console.log('DEBUG=true — verbose API and sync logging enabled.');
  }
});
