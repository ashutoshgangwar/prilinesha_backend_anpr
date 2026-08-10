const { body, param, query } = require('express-validator');

const { VEHICLE_TYPES, REGISTRY_MAX_LIMIT } = require('../utils/constants');
const { GROUP_ID_PATTERN, DEVICE_NAME_PATTERN } = require('./projectValidator');

/**
 * Make and model, as free text — "Swift Dzire", "Activa 6G".
 *
 * Deliberately not an enum: it is a note that helps an operator recognise the
 * vehicle at the gate, nothing branches on it, and a fixed list of Indian
 * models would be wrong within a week.
 *
 * Empty string and null both mean "no model", and are normalised to null so the
 * stored value has one shape. On PATCH that is how you clear one.
 *
 * @param {Function} field `body` for a request field.
 */
const vehicleModelRule = (field) =>
  field('vehicle_model')
    .optional({ nullable: true })
    .isString()
    .withMessage('vehicle_model must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('vehicle_model must be at most 100 characters.')
    .customSanitizer((value) => value || null);

/**
 * "All gates" as an explicit choice on the registration form.
 *
 * When true, the service expands it to every active gate on the project and
 * stores those names — so the record states which gates the vehicle was granted
 * at, rather than leaving it implied by an empty list. It takes precedence over
 * anything sent in `device_names`: a form that ticks "all" and also submits the
 * boxes it had checked means "all", and the two cannot disagree.
 *
 * The empty-list wildcard still works and still means every gate. The
 * difference is what happens to a gate added later: an expanded list does not
 * include it, an empty one does.
 *
 * @param {Function} field `body` for a request field.
 */
const allDevicesRule = (field) =>
  field('all_devices')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('all_devices must be true or false.')
    .bail()
    .toBoolean();

const toInclusiveEndOfDay = (value) => {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDateOnly) return new Date(`${value}T23:59:59.999Z`);

  // Same convention as created_datetime: no offset means UTC.
  const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
};

const registerVehicleRules = [
  // Optional on the wire: a customer admin assigned to exactly one project may
  // omit it and have their single project filled in — see requireProjectAccess
  // in middleware/auth.js, which runs after this and is what actually decides
  // the project. Anyone with access to several must name one.
  body('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).'),

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

  vehicleModelRule(body),

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

  // Which gates the vehicle is registered at. Pick them from
  // `GET /api/projects/{group_id}/devices`; every name is checked against that
  // project, so a gate that does not exist is a 400 rather than a restriction
  // no camera will ever satisfy.
  //
  // Empty or omitted means "valid at every gate in the project", which is the
  // normal case; a list restricts the registration to those gates only.
  body('device_names')
    .optional({ nullable: true })
    .isArray({ max: 100 })
    .withMessage('device_names must be an array of at most 100 device names.'),

  body('device_names.*')
    .isString()
    .withMessage('each device name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage('each device name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'),

  allDevicesRule(body),
];

const vehicleIdParamRule = param('id')
  .isMongoId()
  .withMessage('id must be a valid vehicle id.');

/**
 * PATCH rules. Every field is optional — only what is sent changes — but the
 * service rejects a body that sends nothing at all, so a typo'd field name
 * cannot look like a successful no-op edit.
 *
 * `group_id` and `vehicle_number` are absent on purpose: together they are the
 * row's identity, and changing either is registering a different vehicle.
 */
const updateVehicleRules = [
  vehicleIdParamRule,

  body('name')
    .optional()
    .isString()
    .withMessage('name must be a string.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('name cannot be empty.')
    .isLength({ max: 150 })
    .withMessage('name must be at most 150 characters.'),

  body('phone_number')
    .optional()
    .isString()
    .withMessage('phone_number must be a string.')
    .bail()
    .trim()
    .matches(/^\+?[0-9][0-9\s-]{5,19}$/)
    .withMessage(
      'phone_number must be 6-20 characters of digits, optionally prefixed with + and separated by spaces or hyphens.'
    ),

  vehicleModelRule(body),

  body('valid_till')
    .optional()
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

  // An explicit `[]` widens a gate-restricted registration back to every gate,
  // so this is `optional()` without checkFalsy — an empty array is a real edit.
  body('device_names')
    .optional({ nullable: true })
    .isArray({ max: 100 })
    .withMessage('device_names must be an array of at most 100 device names.'),

  body('device_names.*')
    .isString()
    .withMessage('each device name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage('each device name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'),

  allDevicesRule(body),

  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean.')
    .bail()
    .toBoolean(),
];

/** The dedicated activate/deactivate switch, where is_active is the whole point. */
const setVehicleStatusRules = [
  vehicleIdParamRule,

  body('is_active')
    .exists({ checkNull: true })
    .withMessage('is_active is required.')
    .bail()
    .isBoolean()
    .withMessage('is_active must be a boolean.')
    .bail()
    .toBoolean(),
];

const vehicleIdParamRules = [vehicleIdParamRule];

const listVehiclesRules = [
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

  query('status')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('status must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(VEHICLE_TYPES)
    .withMessage(`status must be one of: ${VEHICLE_TYPES.join(', ')}.`),

  // The manual switch on its own, which `status` cannot express — it folds
  // expiry in, so `status=unregistered` cannot answer "which have we suspended?"
  query('is_active')
    .optional({ nullable: true, checkFalsy: false })
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .bail()
    .toBoolean(),

  query('registered_by')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('registered_by must be a valid user id.'),

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

module.exports = {
  registerVehicleRules,
  listVehiclesRules,
  updateVehicleRules,
  setVehicleStatusRules,
  vehicleIdParamRules,
};
