import { isDebugEnabled } from '../config/debug.js';

export function wrapAsyncHandlers(app) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) => {
      const wrapped = handlers.map((handler) => wrapHandler(handler));
      return original(path, ...wrapped);
    };
  }
  return app;
}

function wrapHandler(handler) {
  if (typeof handler !== 'function' || handler.length === 4) {
    return handler;
  }

  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

export function notFoundHandler(req, res, next) {
  if (!req.path.startsWith('/api/')) {
    return next();
  }
  res.status(404).json({
    ok: false,
    error: `API route not found: ${req.method} ${req.path}`
  });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const status = Number(err.status || err.statusCode || 500);
  const message = err.message || 'Internal server error';

  console.error(`[api:error] ${req.method} ${req.originalUrl || req.path} ${status} ${message}`);
  if (err.stack) {
    console.error(err.stack);
  }

  res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: message,
    path: req.originalUrl || req.path,
    method: req.method,
    ...(isDebugEnabled() && err.stack ? { stack: err.stack } : {})
  });
}
