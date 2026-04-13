const dotenv = require('dotenv');
const packageJson = require('../../package.json');

dotenv.config();

const REQUIRED_ENV_VARS = Object.freeze({
  PORT: 'Local development port used when the API is not running on Vercel.',
  SUPABASE_URL: 'Supabase project URL for database and auth requests.',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service role key used by backend-only administrative operations.',
  SUPABASE_ANON_KEY: 'Supabase anon key used for user login and session exchange flows.',
  FRONTEND_URL: 'Primary frontend origin allowed to call this API in production.',
  ADMIN_SETUP_KEY: 'One-time bootstrap secret required to create the first admin account.',
  NODE_ENV: 'Runtime environment. Use development, test, or production.'
});

const DEFAULTS = Object.freeze({
  RATE_LIMIT_WINDOW_MS: 900000,
  RATE_LIMIT_MAX: 100,
  WEBHOOK_TIMEOUT_MS: 5000,
  WEBHOOK_RETRY_DELAY_MS: 1000,
  TIMEZONE: 'Australia/Sydney',
  PUBLIC_AUTH_LIMIT: 10,
  N8N_AGENT_LIMIT: 500,
  PATIENT_LIMIT: 60,
  RECEPTIONIST_LIMIT: 200,
  ADMIN_DOCTOR_LIMIT: 300,
  VERCEL_MEMORY_MB: 512,
  VERCEL_MAX_DURATION_SECONDS: 30
});

const APP_VERSION = packageJson.version;

const missingVars = Object.entries(REQUIRED_ENV_VARS)
  .filter(([name]) => !process.env[name] || !String(process.env[name]).trim())
  .map(([name, description]) => ({ name, description }));

if (missingVars.length) {
  console.error('[config] Missing required environment variables. Set the following values before starting the API:');
  missingVars.forEach(({ name, description }) => {
    console.error(`- ${name}: ${description}`);
  });
  process.exit(1);
}

const parseIntegerEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`[config] ${name} must be a positive integer. Received "${raw}". Update the environment variable and redeploy.`);
    process.exit(1);
  }

  return parsed;
};

const normalizeOrigin = (value) => {
  if (!value) {
    return '';
  }

  return String(value).trim().replace(/\/+$/, '');
};

const frontendUrl = normalizeOrigin(process.env.FRONTEND_URL);
const vercelUrl = normalizeOrigin(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  frontendUrl,
  vercelUrl
].filter(Boolean);

const config = Object.freeze({
  app: Object.freeze({
    name: 'clinic-crm-api',
    version: APP_VERSION,
    port: parseIntegerEnv('PORT', 3001),
    environment: process.env.NODE_ENV,
    timezone: DEFAULTS.TIMEZONE,
    isProduction,
    isVercel: process.env.VERCEL === '1'
  }),
  supabase: Object.freeze({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY
  }),
  security: Object.freeze({
    adminSetupKey: process.env.ADMIN_SETUP_KEY
  }),
  rateLimit: Object.freeze({
    windowMs: parseIntegerEnv('RATE_LIMIT_WINDOW_MS', DEFAULTS.RATE_LIMIT_WINDOW_MS),
    defaultMax: parseIntegerEnv('RATE_LIMIT_MAX', DEFAULTS.RATE_LIMIT_MAX),
    publicAuthMax: DEFAULTS.PUBLIC_AUTH_LIMIT,
    n8nAgentMax: DEFAULTS.N8N_AGENT_LIMIT,
    patientMax: DEFAULTS.PATIENT_LIMIT,
    receptionistMax: DEFAULTS.RECEPTIONIST_LIMIT,
    adminDoctorMax: DEFAULTS.ADMIN_DOCTOR_LIMIT
  }),
  webhooks: Object.freeze({
    timeoutMs: parseIntegerEnv('WEBHOOK_TIMEOUT_MS', DEFAULTS.WEBHOOK_TIMEOUT_MS),
    retryDelayMs: DEFAULTS.WEBHOOK_RETRY_DELAY_MS,
    clinicId: process.env.CLINIC_ID ? String(process.env.CLINIC_ID).trim() : 'default-clinic'
  }),
  cors: Object.freeze({
    allowedOrigins,
    allowedMethods: Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
    allowedHeaders: Object.freeze(['Content-Type', 'Authorization', 'X-Request-ID'])
  }),
  vercel: Object.freeze({
    url: vercelUrl,
    region: 'syd1',
    memoryMb: DEFAULTS.VERCEL_MEMORY_MB,
    maxDurationSeconds: DEFAULTS.VERCEL_MAX_DURATION_SECONDS
  })
});

module.exports = config;
