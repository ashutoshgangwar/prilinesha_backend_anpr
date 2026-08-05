/**
 * Wraps an async route handler so rejected promises reach Express' error
 * middleware instead of becoming unhandled rejections.
 *
 * @param {Function} fn async (req, res, next) => any
 * @returns {Function} Express handler
 */
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
