require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

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

  // Refresh tokens are signed with their own key, so a leaked access token can
  // never be replayed as a refresh token (or the reverse) no matter what its
  // claims say. Left empty it is derived from JWT_SECRET below — existing
  // deployments keep booting, and the two token kinds still have separate keys.
  JWT_REFRESH_SECRET: optional('JWT_REFRESH_SECRET', ''),

  // Long, because it is the thing that keeps a user logged in for weeks while
  // the access token stays short-lived enough to be worth little if stolen.
  JWT_REFRESH_EXPIRES_IN: optional('JWT_REFRESH_EXPIRES_IN', '30d'),

  // Concurrent refresh tokens (≈ devices) one account may hold. The oldest is
  // dropped when the cap is reached, so an old phone signs itself out rather
  // than the list growing without bound.
  MAX_ACTIVE_SESSIONS: asInt('MAX_ACTIVE_SESSIONS', 5, { min: 1, max: 50 }),

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

  // ---- Access-change feed (GET /api/feed) ----

  // How often the sweeper looks for passes whose window has just opened or
  // closed. Expiry is only ever visible to Intozi once this has run, so this
  // interval is the worst-case lag between a pass lapsing and the barrier being
  // told. 60s is well inside a 5-10s polling loop's tolerance and costs two
  // indexed queries a minute.
  ACCESS_SWEEP_INTERVAL_MS: asInt('ACCESS_SWEEP_INTERVAL_MS', 60 * 1000, { min: 5000 }),

  // Escape hatch for a second process (a worker, a migration run) that must not
  // also sweep. The API keeps serving the feed either way; nothing else depends
  // on it being on in this particular process.
  ACCESS_SWEEP_ENABLED: optional('ACCESS_SWEEP_ENABLED', 'true') === 'true',

  // How long a change stays readable. This is the real limit on how far behind
  // a consumer may fall: an event pruned before Intozi read it is an event
  // Intozi will never see, which for a revocation means a vehicle that keeps
  // getting in. 30 days is far beyond any plausible outage, and a cursor older
  // than this is reported back as needing a re-seed rather than being served a
  // page with a silent hole in it. 0 disables pruning entirely.
  ACCESS_CHANGE_RETENTION_DAYS: asInt('ACCESS_CHANGE_RETENTION_DAYS', 30, { min: 0, max: 3650 }),

  // ---- Intozi watchlist sync (Prilinesha -> Intozi Ikshana Registry) ----
  //
  // The direction reversed: instead of Intozi polling us for the registry, we
  // push every registration change to Intozi's "manage_watchlist_anpr_app_db_data"
  // API as it happens (see services/intoziService.js). These configure that
  // outbound client.

  // Master switch. Off by default so a deployment without an Intozi endpoint
  // configured never tries to reach a placeholder URL — every sync call becomes
  // a no-op until this is turned on. Turning it on requires a real base URL and
  // key (checked below).
  INTOZI_SYNC_ENABLED: optional('INTOZI_SYNC_ENABLED', 'false') === 'true',

  // Base URL of the Intozi Ikshana server, e.g. https://ikshana.intozi.com/api.
  // The watchlist paths (manage_watchlist_anpr_app_db_data, get_watchlist_…) are
  // appended to this. Left blank until Intozi provides it.
  INTOZI_BASE_URL: optional('INTOZI_BASE_URL', ''),

  // Sent as the `x-api-key` header on every request to Intozi.
  INTOZI_API_KEY: optional('INTOZI_API_KEY', ''),

  // Per-request timeout for the outbound Intozi calls. A push happens inside a
  // dashboard request, so it must not hang the operator's action if Intozi is
  // slow — on timeout the push is logged as failed and the dashboard op still
  // succeeds.
  INTOZI_TIMEOUT_MS: asInt('INTOZI_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),

  // `vehicle_category_name` is required by Intozi and is an integer id in their
  // system (1 = "Guest" in their sample). Prilinesha's registry has no such
  // category, so every pushed vehicle uses this default. Override per deployment
  // once Intozi confirms the category ids for the site.
  INTOZI_DEFAULT_VEHICLE_CATEGORY: asInt('INTOZI_DEFAULT_VEHICLE_CATEGORY', 1, { min: 0 }),

  // The `vehicle_category_name` used when a *visitor pass* is pushed to the
  // watchlist, so Intozi can tell a visitor apart from a permanent registration
  // if its categories distinguish them. Defaults to the same as a registration;
  // set it to the visitor category id Intozi uses once confirmed.
  INTOZI_VISITOR_VEHICLE_CATEGORY: asInt('INTOZI_VISITOR_VEHICLE_CATEGORY', 1, { min: 0 }),

  // The custom-field ids Intozi assigns: field_id 1 is device_name (the gate
  // list), field_id 2 is group_id (society/group). Stated as config so a site
  // whose Intozi instance numbers them differently can correct it without code.
  INTOZI_FIELD_ID_DEVICE_NAME: asInt('INTOZI_FIELD_ID_DEVICE_NAME', 1, { min: 0 }),
  INTOZI_FIELD_ID_GROUP_ID: asInt('INTOZI_FIELD_ID_GROUP_ID', 2, { min: 0 }),

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

// Only checked when it was set explicitly — the derived fallback below is a
// 64-character digest and cannot fail either test.
if (config.JWT_REFRESH_SECRET) {
  if (config.JWT_REFRESH_SECRET.length < 32) {
    errors.push('JWT_REFRESH_SECRET must be at least 32 characters');
  }
  if (config.JWT_REFRESH_SECRET === config.JWT_SECRET) {
    errors.push(
      'JWT_REFRESH_SECRET must differ from JWT_SECRET — sharing one key lets an access token be ' +
        'replayed as a refresh token'
    );
  }
}

// Derived rather than required, so adding refresh tokens does not break an
// existing .env. Domain-separated from JWT_SECRET by the label, so knowing one
// key does not hand over the other.
if (!config.JWT_REFRESH_SECRET) {
  config.JWT_REFRESH_SECRET = crypto
    .createHmac('sha256', config.JWT_SECRET || '')
    .update('prilinesha-anpr:refresh-token:v1')
    .digest('hex');
}

// A half-configured bootstrap silently creates no super admin, which looks like
// a broken login rather than a missing variable.
if (Boolean(config.SUPER_ADMIN_EMAIL) !== Boolean(config.SUPER_ADMIN_PASSWORD)) {
  errors.push('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together (or both left empty)');
}

if (config.SUPER_ADMIN_PASSWORD && config.SUPER_ADMIN_PASSWORD.length < 8) {
  errors.push('SUPER_ADMIN_PASSWORD must be at least 8 characters');
}

// Turning the Intozi sync on without an endpoint to reach is a misconfiguration
// that would otherwise fail silently on every push. A real base URL and key are
// required when the switch is on.
if (config.INTOZI_SYNC_ENABLED) {
  if (!config.INTOZI_BASE_URL) {
    errors.push('INTOZI_BASE_URL is required when INTOZI_SYNC_ENABLED=true');
  } else if (!/^https?:\/\/.+/.test(config.INTOZI_BASE_URL)) {
    errors.push('INTOZI_BASE_URL must start with http:// or https://');
  }
  if (!config.INTOZI_API_KEY) {
    errors.push('INTOZI_API_KEY is required when INTOZI_SYNC_ENABLED=true');
  }
}

// Normalise away a trailing slash so the path join never produces `//`.
if (config.INTOZI_BASE_URL) {
  config.INTOZI_BASE_URL = config.INTOZI_BASE_URL.replace(/\/+$/, '');
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
