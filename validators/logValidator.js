const { query } = require('express-validator');

const { VEHICLE_TYPES, LOG_MAX_LIMIT } = require('../utils/constants');
const { GROUP_ID_PATTERN, DEVICE_NAME_PATTERN } = require('./projectValidator');
const { dateRangeRules } = require('./dateRules');

/**
 * Query rules for the dashboard's detection-log table.
 *
 * Every filter is optional: `GET /api/logs` with no query is the default view —
 * the caller's most recent detections, newest first.
 */

/**
 * Omit it to read every project the caller can see; name one to narrow. Whether
 * they are entitled to it is decided by buildScopeFilter, not here.
 */
const groupIdQueryRule = query('group_id')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('group_id must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .matches(GROUP_ID_PATTERN)
  .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).');

const listVehicleLogsRules = [
  groupIdQueryRule,

  query('search')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('search must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters.'),

  // One exact plate, for "show me every time this vehicle came through". Same
  // normalisation the plate is stored under, so the match is an equality on an
  // indexed field rather than the regex `search` runs.
  query('vehicle_number')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('vehicle_number must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .isLength({ min: 3, max: 20 })
    .withMessage('vehicle_number must be between 3 and 20 characters.')
    .matches(/^[A-Z0-9-]+$/)
    .withMessage('vehicle_number may contain only letters, digits and hyphens.'),

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

  // When the camera saw the vehicle. The ordering check is part of the set and
  // runs last, so it compares parsed Dates rather than raw strings.
  ...dateRangeRules('from', 'to'),

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

/**
 * `GET /api/logs/filters` takes the one parameter that changes its answer:
 * narrowing the options to a single project, exactly as the table does.
 */
const logFilterOptionsRules = [groupIdQueryRule];

module.exports = { listVehicleLogsRules, logFilterOptionsRules };
