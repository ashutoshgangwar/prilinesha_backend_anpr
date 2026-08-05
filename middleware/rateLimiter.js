const rateLimit = require('express-rate-limit');

const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Per-IP rate limiter for the API surface. Returns the standard
 * `RateLimit-*` headers and this API's error envelope on rejection.
 */
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

module.exports = { apiLimiter };
