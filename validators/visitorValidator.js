const { body, param, query } = require('express-validator');

const { VEHICLE_TYPES, VISITOR_MAX_LIMIT } = require('../utils/constants');
const { GROUP_ID_PATTERN, DEVICE_NAME_PATTERN } = require('./projectValidator');
const { dateRangeRules } = require('./dateRules');

/**
 * Validation for the visitor-pass endpoints.
 *
 * The one rule worth reading twice is how the window is parsed. A visitor pass
 * is usually hours, not days, so both ends accept a full ISO datetime — but a
 * bare date still has to mean something sensible, and the two ends expand
 * differently: `valid_from=2026-08-14` is 00:00:00.000 of the 14th and
 * `valid_till=2026-08-14` is 23:59:59.999 of it, so sending the same date to
 * both means "all day on the 14th" rather than a zero-length pass.
 *
 * Whether the window is the right way round, and short enough to be a visit at
 * all, is checked in the service — a PATCH can break the ordering by sending one
 * end, and no request-level rule can see the end already stored.
 */

const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{5,19}$/;
const PHONE_MESSAGE =
  'must be 6-20 characters of digits, optionally prefixed with + and separated by spaces or hyphens.';

/**
 * One end of the pass's window.
 *
 * @param {string} field
 * @param {'start'|'end'} edge Which end of the day a bare date expands to.
 * @param {boolean} required
 */
const windowRule = (field, edge, required) => {
  const rule = required
    ? body(field).exists({ checkNull: true }).withMessage(`${field} is required.`).bail()
    : body(field).optional();

  return rule
    .isString()
    .withMessage(`${field} must be a date (YYYY-MM-DD) or an ISO 8601 datetime.`)
    .bail()
    .trim()
    .isISO8601()
    .withMessage(`${field} must be a valid date (e.g. 2026-08-14) or ISO 8601 datetime.`)
    .bail()
    .customSanitizer((value) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return new Date(`${value}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`);
      }

      // Same convention as created_datetime and valid_till on the registry: a
      // timestamp with no offset is UTC.
      const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
      return new Date(hasTimezone ? value : `${value}Z`);
    })
    .custom((value) => {
      if (Number.isNaN(value.getTime())) throw new Error(`${field} is not a parsable date.`);
      return true;
    });
};

const optionalPhoneRule = (field) =>
  body(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a string.`)
    .bail()
    .trim()
    .matches(PHONE_PATTERN)
    .withMessage(`${field} ${PHONE_MESSAGE}`);

const optionalTextRule = (field, max) =>
  body(field)
    .optional({ nullable: true })
    .isString()
    .withMessage(`${field} must be a string.`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${field} must be at most ${max} characters.`)
    .customSanitizer((value) => value || null);

/** The gate selection, identical in meaning to the registry's. */
const deviceSelectionRules = [
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
    .withMessage(
      'each device name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'
    ),

  body('all_devices')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('all_devices must be true or false.')
    .bail()
    .toBoolean(),
];

/**
 * The host, in either of its two forms.
 *
 * `host_vehicle_id` links the resident's or tenant's own registration and copies
 * their details across; `host_name` names a host who has no vehicle on the
 * registry. Neither is required *here* because either one satisfies the rule,
 * and express-validator checks fields one at a time — the service is where "at
 * least one of these" is enforced, and where the id is checked to be a
 * registration in this very project rather than somebody else's.
 */
const hostRules = [
  body('host_vehicle_id')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('host_vehicle_id must be a valid registered-vehicle id.'),

  body('host_name')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('host_name must be a string.')
    .bail()
    .trim()
    .isLength({ max: 150 })
    .withMessage('host_name must be at most 150 characters.'),

  optionalPhoneRule('host_phone'),
  optionalTextRule('host_unit', 50),
];

const createVisitorRules = [
  // Optional on the wire: a customer admin assigned to exactly one project may
  // omit it and have theirs filled in — see requireProjectAccess, which runs
  // after this and is what actually decides the project.
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

  optionalPhoneRule('phone_number'),
  optionalTextRule('vehicle_model', 100),
  optionalTextRule('purpose', 200),

  ...hostRules,

  windowRule('valid_from', 'start', true),
  windowRule('valid_till', 'end', true),

  ...deviceSelectionRules,
];

const visitorIdParamRule = param('id').isMongoId().withMessage('id must be a valid visitor pass id.');

/**
 * PATCH rules. Every field is optional — only what is sent changes — but the
 * service rejects a body that sends nothing at all, so a typo'd field name
 * cannot look like a successful no-op edit.
 *
 * `group_id` and `vehicle_number` are absent on purpose: a different plate is a
 * different visit, which is what POST is for, and editing the project would move
 * a pass into a tenant the caller may not be able to see.
 */
const updateVisitorRules = [
  visitorIdParamRule,

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

  optionalPhoneRule('phone_number'),
  optionalTextRule('vehicle_model', 100),
  optionalTextRule('purpose', 200),

  // `null` is meaningful here — it is how a linked host is unlinked — so this
  // one rule tolerates it rather than treating it as "not sent".
  body('host_vehicle_id')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === '') return true;
      if (!/^[a-f\d]{24}$/i.test(String(value))) {
        throw new Error('host_vehicle_id must be a valid registered-vehicle id, or null to unlink.');
      }
      return true;
    })
    .customSanitizer((value) => (value === '' ? null : value)),

  ...hostRules.slice(1),

  windowRule('valid_from', 'start', false),
  windowRule('valid_till', 'end', false),

  ...deviceSelectionRules,

  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean.')
    .bail()
    .toBoolean(),
];

/** The dedicated revoke/reinstate switch, where is_active is the whole point. */
const setVisitorStatusRules = [
  visitorIdParamRule,

  body('is_active')
    .exists({ checkNull: true })
    .withMessage('is_active is required.')
    .bail()
    .isBoolean()
    .withMessage('is_active must be a boolean.')
    .bail()
    .toBoolean(),
];

const visitorIdParamRules = [visitorIdParamRule];

/** Narrows to one project. Entitlement is buildScopeFilter's call, not this one's. */
const groupIdQueryRule = query('group_id')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('group_id must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .matches(GROUP_ID_PATTERN)
  .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).');

const listVisitorsRules = [
  groupIdQueryRule,

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

  // The manual switch on its own, which `status` cannot express — it folds the
  // window in, so `status=unregistered` cannot answer "what have we revoked?"
  query('is_active')
    .optional({ nullable: true, checkFalsy: false })
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .bail()
    .toBoolean(),

  // The gate desk's question, and the reason it exists next to `status`: the two
  // select the same rows, but "who is on site right now?" is what somebody
  // actually clicks, and a filter named after the question is one nobody has to
  // translate.
  query('on_site')
    .optional({ nullable: true, checkFalsy: false })
    .isBoolean()
    .withMessage('on_site must be true or false.')
    .bail()
    .toBoolean(),

  query('host_vehicle_id')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('host_vehicle_id must be a valid registered-vehicle id.'),

  query('issued_by')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('issued_by must be a valid user id.'),

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

  // A window on the pass's own window: every pass that overlaps this period at
  // all, so a pass running 10:00-18:00 belongs to the afternoon even though it
  // did not start in it.
  ...dateRangeRules('from', 'to'),

  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('page must be an integer >= 1.')
    .toInt(),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: VISITOR_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${VISITOR_MAX_LIMIT}.`)
    .toInt(),
];

const visitorFilterOptionsRules = [groupIdQueryRule];

module.exports = {
  createVisitorRules,
  listVisitorsRules,
  visitorFilterOptionsRules,
  updateVisitorRules,
  setVisitorStatusRules,
  visitorIdParamRules,
};
