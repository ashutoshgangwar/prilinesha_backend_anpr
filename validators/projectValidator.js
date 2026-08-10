const { body, param, query } = require('express-validator');

const { passwordRules } = require('./authValidator');

const {
  LIST_MAX_LIMIT,
  PROJECT_TYPES,
  MIN_DEVICES_PER_PROJECT,
  MAX_DEVICES_PER_PROJECT,
} = require('../utils/constants');

/**
 * Validation rules for the project (group_id) endpoints.
 *
 * `group_id` is the value the customer types into their Intozi configuration,
 * so its character set is kept narrow and unambiguous: uppercase letters,
 * digits, underscore and hyphen. No spaces, no case sensitivity to get wrong,
 * nothing that needs URL-encoding when it appears in a query string.
 */

const GROUP_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,49}$/;

// Spaces are allowed because that is how the cameras are actually labelled on
// site — Intozi posts "Netru Pro Entry", not "netru_pro_entry". The name still
// travels in a URL path on the per-device routes, so callers encode it there.
const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,49}$/;
const DEVICE_DIRECTIONS = ['entry', 'exit', 'both'];

// `group_id` is the project's only name: there is no separate project_name to
// derive it from, so the super admin states it outright and it is what the
// dashboard, the cameras and every stored event all refer to.
const requiredGroupIdBodyRule = body('group_id')
  .exists({ checkNull: true })
  .withMessage('group_id is required.')
  .bail()
  .isString()
  .withMessage('group_id must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .matches(GROUP_ID_PATTERN)
  .withMessage(
    'group_id must be 2-50 characters of letters, digits, underscores or hyphens (e.g. NETRU_PRO).'
  );

const projectTypeRule = body('project_type')
  .exists({ checkNull: true })
  .withMessage('project_type is required.')
  .bail()
  .isString()
  .withMessage('project_type must be a string.')
  .bail()
  .trim()
  .toLowerCase()
  .isIn(PROJECT_TYPES)
  .withMessage(`project_type must be one of: ${PROJECT_TYPES.join(', ')}.`);

const addressRule = body('address')
  .exists({ checkNull: true })
  .withMessage('address is required.')
  .bail()
  .isString()
  .withMessage('address must be a string.')
  .bail()
  .trim()
  .isLength({ min: 5, max: 300 })
  .withMessage('address must be between 5 and 300 characters.');

const groupIdParamRule = param('group_id')
  .isString()
  .withMessage('group_id must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .matches(GROUP_ID_PATTERN)
  .withMessage('group_id is not a valid project identifier.');

const deviceNameRule = (location, field = 'device_name') =>
  location(field)
    .exists({ checkNull: true })
    .withMessage('device_name is required.')
    .bail()
    .isString()
    .withMessage('device_name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage(
      'device_name must be 1-50 characters of letters, digits, spaces, dots, underscores or hyphens (e.g. Netru Pro Entry, exit2).'
    );

const optionalText = (field, max, label = field) =>
  body(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${label} must be a string.`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${label} must be at most ${max} characters.`);

const directionRule = body('direction')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('direction must be a string.')
  .bail()
  .trim()
  .toLowerCase()
  .isIn(DEVICE_DIRECTIONS)
  .withMessage(`direction must be one of: ${DEVICE_DIRECTIONS.join(', ')}.`);

const createProjectRules = [
  requiredGroupIdBodyRule,

  addressRule,
  projectTypeRule,

  optionalText('description', 500),
  optionalText('customer_name', 150),
  optionalText('contact_phone', 20),

  body('contact_email')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage('contact_email must be a valid email address.')
    .bail()
    .trim()
    .normalizeEmail({ gmail_remove_dots: false }),

  // At least one gate is required: a project with no devices cannot receive
  // anything, so creating one is always a half-finished setup. On create a gate
  // is only its name — `direction` is not accepted here, and is set later
  // through the per-device routes if a report ever needs it.
  body('devices')
    .exists({ checkNull: true })
    .withMessage('devices is required — a project needs at least one gate.')
    .bail()
    .isArray({ min: MIN_DEVICES_PER_PROJECT, max: MAX_DEVICES_PER_PROJECT })
    .withMessage(
      `devices must be an array of ${MIN_DEVICES_PER_PROJECT} to ${MAX_DEVICES_PER_PROJECT} entries.`
    ),

  body('devices.*.device_name')
    .exists({ checkNull: true })
    .withMessage('each device requires a device_name.')
    .bail()
    .isString()
    .withMessage('device_name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage(
      'device_name must be 1-50 characters of letters, digits, spaces, dots, underscores or hyphens.'
    ),

  body('devices.*.label')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('device label must be a string.')
    .bail()
    .trim()
    .isLength({ max: 150 })
    .withMessage('device label must be at most 150 characters.'),

  // Provision the customer's dashboard login in the same call. `contact_email`
  // becomes their username, so it stops being optional once this is on — checked
  // in the service, which is where the "is that address already an account?"
  // question gets answered too.
  body('create_login')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('create_login must be true or false.')
    .toBoolean(),

  // Optional: omitted, one is generated and returned once. Reuses the single
  // password policy rather than restating it — `.optional()` applies to the
  // whole chain, so the `exists()` inside it is skipped when nothing is sent.
  ...passwordRules('password').map((rule) => rule.optional({ nullable: true, checkFalsy: true })),

  // Rejects a duplicate gate name inside a single request, which the per-device
  // rules above cannot see.
  body('devices').custom((devices) => {
    if (!Array.isArray(devices)) return true;

    const seen = new Set();
    devices.forEach((device) => {
      const name = String(device?.device_name ?? '').trim().toLowerCase();
      if (seen.has(name)) throw new Error(`duplicate device_name "${device.device_name}".`);
      seen.add(name);
    });

    return true;
  }),
];

// `group_id` is absent on purpose: it is the project's identity, stamped on
// every event already ingested and configured on the cameras themselves.
const updateProjectRules = [
  groupIdParamRule,

  optionalText('address', 300),

  body('project_type')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('project_type must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(PROJECT_TYPES)
    .withMessage(`project_type must be one of: ${PROJECT_TYPES.join(', ')}.`),

  optionalText('description', 500),
  optionalText('customer_name', 150),
  optionalText('contact_phone', 20),

  body('contact_email')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage('contact_email must be a valid email address.')
    .bail()
    .trim()
    .normalizeEmail({ gmail_remove_dots: false }),

  body('is_active')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .toBoolean(),
];

const listProjectsRules = [
  query('search')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('search must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters.'),

  query('is_active')
    .optional({ nullable: true, checkFalsy: true })
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .toBoolean(),

  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('page must be an integer >= 1.')
    .toInt(),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: LIST_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${LIST_MAX_LIMIT}.`)
    .toInt(),
];

const groupIdParamRules = [groupIdParamRule];

// Off by default: a decommissioned gate must not be offered as a choice on the
// vehicle-registration form. An admin screen listing what a project has sends
// `include_inactive=true`.
const includeInactiveRule = query('include_inactive')
  .optional({ nullable: true, checkFalsy: true })
  .isBoolean()
  .withMessage('include_inactive must be true or false.')
  .toBoolean();

const listDevicesRules = [groupIdParamRule, includeInactiveRule];

// The same list without the project in the path: `?group_id=` names it, and a
// user assigned to exactly one project may omit it entirely — requireProjectAccess
// fills it in. Optional here for that reason; it is not optional in effect.
const listScopedDevicesRules = [
  query('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('group_id is not a valid project identifier (e.g. ACME_MALL).'),
  includeInactiveRule,
];

const addDeviceRules = [groupIdParamRule, deviceNameRule(body), optionalText('label', 150), directionRule];

const updateDeviceRules = [
  groupIdParamRule,
  deviceNameRule(param),
  optionalText('label', 150),
  directionRule,
  body('is_active')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .toBoolean(),
];

const deviceParamRules = [groupIdParamRule, deviceNameRule(param)];

module.exports = {
  createProjectRules,
  updateProjectRules,
  listProjectsRules,
  groupIdParamRules,
  listDevicesRules,
  listScopedDevicesRules,
  addDeviceRules,
  updateDeviceRules,
  deviceParamRules,
  GROUP_ID_PATTERN,
  DEVICE_NAME_PATTERN,
  DEVICE_DIRECTIONS,
};
