const { body, query } = require('express-validator');

const { VEHICLE_TYPES, REGISTRY_MAX_LIMIT } = require('../utils/constants');

const toInclusiveEndOfDay = (value) => {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDateOnly) return new Date(`${value}T23:59:59.999Z`);

  // Same convention as created_datetime: no offset means UTC.
  const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
};

const registerVehicleRules = [
  body('vehicle_number')
    .exists({ checkNull: true })
    .withMessage('vehicle_number is required.')
    .bail()
    .isString()
    .withMessage('vehicle_number must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .isLength({ min: 3, max: 20 })
    .withMessage('vehicle_number must be between 3 and 20 characters.')
    .matches(/^[A-Z0-9-]+$/)
    .withMessage('vehicle_number may contain only letters, digits and hyphens.'),

  body('name')
    .exists({ checkNull: true })
    .withMessage('name is required.')
    .bail()
    .isString()
    .withMessage('name must be a string.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('name cannot be empty.')
    .isLength({ max: 150 })
    .withMessage('name must be at most 150 characters.'),

  body('phone_number')
    .exists({ checkNull: true })
    .withMessage('phone_number is required.')
    .bail()
    .isString()
    .withMessage('phone_number must be a string.')
    .bail()
    .trim()
    .matches(/^\+?[0-9][0-9\s-]{5,19}$/)
    .withMessage(
      'phone_number must be 6-20 characters of digits, optionally prefixed with + and separated by spaces or hyphens.'
    ),

  body('valid_till')
    .exists({ checkNull: true })
    .withMessage('valid_till is required.')
    .bail()
    .isString()
    .withMessage('valid_till must be a date (YYYY-MM-DD) or an ISO 8601 datetime.')
    .bail()
    .trim()
    .isISO8601()
    .withMessage('valid_till must be a valid date (e.g. 2026-12-31) or ISO 8601 datetime.')
    .bail()
    .customSanitizer(toInclusiveEndOfDay)
    .custom((value) => {
      if (Number.isNaN(value.getTime())) throw new Error('valid_till is not a parsable date.');
      return true;
    }),
];

const listVehiclesRules = [
  query('search')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('search must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters.'),

  query('status')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('status must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_TYPES)
    .withMessage(`status must be one of: ${VEHICLE_TYPES.join(', ')}.`),

  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('page must be an integer >= 1.')
    .toInt(),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: REGISTRY_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${REGISTRY_MAX_LIMIT}.`)
    .toInt(),
];

module.exports = { registerVehicleRules, listVehiclesRules };
