const crypto = require('crypto');

const config = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Constant-time string comparison — prevents an attacker from recovering the
 * key one character at a time by measuring response latency.
 */
const safeCompare = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));

  // timingSafeEqual throws on length mismatch, so hash first to equalise lengths.
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();

  return crypto.timingSafeEqual(hashA, hashB);
};

/**
 * Extracts the key from `Authorization: <key>`, `Authorization: Bearer <key>`
 * or the `x-api-key` header.
 */
const extractApiKey = (req) => {
  const authorization = req.get('authorization');

  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return (match ? match[1] : authorization).trim();
  }

  const headerKey = req.get('x-api-key');
  return headerKey ? headerKey.trim() : null;
};

/**
 * Rejects any request that does not carry the shared API key.
 * Responds 401 without echoing the supplied value back to the client or logs.
 */
module.exports = function apiKeyAuth(req, _res, next) {
  const provided = extractApiKey(req);

  if (!provided) {
    logger.warn('Rejected request: missing API key', {
      requestId: req.id,
      ip: req.ip,
      path: req.originalUrl,
    });
    return next(AppError.unauthorized('Missing API key. Send it in the Authorization header.'));
  }

  if (!safeCompare(provided, config.API_KEY)) {
    logger.warn('Rejected request: invalid API key', {
      requestId: req.id,
      ip: req.ip,
      path: req.originalUrl,
    });
    return next(AppError.unauthorized('Invalid API key.'));
  }

  return next();
};
