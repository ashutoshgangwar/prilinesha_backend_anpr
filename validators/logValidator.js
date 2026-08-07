const { query } = require('express-validator');

const { VEHICLE_TYPES, LOG_MAX_LIMIT } = require('../utils/constants');
const { GROUP_ID_PATTERN, DEVICE_NAME_PATTERN } = require('./projectValidator');

/**
 * Query rules for the dashboard's detection-log table.
 *
 * Every filter is optional: `GET /api/logs` with no query is the default view —
 * the caller's most recent detections, newest first.
 */

/**
 * Parses a boundary of the `from` / `to` window.
 *
 * A bare date means the whole of that day, so `to=2026-08-07` includes the 7th
 * rather than stopping at midnight — an operator asking for "up to the 7th"
 * means the day, not the instant it began. Anything with a time is taken as
 * given, and a timestamp with no offset is UTC, matching the convention
 * `created_datetime` is stored under (see validators/anprValidator.js).
 *
 * @param {'start'|'end'} edge Which end of the day a bare date expands to.
 */
const toInstant = (edge) => (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`);
  }

  const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
};

const dateRule = (field, edge) =>
  query(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a date (YYYY-MM-DD) or an ISO 8601 datetime.`)
    .bail()
    .trim()
    .isISO8601()
    .withMessage(`${field} must be a valid date (e.g. 2026-08-07) or ISO 8601 datetime.`)
    .bail()
    .customSanitizer(toInstant(edge))
    .custom((value) => {
      if (Number.isNaN(value.getTime())) throw new Error(`${field} is not a parsable date.`);
      return true;
    });

const listVehicleLogsRules = [
  // Omit it to read every project the caller can see; name one to narrow.
  // Whether they are entitled to it is decided by buildScopeFilter, not here.
  query('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).'),

  query('search')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('search must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters.'),

  query('vehicle_type')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('vehicle_type must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_TYPES)
    .withMessage(`vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}.`),

  query('device_name')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('device_name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage(
      'device_name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'
    ),

  dateRule('from', 'start'),
  dateRule('to', 'end'),

  // Checked after both have been parsed, so the comparison is on Dates.
  query('to').custom((value, { req }) => {
    const from = req.query?.from;
    if (value && from && value < from) {
      throw new Error('to must be the same as or after from.');
    }
    return true;
  }),

  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('page must be an integer >= 1.')
    .toInt(),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: LOG_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${LOG_MAX_LIMIT}.`)
    .toInt(),
];

module.exports = { listVehicleLogsRules };
