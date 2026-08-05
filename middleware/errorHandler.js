const config = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/** Catch-all for unmatched routes — forwards a 404 to the error handler. */
const notFoundHandler = (req, _res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

/**
 * Translates framework/driver-specific errors into AppError so the response
 * shape stays identical no matter where the failure originated.
 */
const normalizeError = (error) => {
  if (error instanceof AppError) return error;

  // body-parser
  if (error.type === 'entity.too.large') {
    return new AppError(413, `Request payload exceeds the ${config.JSON_BODY_LIMIT} limit.`);
  }
  if (error.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return new AppError(400, 'Malformed JSON in request body.');
  }

  // Mongoose
  if (error.name === 'ValidationError') {
    const details = Object.values(error.errors || {}).map((fieldError) => ({
      field: fieldError.path,
      message: fieldError.message,
    }));
    return new AppError(400, 'Validation failed.', { details });
  }
  if (error.name === 'CastError') {
    return new AppError(400, `Invalid value for '${error.path}'.`);
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return new AppError(409, `Duplicate ${field}: a record with this value already exists.`);
  }

  return null; // unknown / programmer error
};

/**
 * Centralized error handler. Must be registered last.
 * Expected (operational) errors are logged at warn level with no stack;
 * everything else is logged as an error with its stack and reported as 500.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
const errorHandler = (error, req, res, _next) => {
  const normalized = normalizeError(error);
  const isOperational = Boolean(normalized);
  const appError = normalized || AppError.internal();

  const logContext = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    statusCode: appError.statusCode,
    code: appError.code,
    ip: req.ip,
  };

  if (isOperational && appError.statusCode < 500) {
    logger.warn(appError.message, logContext);
  } else {
    logger.error(appError.message, { ...logContext, stack: error.stack, original: error.message });
  }

  if (res.headersSent) return;

  res.status(appError.statusCode).json({
    success: false,
    code: appError.code,
    message: appError.message,
    ...(appError.details ? { errors: appError.details } : {}),
    requestId: req.id,
    // Stacks are development-only — they leak internals otherwise.
    ...(config.IS_PRODUCTION ? {} : { stack: error.stack }),
  });
};

module.exports = { notFoundHandler, errorHandler };
