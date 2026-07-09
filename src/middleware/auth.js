const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

import session from 'express-session';

const loginAttempts = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function createSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[auth] SESSION_SECRET is not set. Using an insecure development default.');
  }

  return session({
    name: 'ledger_sid',
    secret: secret || 'dev-only-change-me-before-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS
    }
  });
}

export function isAuthExemptPath(pathname, method = 'GET') {
  if (pathname === '/api/auth/login' && method === 'POST') return true;
  if (pathname === '/api/auth/logout' && method === 'POST') return true;
  if (pathname === '/api/health' || pathname === '/api/health/full') return true;
  if (pathname.startsWith('/api/internal/')) return true;
  return false;
}

export function createLoginRateLimiter() {
  return function loginRateLimiter(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS });
      return next();
    }

    if (entry.count >= LOGIN_RATE_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    return next();
  };
}

export function recordFailedLogin(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginAttempts(req) {
  loginAttempts.delete(getClientIp(req));
}

export function requireAuth(store) {
  return async function authMiddleware(req, res, next) {
    try {
      const userId = req.session?.ledgerUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const user = await store.getLedgerUserById(userId);
      if (!user || !user.is_active) {
        req.session?.destroy?.(() => {});
        return res.status(401).json({ error: 'Authentication required.' });
      }

      req.ledgerUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireAdmin(req, res, next) {
  if (!req.ledgerUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.ledgerUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

export function isAuthenticated(req) {
  return Boolean(req.session?.ledgerUserId);
}
