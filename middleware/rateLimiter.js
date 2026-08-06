const rateLimit = require('express-rate-limit');

const config = require('../config/env');
const logger = require('../utils/logger');

const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { requestId: req.id, ip: req.ip, path: req.originalUrl });

    res.status(429).json({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please retry later.',
      requestId: req.id,
    });
  },
});

/**
 * Login and signup are the two endpoints worth guessing at, so they get a far
 * tighter budget than the rest of the API: password spraying and account
 * enumeration both look like many attempts from one source.
 *
 * Successful logins are not counted — a busy office behind one NAT address
 * should never lock itself out by working normally.
 */
const authLimiter = rateLimit({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', { requestId: req.id, ip: req.ip, path: req.originalUrl });

    res.status(429).json({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many attempts. Please try again later.',
      requestId: req.id,
    });
  },
});

module.exports = { apiLimiter, authLimiter };
