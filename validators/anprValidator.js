const { body, query } = require('express-validator');

const { VEHICLE_CLASSES, VEHICLE_COLORS, VEHICLE_TYPES, FEED_MAX_LIMIT } = require('../utils/constants');
const { GROUP_ID_PATTERN } = require('./projectValidator');

/**
 * Validation rules for POST /api/anpr.
 *
 * Values are coerced here (numbers, booleans, dates) so the service layer can
 * assume a clean, typed payload and focus purely on business rules.
 */

/** Booleans arrive as real booleans from most cameras and as "true"/"false" from some. */
const optionalBoolean = (field) =>
  body(field)
    .optional({ nullable: true })
    .isBoolean({ strict: false })
    .withMessage(`${field} must be a boolean.`)
    .toBoolean();

/** Free-text detail that a camera may omit, send as null or send as "". */
const optionalText = (field, maxLength) =>
  body(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a string.`)
    .bail()
    .trim()
    .isLength({ max: maxLength })
    .withMessage(`${field} must be at most ${maxLength} characters.`);

/** Latitude/longitude are transmitted as strings; validate the numeric range. */
const optionalCoordinate = (field, limit) =>
  body(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a string.`)
    .bail()
    .trim()
    .custom((value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
        throw new Error(`${field} must be a number between -${limit} and ${limit}.`);
      }
      return true;
    });

const anprEventRules = [
  // ---- Source application ----
  body('application_name')
    .exists({ checkNull: true })
    .withMessage('application_name is required.')
    .bail()
    .isString()
    .withMessage('application_name must be a string.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('application_name cannot be empty.')
    .isLength({ max: 100 })
    .withMessage('application_name must be at most 100 characters.'),

  body('application_id')
    .exists({ checkNull: true })
    .withMessage('application_id is required.')
    .bail()
    .isInt({ min: 0 })
    .withMessage('application_id must be a non-negative integer.')
    .toInt(),

  // ---- Device ----
  body('device_name')
    .exists({ checkNull: true })
    .withMessage('device_name is required.')
    .bail()
    .isString()
    .withMessage('device_name must be a string.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('device_name cannot be empty.')
    .isLength({ max: 150 })
    .withMessage('device_name must be at most 150 characters.'),

  body('device_unique_key')
    .exists({ checkNull: true })
    .withMessage('device_unique_key is required.')
    .bail()
    .trim()
    .isUUID()
    .withMessage('device_unique_key must be a valid UUID.'),

  // The project this event belongs to. Optional on the wire because a
  // per-project API key already identifies the project and overrides whatever
  // is sent here (see services/anprService.js) — it stays accepted so cameras
  // on the legacy global key can still say which project they are posting for.
  body('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage(
      'group_id must be 2-50 characters of letters, digits, underscores or hyphens (e.g. ACME_MALL).'
    ),

  // ---- Geo ----
  optionalCoordinate('latitude', 90),
  optionalCoordinate('longitude', 180),

  // ---- Event identity ----
  body('cam_id')
    .exists({ checkNull: true })
    .withMessage('cam_id is required.')
    .bail()
    .isInt({ min: 0 })
    .withMessage('cam_id must be a non-negative integer.')
    .toInt(),

  body('transaction_id')
    .exists({ checkNull: true })
    .withMessage('transaction_id is required.')
    .bail()
    .isInt({ min: 0 })
    .withMessage('transaction_id must be a non-negative integer.')
    .toInt(),

  // ---- Detection ----
  body('vehicle_number')
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

  body('vehicle_class')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('vehicle_class must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_CLASSES)
    .withMessage(`vehicle_class must be one of: ${VEHICLE_CLASSES.join(', ')}.`),

  body('color')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('color must be a string.')
    .bail()
    .trim()
    .isIn(VEHICLE_COLORS)
    .withMessage(`color must be one of: ${VEHICLE_COLORS.join(', ')}.`),

  body('vehicle_type')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('vehicle_type must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_TYPES)
    .withMessage(`vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}.`),

  optionalText('vehicle_model', 100),

  // ---- Owner / driver details (stored, never returned on the Intozi feed) ----
  optionalText('owner_name', 150),
  optionalText('driver_name', 150),

  body('contact_no')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('contact_no must be a string.')
    .bail()
    .trim()
    .matches(/^\+?[0-9][0-9\s-]{5,19}$/)
    .withMessage(
      'contact_no must be 6-20 characters of digits, optionally prefixed with + and separated by spaces or hyphens.'
    ),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('email must be a string.')
    .bail()
    .trim()
    .isEmail()
    .withMessage('email must be a valid email address.')
    .bail()
    .isLength({ max: 254 })
    .withMessage('email must be at most 254 characters.')
    .normalizeEmail({ gmail_remove_dots: false }),

  // ---- Violation flags ----
  optionalBoolean('triple_riding'),
  optionalBoolean('no_helmet'),
  optionalBoolean('no_seatbelt'),
  optionalBoolean('driver_on_call_status'),

  // ---- Images (optional; decoded and written to disk by the service layer) ----
  // Omitted, null or "" all mean "no image" — the event is still stored.
  body('event_image')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('event_image must be a base64 string.'),

  body('plate_image')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('plate_image must be a base64 string.'),

  // ---- Timestamp ----
  body('created_datetime')
    .exists({ checkNull: true })
    .withMessage('created_datetime is required.')
    .bail()
    .isString()
    .withMessage('created_datetime must be an ISO 8601 datetime string.')
    .bail()
    .trim()
    .isISO8601()
    .withMessage('created_datetime must be a valid ISO 8601 datetime (e.g. 2025-12-22T12:33:01.744613).')
    .bail()
    .customSanitizer((value) => {
      // Cameras send a naive timestamp (no offset). Interpret it as UTC so the
      // stored instant does not depend on the server's local timezone.
      const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
      return new Date(hasTimezone ? value : `${value}Z`);
    })
    .custom((value) => {
      if (Number.isNaN(value.getTime())) throw new Error('created_datetime is not a parsable datetime.');
      return true;
    }),
];

/**
 * Validation rules for GET /api/anpr/feed — the endpoint Intozi polls every
 * 5-10 seconds.
 */
const anprFeedQueryRules = [
  // Only narrows within what the key already grants: a per-project key that
  // names a different project is rejected with 403, not silently widened.
  query('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).'),

  query('cursor')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('cursor must be a string.')
    .bail()
    .trim()
    .isLength({ max: 200 })
    .withMessage('cursor is not a valid feed cursor.'),

  query('since')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('since must be an ISO 8601 datetime string.')
    .bail()
    .trim()
    .isISO8601()
    .withMessage('since must be a valid ISO 8601 datetime (e.g. 2025-12-22T12:33:01.744Z).')
    .bail()
    .customSanitizer((value) => {
      // Same rule as created_datetime: a naive timestamp means UTC.
      const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
      return new Date(hasTimezone ? value : `${value}Z`);
    }),

  // Omitted → the service falls back to FEED_DEFAULT_LIMIT.
  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: FEED_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${FEED_MAX_LIMIT}.`)
    .toInt(),

  query('vehicle_type')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('vehicle_type must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_TYPES)
    .withMessage(`vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}.`),
];

module.exports = { anprEventRules, anprFeedQueryRules };
