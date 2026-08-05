/**
 * Operational error carrying an HTTP status code.
 *
 * Anything thrown that is NOT an AppError is treated by the error handler as an
 * unexpected programmer error: it is logged with a stack trace and reported to
 * the client as a generic 500.
 */
class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status code to return.
   * @param {string} message    Client-safe message.
   * @param {object} [options]
   * @param {string} [options.code]    Machine-readable error code.
   * @param {any}    [options.details] Extra payload (e.g. validation errors).
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);

    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code || AppError.codeForStatus(statusCode);
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  static codeForStatus(statusCode) {
    const map = {
      400: 'VALIDATION_ERROR',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'DUPLICATE_RESOURCE',
      413: 'PAYLOAD_TOO_LARGE',
      429: 'RATE_LIMIT_EXCEEDED',
      500: 'INTERNAL_SERVER_ERROR',
    };
    return map[statusCode] || 'ERROR';
  }

  static badRequest(message, details) {
    return new AppError(400, message, { details });
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(401, message);
  }

  static notFound(message = 'Resource not found') {
    return new AppError(404, message);
  }

  static conflict(message, details) {
    return new AppError(409, message, { details });
  }

  static internal(message = 'Internal server error') {
    return new AppError(500, message);
  }
}

module.exports = AppError;
