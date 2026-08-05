const { v4: uuidv4 } = require('uuid');

const logger = require('../utils/logger');

/**
 * Assigns a request id (honouring an inbound `X-Request-Id`) and echoes it back
 * on the response, so a client can quote it when reporting a failure.
 */
const requestId = (req, res, next) => {
  req.id = req.get('x-request-id') || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  next();
};

/**
 * Logs one line per completed request with its duration, plus the ANPR-specific
 * identifiers (device, plate, transaction) when present in the body.
 */
const requestLogger = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  logger.info('Incoming request', {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    contentLength: req.get('content-length') || null,
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const body = req.body || {};
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger.log(level, 'Request completed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      device_name: body.device_name || undefined,
      vehicle_number: body.vehicle_number || undefined,
      transaction_id: body.transaction_id || undefined,
    });
  });

  next();
};

/** Adds `X-Response-Time` before the response is sent. */
const responseTime = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const originalWriteHead = res.writeHead;

  res.writeHead = function writeHead(...args) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (!res.headersSent) res.setHeader('X-Response-Time', `${durationMs.toFixed(2)}ms`);
    return originalWriteHead.apply(this, args);
  };

  next();
};

module.exports = { requestId, requestLogger, responseTime };
