const { validationResult } = require('express-validator');

const AppError = require('../utils/AppError');

/**
 * Runs a chain of express-validator rules and converts any failures into a
 * single 400 AppError carrying a field-by-field breakdown.
 *
 * @param {Array} rules express-validator chains
 * @returns {Array} middleware stack
 */
module.exports = function validate(rules) {
  return [
    ...rules,
    (req, _res, next) => {
      const result = validationResult(req);
      if (result.isEmpty()) return next();

      const details = result.array({ onlyFirstError: true }).map((error) => ({
        field: error.path,
        message: error.msg,
      }));

      return next(AppError.badRequest('Request validation failed.', details));
    },
  ];
};
