require('dotenv').config();

const path = require('path');

/**
 * Environment validation + coercion.
 *
 * Loaded before anything else (see server.js). A missing or malformed variable
 * aborts the process at boot with a single, explicit report instead of failing
 * later at request time.
 */

const errors = [];

const required = (key, { pattern, hint } = {}) => {
  const value = process.env[key];
  if (!value || !String(value).trim()) {
    errors.push(`${key} is required${hint ? ` (${hint})` : ''}`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${key} is invalid${hint ? ` (${hint})` : ''}`);
  }
  return value.trim();
};

const optional = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : String(value).trim();
};

const asInt = (key, fallback, { min, max } = {}) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    errors.push(`${key} must be an integer`);
    return fallback;
  }
  if (min !== undefined && parsed < min) errors.push(`${key} must be >= ${min}`);
  if (max !== undefined && parsed > max) errors.push(`${key} must be <= ${max}`);
  return parsed;
};

const asEnum = (key, allowed, fallback) => {
  const value = optional(key, fallback);
  if (!allowed.includes(value)) {
    errors.push(`${key} must be one of: ${allowed.join(', ')}`);
    return fallback;
  }
  return value;
};

const NODE_ENV = asEnum('NODE_ENV', ['development', 'production', 'test'], 'development');

const config = {
  NODE_ENV,
  IS_PRODUCTION: NODE_ENV === 'production',

  PORT: asInt('PORT', 5050, { min: 1, max: 65535 }),

  MONGO_URI: required('MONGO_URI', {
    pattern: /^mongodb(\+srv)?:\/\/.+/,
    hint: 'must start with mongodb:// or mongodb+srv://',
  }),
  MONGO_MAX_RETRIES: asInt('MONGO_MAX_RETRIES', 10, { min: 1 }),
  MONGO_RETRY_DELAY_MS: asInt('MONGO_RETRY_DELAY_MS', 3000, { min: 100 }),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: asInt('MONGO_SERVER_SELECTION_TIMEOUT_MS', 10000, { min: 1000 }),

  API_KEY: required('API_KEY', { hint: 'shared secret sent in the Authorization header' }),

  // ---- Dashboard authentication (JWT) ----
  JWT_SECRET: required('JWT_SECRET', {
    hint: 'signing key for dashboard access tokens; at least 32 characters',
  }),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '12h'),
  JWT_ISSUER: optional('JWT_ISSUER', 'prilinesha-anpr'),

  // Work factor for password hashing. 12 is ~250ms on modern hardware — high
  // enough to make offline cracking expensive, low enough for a login endpoint.
  BCRYPT_ROUNDS: asInt('BCRYPT_ROUNDS', 12, { min: 10, max: 15 }),

  // ---- First super admin (seeded on boot, only when none exists) ----
  SUPER_ADMIN_EMAIL: optional('SUPER_ADMIN_EMAIL', ''),
  SUPER_ADMIN_PASSWORD: optional('SUPER_ADMIN_PASSWORD', ''),
  SUPER_ADMIN_NAME: optional('SUPER_ADMIN_NAME', 'Super Admin'),

  // Public signup. Turn off once every customer admin has been created, so the
  // endpoint cannot be used to enumerate or spam the user table.
  SIGNUP_ENABLED: optional('SIGNUP_ENABLED', 'true') === 'true',

  // Attempts per IP per window on /api/auth/login and /api/auth/signup.
  AUTH_RATE_LIMIT_WINDOW_MS: asInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
  AUTH_RATE_LIMIT_MAX: asInt('AUTH_RATE_LIMIT_MAX', 10, { min: 1 }),

  UPLOAD_DIR: path.resolve(process.cwd(), optional('UPLOAD_DIR', './uploads')),
  UPLOAD_PUBLIC_PATH: optional('UPLOAD_PUBLIC_PATH', '/uploads'),
  SERVE_UPLOADS: optional('SERVE_UPLOADS', 'true') === 'true',
  MAX_IMAGE_BYTES: asInt('MAX_IMAGE_BYTES', 10 * 1024 * 1024, { min: 1024 }),

  JSON_BODY_LIMIT: optional('JSON_BODY_LIMIT', '15mb'),

  CORS_ORIGIN: optional('CORS_ORIGIN', '*'),

  RATE_LIMIT_WINDOW_MS: asInt('RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  RATE_LIMIT_MAX: asInt('RATE_LIMIT_MAX', 300, { min: 1 }),

  REQUEST_TIMEOUT_MS: asInt('REQUEST_TIMEOUT_MS', 30000, { min: 1000 }),
  SHUTDOWN_TIMEOUT_MS: asInt('SHUTDOWN_TIMEOUT_MS', 10000, { min: 1000 }),

  LOG_LEVEL: asEnum('LOG_LEVEL', ['error', 'warn', 'info', 'http', 'debug'], 'info'),
  LOG_DIR: path.resolve(process.cwd(), optional('LOG_DIR', './logs')),

  // false | true | hop count | comma-separated list of trusted proxy IPs/subnets
  TRUST_PROXY: (() => {
    const raw = optional('TRUST_PROXY', 'false');
    if (raw === 'false') return false;
    if (raw === 'true') return 1;
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  })(),

  SWAGGER_ENABLED: optional('SWAGGER_ENABLED', 'true') === 'true',
};

// Reject an unchanged sample key in production — a placeholder secret is worse
// than none because it looks configured.
if (config.IS_PRODUCTION && /change-me|your_api_key|secret/i.test(config.API_KEY || '')) {
  errors.push('API_KEY still holds a placeholder value; generate a real secret before deploying');
}

// A short JWT secret is brute-forceable offline against any captured token.
if (config.JWT_SECRET && config.JWT_SECRET.length < 32) {
  errors.push('JWT_SECRET must be at least 32 characters');
}

if (config.IS_PRODUCTION && /change-me|replace-with|placeholder/i.test(config.JWT_SECRET || '')) {
  errors.push('JWT_SECRET still holds a placeholder value; generate a real secret before deploying');
}

// A half-configured bootstrap silently creates no super admin, which looks like
// a broken login rather than a missing variable.
if (Boolean(config.SUPER_ADMIN_EMAIL) !== Boolean(config.SUPER_ADMIN_PASSWORD)) {
  errors.push('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together (or both left empty)');
}

if (config.SUPER_ADMIN_PASSWORD && config.SUPER_ADMIN_PASSWORD.length < 8) {
  errors.push('SUPER_ADMIN_PASSWORD must be at least 8 characters');
}

if (errors.length) {
  /* eslint-disable no-console */
  console.error('\n Invalid environment configuration:\n');
  errors.forEach((message) => console.error(`   - ${message}`));
  console.error('\n  Fix your .env file (see .env.example) and start again.\n');
  process.exit(1);
}

// The logger reads these directly, and it is constructed after this module.
process.env.LOG_LEVEL = config.LOG_LEVEL;
process.env.LOG_DIR = config.LOG_DIR;

module.exports = config;
