const { query } = require('express-validator');

const { GROUP_ID_PATTERN, DEVICE_NAME_PATTERN } = require('./projectValidator');
const { isValidTimeZone } = require('../utils/timezone');
const { VEHICLE_TYPES, ANALYTICS_GRANULARITIES } = require('../utils/constants');

/**
 * Query rules for the reporting endpoints.
 *
 * Every parameter is optional: `GET /api/analytics/summary` with no query is the
 * default dashboard view — the caller's projects, the last 30 local days.
 *
 * `from` and `to` are the one deliberate difference from the other tables. They
 * are validated for shape here but *not* parsed into Dates, because what a bare
 * `2026-08-07` means depends on the `timezone` sent alongside it — and a
 * sanitizer sees one field at a time. The service resolves the pair together
 * (see resolveWindow), which is also where an inverted window is rejected.
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

/**
 * IANA zone name. Validated against the platform's own database rather than a
 * hard-coded list, so a legitimate zone is never rejected and a typo comes back
 * as a 400 naming the field instead of a 500 from inside an aggregation.
 */
const timezoneQueryRule = query('timezone')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('timezone must be a string.')
  .bail()
  .trim()
  .custom((value) => {
    if (!isValidTimeZone(value)) {
      throw new Error('timezone must be an IANA name, e.g. Asia/Kolkata or UTC.');
    }
    return true;
  });

/** A bare local date, or an ISO 8601 datetime. Resolved in the service. */
const windowRule = (field) =>
  query(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a date (YYYY-MM-DD) or an ISO 8601 datetime.`)
    .bail()
    .trim()
    .isISO8601()
    .withMessage(`${field} must be a valid date (e.g. 2026-08-07) or ISO 8601 datetime.`);

const directionRule = query('direction')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('direction must be a string.')
  .bail()
  .trim()
  .toLowerCase()
  .isIn(['entry', 'exit'])
  .withMessage('direction must be either entry or exit.');

const deviceNameRule = query('device_name')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('device_name must be a string.')
  .bail()
  .trim()
  .matches(DEVICE_NAME_PATTERN)
  .withMessage(
    'device_name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'
  );

const vehicleTypeRule = query('vehicle_type')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('vehicle_type must be a string.')
  .bail()
  .trim()
  .toLowerCase()
  .isIn(VEHICLE_TYPES)
  .withMessage(`vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}.`);

const vehicleNumberRule = query('vehicle_number')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('vehicle_number must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .isLength({ min: 3, max: 20 })
  .withMessage('vehicle_number must be between 3 and 20 characters.')
  .matches(/^[A-Z0-9-]+$/)
  .withMessage('vehicle_number may contain only letters, digits and hyphens.');

/** Shared by both reports — the filter bar posts the same values to each. */
const commonReportRules = [
  groupIdQueryRule,
  timezoneQueryRule,
  windowRule('from'),
  windowRule('to'),
  directionRule,
  deviceNameRule,
  vehicleTypeRule,
  vehicleNumberRule,
];

const analyticsSummaryRules = [...commonReportRules];

const trafficSeriesRules = [
  ...commonReportRules,

  query('granularity')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('granularity must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(ANALYTICS_GRANULARITIES)
    .withMessage(`granularity must be one of: ${ANALYTICS_GRANULARITIES.join(', ')}.`),
];

/**
 * The options endpoint takes the two parameters that change its answer: which
 * project to narrow to, and which clock to resolve the quick ranges against.
 */
const analyticsFilterOptionsRules = [groupIdQueryRule, timezoneQueryRule];

module.exports = { analyticsSummaryRules, trafficSeriesRules, analyticsFilterOptionsRules };
