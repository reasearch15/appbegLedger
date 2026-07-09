import bcrypt from 'bcrypt';
import {
  clearLoginAttempts,
  createLoginRateLimiter,
  recordFailedLogin,
  requireAdmin,
  requireAuth
} from '../middleware/auth.js';

const BCRYPT_ROUNDS = 12;
const GENERIC_LOGIN_ERROR = 'Invalid username or password';

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function parseRole(value) {
  const role = String(value || 'staff').trim().toLowerCase();
  return role === 'admin' ? 'admin' : 'staff';
}

export function registerAuthRoutes(app, { store }) {
  const loginRateLimiter = createLoginRateLimiter();

  app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: GENERIC_LOGIN_ERROR });
    }

    try {
      const user = await store.getLedgerUserByUsername(username);
      if (!user || !user.is_active) {
        recordFailedLogin(req);
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        recordFailedLogin(req);
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }

      clearLoginAttempts(req);
      req.session.ledgerUserId = user.id;
      req.session.ledgerUsername = user.username;
      req.session.ledgerRole = user.role;

      return res.json({ user: store.toPublicLedgerUser(user) });
    } catch (error) {
      console.error('[auth] login failed:', error);
      return res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    if (!req.session) {
      return res.json({ ok: true });
    }
    req.session.destroy((error) => {
      if (error) {
        console.error('[auth] logout failed:', error);
        return res.status(500).json({ error: 'Logout failed.' });
      }
      res.clearCookie('ledger_sid');
      return res.json({ ok: true });
    });
  });

  app.get('/api/auth/me', requireAuth(store), (req, res) => {
    res.json({ user: store.toPublicLedgerUser(req.ledgerUser) });
  });

  app.get('/api/auth/users', requireAuth(store), requireAdmin, async (_req, res) => {
    const users = await store.listLedgerUsers();
    res.json({ users });
  });

  app.post('/api/auth/users', requireAuth(store), requireAdmin, async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = String(req.body?.password || '');
      const role = parseRole(req.body?.role);

      if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters.' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }

      const existing = await store.getLedgerUserByUsername(username);
      if (existing) {
        return res.status(409).json({ error: 'Username already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await store.createLedgerUser({
        username,
        passwordHash,
        role,
        isActive: req.body?.is_active !== false
      });
      res.status(201).json({ user });
    } catch (error) {
      console.error('[auth] create user failed:', error);
      res.status(400).json({ error: error.message || 'Could not create user.' });
    }
  });

  app.patch('/api/auth/users/:id', requireAuth(store), requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid user id.' });
      }

      const patch = {};
      if (req.body?.role !== undefined) patch.role = parseRole(req.body.role);
      if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
      if (req.body?.password) {
        if (String(req.body.password).length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        patch.password_hash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);
      }

      const user = await store.updateLedgerUser(id, patch);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({ user });
    } catch (error) {
      console.error('[auth] update user failed:', error);
      res.status(400).json({ error: error.message || 'Could not update user.' });
    }
  });
}
