import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function extensionForMime(mimeType) {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return null;
  }
}

function createUploadMiddleware(chimeQrDir) {
  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(chimeQrDir, { recursive: true });
      cb(null, chimeQrDir);
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
  const mediaRoot = path.resolve(rootDir, 'data', 'media', 'chime-qr');
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
  const status = error.code === 'LAST_ACTIVE_DEFAULT' || error.code === 'INACTIVE_QR' ? 409 : 400;
  res.status(status).json({ error: error.message || fallback, code: error.code || null });
}

export function registerPaymentInfoRoutes(app, { store, rootDir }) {
  const chimeQrDir = path.join(rootDir, 'data', 'media', 'chime-qr');
  const upload = createUploadMiddleware(chimeQrDir);

  app.get('/api/payment-info/chime-qrs', async (_req, res) => {
    const qrs = await store.listChimeQrCodes();
    res.json({
      qrs,
      has_active_default: await store.hasActiveDefaultChimeQr()
    });
  });

  app.post('/api/payment-info/chime-qrs/upload', (req, res) => {
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5MB or smaller.'
          : uploadError.message || 'Upload failed.';
        return res.status(400).json({ error: message });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Image file is required.' });
      }

      let storedPath = null;
      try {
        const label = String(req.body?.label || '').trim() || null;
        storedPath = relativeFilePath(rootDir, req.file.path);
        const existing = await store.listChimeQrCodes();
        const shouldDefault = existing.length === 0;

        const qr = await store.createChimeQrCode({
          filePath: storedPath,
          label,
          isActive: true,
          isDefault: shouldDefault
        });

        res.status(201).json({
          qr,
          has_active_default: await store.hasActiveDefaultChimeQr()
        });
      } catch (error) {
        removeStoredFile(rootDir, storedPath || relativeFilePath(rootDir, req.file.path));
        handleRouteError(res, error, 'Could not save Chime QR.');
      }
    });
  });

  app.patch('/api/payment-info/chime-qrs/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid QR id.' });
      }

      const patch = {};
      if (req.body?.label !== undefined) {
        patch.label = String(req.body.label || '').trim() || null;
      }
      if (req.body?.is_active !== undefined) {
        patch.is_active = Boolean(req.body.is_active);
      }
      if (req.body?.force !== undefined) {
        patch.force = Boolean(req.body.force);
      }

      const qr = await store.updateChimeQrCode(id, patch);
      if (!qr) {
        return res.status(404).json({ error: 'Chime QR not found.' });
      }

      res.json({
        qr,
        has_active_default: await store.hasActiveDefaultChimeQr()
      });
    } catch (error) {
      handleRouteError(res, error, 'Could not update Chime QR.');
    }
  });

  app.post('/api/payment-info/chime-qrs/:id/default', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid QR id.' });
      }

      const qr = await store.setDefaultChimeQr(id);
      if (!qr) {
        return res.status(404).json({ error: 'Chime QR not found.' });
      }

      res.json({
        qr,
        has_active_default: await store.hasActiveDefaultChimeQr()
      });
    } catch (error) {
      handleRouteError(res, error, 'Could not set default Chime QR.');
    }
  });

  app.delete('/api/payment-info/chime-qrs/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid QR id.' });
      }

      const result = await store.deleteChimeQrCode(id);
      if (!result) {
        return res.status(404).json({ error: 'Chime QR not found.' });
      }

      if (result.action === 'deleted') {
        removeStoredFile(rootDir, result.file_path);
      }

      res.json({
        ...result,
        has_active_default: await store.hasActiveDefaultChimeQr()
      });
    } catch (error) {
      handleRouteError(res, error, 'Could not delete Chime QR.');
    }
  });
}
