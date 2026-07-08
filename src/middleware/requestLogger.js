function formatDuration(ms) {
  return `${ms}ms`;
}

export function requestLogger() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      return next();
    }

    const start = Date.now();
    let logged = false;

    const logRequest = (reason = '') => {
      if (logged) return;
      logged = true;
      const duration = Date.now() - start;
      const status = res.statusCode || 0;
      const suffix = reason ? ` ${reason}` : '';
      const line = `[api] ${req.method} ${req.originalUrl || req.path} ${status} ${formatDuration(duration)}${suffix}`;

      if (status >= 500) {
        console.error(line);
      } else if (status >= 400) {
        console.warn(line);
      } else {
        console.log(line);
      }
    };

    res.on('finish', () => logRequest());
    res.on('close', () => {
      if (!res.writableEnded) {
        logRequest('(connection closed)');
      }
    });

    next();
  };
}
