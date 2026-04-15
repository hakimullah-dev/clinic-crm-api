process.env.TZ = 'Australia/Sydney';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./lib/config');
const supabase = require('./lib/supabase');
const authenticate = require('./middleware/auth');
const { error: logError, info: logInfo, requestContextMiddleware, requestLoggingMiddleware } = require('./lib/logger');

const { ipKeyGenerator } = rateLimit;
const app = express();

const lazyRouter = (loader) => {
  let router;

  return (req, res, next) => {
    try {
      router = router || loader();
      return router(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
};

const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '');

const createRateLimitHandler = (message) => (req, res) => {
  const retryAfterSeconds = Math.ceil(config.rateLimit.windowMs / 1000);
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: message,
    details: []
  });
};

const authenticatedKeyGenerator = (req) => {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }

  return ipKeyGenerator(req.ip);
};

const authenticatedLimitForRole = (req) => {
  switch (req.user?.role) {
    case 'n8n_agent':
      return config.rateLimit.n8nAgentMax;
    case 'patient':
      return config.rateLimit.patientMax;
    case 'receptionist':
      return config.rateLimit.receptionistMax;
    case 'doctor':
    case 'admin':
      return config.rateLimit.adminDoctorMax;
    default:
      return config.rateLimit.defaultMax;
  }
};

const publicAuthLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.publicAuthMax,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('Too many authentication requests from this IP. Wait 15 minutes before retrying.')
});

const authenticatedLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: authenticatedLimitForRole,
  keyGenerator: authenticatedKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('Rate limit exceeded for this account. Reduce request volume and retry after the Retry-After interval.')
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestContextMiddleware);
app.use(requestLoggingMiddleware);
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true
  },
  noSniff: true,
  xssFilter: true
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (config.cors.allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(Object.assign(
      new Error(`CORS blocked for origin ${normalizedOrigin}. Add it to FRONTEND_URL or deploy from an approved frontend origin.`),
      { status: 403, details: [] }
    ));
  },
  methods: config.cors.allowedMethods,
  allowedHeaders: config.cors.allowedHeaders
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_profiles')
      .select('user_id', { count: 'exact', head: true });

    if (error) {
      throw error;
    }

    return res.json({
      status: 'ok',
      version: config.app.version,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      db_connected: true,
      environment: config.app.environment
    });
  } catch (error) {
    logError('health_check_degraded', {
      requestId: res.locals.requestId,
      path: req.originalUrl,
      method: req.method,
      error: error.message
    });

    return res.status(503).json({
      status: 'degraded',
      version: config.app.version,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      db_connected: false,
      environment: config.app.environment
    });
  }
});

app.use('/api/auth', publicAuthLimiter, lazyRouter(() => require('./routes/auth')));
app.use('/api/doctors', lazyRouter(() => require('./routes/doctors').publicRouter));

app.use('/api/webhooks', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/webhooks')));
app.use('/api/patients', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/patients')));
app.use('/api/appointments', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/appointments')));
app.use('/api/doctors', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/doctors').router));
app.use('/api/intake-forms', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/intake-forms')));
app.use('/api/waitlist', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/waitlist')));
app.use('/api/feedback', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/feedback')));
app.use('/api/reports', authenticate, authenticatedLimiter, lazyRouter(() => require('./routes/reports')));

app.use((req, res) => {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found. Verify the path and HTTP method.`,
    details: []
  });
});

app.use((err, req, res, next) => {
  const supabaseCode = err.code || err.details?.code || err.cause?.code;
  const networkErrorCodes = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

  logError('unhandled_error', {
    requestId: res.locals.requestId,
    userId: req.user?.id || null,
    role: req.user?.role || null,
    path: req.originalUrl,
    method: req.method,
    duration_ms: Date.now() - (res.locals.startedAt || Date.now()),
    error: err.message,
    code: err.code || null
  });

  if (supabaseCode === '23505') {
    return res.status(409).json({
      error: 'A record with the same unique value already exists. Check unique fields and retry.',
      details: []
    });
  }

  if (supabaseCode === '23503') {
    return res.status(400).json({
      error: 'One or more referenced records do not exist. Verify related IDs before retrying.',
      details: []
    });
  }

  if (supabaseCode === '22P02') {
    return res.status(400).json({
      error: 'One or more provided values have an invalid format. Validate UUIDs, dates, and enums before retrying.',
      details: []
    });
  }

  if (networkErrorCodes.has(err.code)) {
    return res.status(503).json({
      error: 'A downstream service is temporarily unreachable. Check Supabase or network connectivity and retry.',
      details: []
    });
  }

  if (err.status && Number.isInteger(err.status)) {
    return res.status(err.status).json({
      error: err.message || 'Request failed. Review the server logs for the request ID and retry.',
      details: Array.isArray(err.details) ? err.details : []
    });
  }

  return res.status(500).json({
    error: 'Internal server error. Use the request ID in the response headers to inspect server logs.',
    details: Array.isArray(err.details) ? err.details : []
  });
});

if (!config.app.isVercel) {
  app.listen(config.app.port, () => {
    logInfo('server_started', {
      path: '/health',
      method: 'GET',
      port: config.app.port
    });
  });
}

module.exports = app;
