import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { slugifyPaymentMethodKey } from '../payments/methodUtils.js';
import { queueBotPhotoReply } from '../telegram/chatbotProcessorDelivery.js';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const QR_REPLACEMENT_MESSAGE = 'Payment details have changed. Please use the new QR code shown below from now on. Do not send payment to the previous QR.';

function extensionForMime(mimeType) {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    default: return null;
  }
}

function createUploadMiddleware(uploadDir) {
  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename(_req, file, cb) {
      const ext = extensionForMime(file.mimetype);
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
        return cb(new Error('Only PNG, JPG, JPEG, and WEBP images are allowed.'));
      }
      cb(null, true);
    }
  });
}

function relativeFilePath(rootDir, absolutePath) {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid upload path.');
  }
  return relative.split(path.sep).join('/');
}

function resolveStoredFilePath(rootDir, filePath) {
  const resolved = path.resolve(rootDir, filePath);
  const mediaRoot = path.resolve(rootDir, 'data', 'media');
  if (!resolved.startsWith(mediaRoot + path.sep) && resolved !== mediaRoot) {
    return null;
  }
  return resolved;
}

function removeStoredFile(rootDir, filePath) {
  if (!filePath) return;
  const resolved = resolveStoredFilePath(rootDir, filePath);
  if (!resolved || !fs.existsSync(resolved)) return;
  fs.unlinkSync(resolved);
}

function handleRouteError(res, error, fallback = 'Request failed.') {
  const code = error.code || null;
  const status = ['LAST_ACTIVE_DEFAULT', 'INACTIVE_QR', 'ARCHIVED_QR', 'DEFAULT_QR_REQUIRED', 'QR_REPLACEMENT_REQUIRED', 'METHOD_IN_USE', 'QR_IN_USE', 'DUPLICATE_KEY'].includes(code)
    ? 409
    : 400;
  res.status(status).json({ error: error.message || fallback, code });
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function notifyQrReplacementUsers({ store, result }) {
  if (!['replaced_deleted', 'replaced_archived'].includes(result?.action)) return;
  const replacementQr = result.replacementQr;
  const affectedWindows = result.affectedWindows || [];
  if (!replacementQr?.file_path || !affectedWindows.length) return;

  const windowsByContact = new Map();
  for (const window of affectedWindows) {
    const contactId = Number(window.contact_id);
    if (!windowsByContact.has(contactId)) windowsByContact.set(contactId, []);
    windowsByContact.get(contactId).push(window);
  }

  for (const [contactId, windows] of windowsByContact.entries()) {
    const alreadyNotified = await Promise.all(windows.map((window) => (
      store.wasPaymentQrReplacementNotified?.({
        contactId,
        oldQrId: result.qr.id,
        newQrId: replacementQr.id,
        windowId: window.id
      })
    )));
    if (alreadyNotified.some(Boolean)) continue;
    const contact = await store.getUserProfile(contactId);
    if (!contact) continue;
    await queueBotPhotoReply({
      store,
      user: contact,
      text: QR_REPLACEMENT_MESSAGE,
      mediaPath: replacementQr.file_path,
      buttons: [],
      bot: globalThis.telegramBot || null
    });
    for (const window of windows) {
      await store.recordPaymentQrReplacementNotified?.({
        contactId,
        oldQrId: result.qr.id,
        newQrId: replacementQr.id,
        windowId: window.id
      });
    }
  }
}

export function registerPaymentMethodRoutes(app, { store, rootDir, requireAdmin }) {
  const adminOnly = requireAdmin || ((_req, _res, next) => next());
  const uploadDir = path.join(rootDir, 'data', 'media', 'payment-qr');
  const upload = createUploadMiddleware(uploadDir);

  app.get('/api/payment-methods', async (_req, res) => {
    const methods = await store.listPaymentMethods();
    res.json({ methods });
  });

  app.post('/api/payment-methods', adminOnly, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const key = req.body?.key ? String(req.body.key).trim().toLowerCase() : slugifyPaymentMethodKey(name);
      const method = await store.createPaymentMethod({
        name,
        key,
        isActive: req.body?.is_active !== false,
        displayOrder: req.body?.display_order != null ? Number(req.body.display_order) : null
      });
      res.status(201).json({ method });
    } catch (error) {
      handleRouteError(res, error, 'Could not create payment method.');
    }
  });

  app.patch('/api/payment-methods/:id', adminOnly, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid payment method id.' });
      const patch = {};
      if (req.body?.name !== undefined) patch.name = req.body.name;
      if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
      if (req.body?.display_order !== undefined) patch.display_order = Number(req.body.display_order);
      const method = await store.updatePaymentMethod(id, patch);
      if (!method) return res.status(404).json({ error: 'Payment method not found.' });
      res.json({ method });
    } catch (error) {
      handleRouteError(res, error, 'Could not update payment method.');
    }
  });

  app.delete('/api/payment-methods/:id', adminOnly, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid payment method id.' });
      const result = await store.deletePaymentMethod(id);
      if (!result) return res.status(404).json({ error: 'Payment method not found.' });
      for (const qr of result.qrs || []) {
        if (qr.in_use) continue;
        const filePath = await store.getPaymentQrCodeFilePath(qr.id);
        removeStoredFile(rootDir, filePath);
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Could not delete payment method.');
    }
  });

  app.get('/api/payment-methods/:id/qrs', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid payment method id.' });
    const method = await store.getPaymentMethod(id);
    if (!method) return res.status(404).json({ error: 'Payment method not found.' });
    const qrs = await store.listPaymentQrCodes(id);
    res.json({ method, qrs });
  });

  app.post('/api/payment-methods/:id/qrs', adminOnly, (req, res) => {
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5MB or smaller.'
          : uploadError.message || 'Upload failed.';
        return res.status(400).json({ error: message });
      }

      const methodId = parseId(req.params.id);
      if (!methodId) return res.status(400).json({ error: 'Invalid payment method id.' });
      const method = await store.getPaymentMethod(methodId);
      if (!method) return res.status(404).json({ error: 'Payment method not found.' });
      if (!req.file) return res.status(400).json({ error: 'Image file is required.' });

      let storedPath = null;
      try {
        const label = String(req.body?.label || '').trim() || null;
        storedPath = relativeFilePath(rootDir, req.file.path);
        const qr = await store.createPaymentQrCode({
          paymentMethodId: methodId,
          filePath: storedPath,
          label,
          isActive: true,
          isDefault: false
        });
        res.status(201).json({ method, qr });
      } catch (error) {
        removeStoredFile(rootDir, storedPath || relativeFilePath(rootDir, req.file.path));
        handleRouteError(res, error, 'Could not save payment QR.');
      }
    });
  });

  app.patch('/api/payment-qrs/:id', adminOnly, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid QR id.' });
      const patch = {};
      if (req.body?.label !== undefined) patch.label = String(req.body.label || '').trim() || null;
      if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
      if (req.body?.force !== undefined) patch.force = Boolean(req.body.force);
      const qr = await store.updatePaymentQrCode(id, patch);
      if (!qr) return res.status(404).json({ error: 'Payment QR not found.' });
      res.json({ qr });
    } catch (error) {
      handleRouteError(res, error, 'Could not update payment QR.');
    }
  });

  app.post('/api/payment-qrs/:id/default', adminOnly, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid QR id.' });
      const qr = await store.setDefaultPaymentQr(id);
      if (!qr) return res.status(404).json({ error: 'Payment QR not found.' });
      res.json({ qr });
    } catch (error) {
      handleRouteError(res, error, 'Could not set default payment QR.');
    }
  });

  app.delete('/api/payment-qrs/:id', adminOnly, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid QR id.' });
      const result = await store.deletePaymentQrCode(id);
      if (!result) return res.status(404).json({ error: 'Payment QR not found.' });
      await notifyQrReplacementUsers({ store, result });
      if (result.action === 'deleted') {
        removeStoredFile(rootDir, result.file_path);
      }
      if (result.action === 'replaced_deleted') {
        removeStoredFile(rootDir, result.file_path);
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Could not delete payment QR.');
    }
  });
}
