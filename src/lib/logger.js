const crypto = require('crypto');

/**
 * Writes a structured JSON log entry without exposing secrets or medical payloads.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {void}
 */
function log(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    requestId: context.requestId || null,
    userId: context.userId || null,
    role: context.role || null,
    path: context.path || null,
    method: context.method || null,
    duration_ms: context.duration_ms ?? null
  };

  const safeContext = { ...context };
  delete safeContext.requestId;
  delete safeContext.userId;
  delete safeContext.role;
  delete safeContext.path;
  delete safeContext.method;
  delete safeContext.duration_ms;

  const payload = {
    ...entry,
    ...safeContext
  };

  console.log(JSON.stringify(payload));
}

/**
 * Logs an informational event.
 *
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {void}
 */
function info(message, context = {}) {
  log('info', message, context);
}

/**
 * Logs a warning event.
 *
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {void}
 */
function warn(message, context = {}) {
  log('warn', message, context);
}

/**
 * Logs an error event.
 *
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {void}
 */
function error(message, context = {}) {
  log('error', message, context);
}

/**
 * Adds a request identifier and start timestamp to each request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function requestContextMiddleware(req, res, next) {
  res.locals.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.locals.startedAt = Date.now();
  res.setHeader('X-Request-ID', res.locals.requestId);
  next();
}

/**
 * Logs every request once the response has finished.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function requestLoggingMiddleware(req, res, next) {
  res.on('finish', () => {
    const durationMs = Date.now() - (res.locals.startedAt || Date.now());
    const context = {
      requestId: res.locals.requestId,
      userId: req.user?.id || null,
      role: req.user?.role || null,
      path: req.originalUrl,
      method: req.method,
      duration_ms: durationMs,
      statusCode: res.statusCode
    };

    if (res.statusCode >= 500) {
      error('request_completed_with_server_error', context);
      return;
    }

    if (res.statusCode >= 400) {
      warn('request_completed_with_client_error', context);
      return;
    }

    info('request_completed', context);
  });

  next();
}

module.exports = {
  info,
  warn,
  error,
  requestContextMiddleware,
  requestLoggingMiddleware
};
