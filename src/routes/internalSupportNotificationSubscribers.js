import { requireVendorInternalAuth } from '../middleware/vendorInternalAuth.js';

function cleanText(value) {
  return String(value ?? '').trim();
}

function sanitizeSubscriber(row) {
  if (!row) return null;
  return {
    telegramUserId: cleanText(row.telegram_user_id) || null,
    telegramUsername: cleanText(row.telegram_username) || null,
    telegramDisplayName: cleanText(row.telegram_display_name) || null,
    linkedAt: cleanText(row.linked_at) || null,
    isActive: Boolean(row.is_active),
    disabledByCoadmin: Boolean(row.disabled_by_coadmin),
    subscribedAt: cleanText(row.subscribed_at) || null,
    lastDeliveryAt: cleanText(row.last_delivery_at) || null,
    lastError: cleanText(row.last_error) || null
  };
}

export function registerInternalSupportNotificationSubscriberRoutes(app, { store }) {
  app.get(
    '/api/internal/support-notification/subscribers',
    requireVendorInternalAuth,
    async (req, res) => {
      const coadminUid = cleanText(req.query?.coadminUid);
      if (!coadminUid) {
        return res.status(400).json({ ok: false, error: 'coadminUid is required.' });
      }
      if (typeof store.listSupportNotificationSubscribersByCoadmin !== 'function') {
        return res.status(503).json({ ok: false, error: 'Subscriber store unavailable.' });
      }
      try {
        const rows = await store.listSupportNotificationSubscribersByCoadmin(coadminUid);
        return res.json({
          ok: true,
          subscribers: rows.map((row) => sanitizeSubscriber(row)).filter(Boolean)
        });
      } catch (error) {
        console.error('[internal-support-subscribers] list_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        return res.status(503).json({ ok: false, error: 'Unable to list subscribers.' });
      }
    }
  );

  app.post(
    '/api/internal/support-notification/subscribers/:telegramUserId/disable',
    requireVendorInternalAuth,
    async (req, res) => {
      const telegramUserId = cleanText(req.params?.telegramUserId);
      const coadminUid = cleanText(req.body?.coadminUid);
      if (!telegramUserId || !coadminUid) {
        return res.status(400).json({ ok: false, error: 'coadminUid and telegramUserId are required.' });
      }
      if (typeof store.disableSupportNotificationSubscriber !== 'function') {
        return res.status(503).json({ ok: false, error: 'Subscriber store unavailable.' });
      }
      try {
        const result = await store.disableSupportNotificationSubscriber({
          coadminUid,
          telegramUserId
        });
        if (!result.ok) {
          return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        }
        return res.json({ ok: true, subscriber: sanitizeSubscriber(result.subscriber) });
      } catch (error) {
        console.error('[internal-support-subscribers] disable_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        return res.status(503).json({ ok: false, error: 'Unable to disable subscriber.' });
      }
    }
  );

  app.post(
    '/api/internal/support-notification/subscribers/:telegramUserId/enable',
    requireVendorInternalAuth,
    async (req, res) => {
      const telegramUserId = cleanText(req.params?.telegramUserId);
      const coadminUid = cleanText(req.body?.coadminUid);
      if (!telegramUserId || !coadminUid) {
        return res.status(400).json({ ok: false, error: 'coadminUid and telegramUserId are required.' });
      }
      if (typeof store.enableSupportNotificationSubscriber !== 'function') {
        return res.status(503).json({ ok: false, error: 'Subscriber store unavailable.' });
      }
      try {
        const result = await store.enableSupportNotificationSubscriber({
          coadminUid,
          telegramUserId
        });
        if (!result.ok) {
          return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        }
        return res.json({ ok: true, subscriber: sanitizeSubscriber(result.subscriber) });
      } catch (error) {
        console.error('[internal-support-subscribers] enable_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        return res.status(503).json({ ok: false, error: 'Unable to enable subscriber.' });
      }
    }
  );
}
