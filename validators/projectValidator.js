const { body, param, query } = require('express-validator');

const { LIST_MAX_LIMIT, PROJECT_TYPES } = require('../utils/constants');

/**
 * Validation rules for the project (group_id) endpoints.
 *
 * `group_id` is the value the customer types into their Intozi configuration,
 * so its character set is kept narrow and unambiguous: uppercase letters,
 * digits, underscore and hyphen. No spaces, no case sensitivity to get wrong,
 * nothing that needs URL-encoding when it appears in a query string.
 */

const GROUP_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,49}$/;
const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const DEVICE_DIRECTIONS = ['entry', 'exit', 'both'];

// On create only: the super admin's form asks for a name, an address and a
// type, so the Intozi identifier is derived from the name when it is left out
// (see deriveGroupId in services/projectService.js). Sending one explicitly
// still wins, for a customer who has already configured their cameras.
const optionalGroupIdBodyRule = body('group_id')
  .optional({ nullable: true, checkFalsy: true })
  .isString()
  .withMessage('group_id must be a string.')
  .bail()
  .trim()
  .toUpperCase()
  .matches(GROUP_ID_PATTERN)
  .withMessage(
    'group_id must be 2-50 characters of letters, digits, underscores or hyphens (e.g. ACME_MALL).'
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
      'device_name must be 1-50 characters of letters, digits, dots, underscores or hyphens (e.g. entry1, exit2).'
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
  optionalGroupIdBodyRule,

  body('project_name')
    .exists({ checkNull: true })
    .withMessage('project_name is required.')
    .bail()
    .isString()
    .withMessage('project_name must be a string.')
    .bail()
    .trim()
    .isLength({ min: 2, max: 150 })
    .withMessage('project_name must be between 2 and 150 characters.'),

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

  // Gates can be listed up front or added later — both are normal.
  body('devices')
    .optional({ nullable: true })
    .isArray({ max: 200 })
    .withMessage('devices must be an array of at most 200 entries.'),

  body('devices.*.device_name')
    .exists({ checkNull: true })
    .withMessage('each device requires a device_name.')
    .bail()
    .isString()
    .withMessage('device_name must be a string.')
    .bail()
    .trim()
    .matches(DEVICE_NAME_PATTERN)
    .withMessage('device_name must be 1-50 characters of letters, digits, dots, underscores or hyphens.'),

  body('devices.*.label')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('device label must be a string.')
    .bail()
    .trim()
    .isLength({ max: 150 })
    .withMessage('device label must be at most 150 characters.'),

  body('devices.*.direction')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .bail()
    .trim()
    .toLowerCase()
    .isIn(DEVICE_DIRECTIONS)
    .withMessage(`device direction must be one of: ${DEVICE_DIRECTIONS.join(', ')}.`),

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

const updateProjectRules = [
  groupIdParamRule,

  body('project_name')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('project_name must be a string.')
    .bail()
    .trim()
    .isLength({ min: 2, max: 150 })
    .withMessage('project_name must be between 2 and 150 characters.'),

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
  addDeviceRules,
  updateDeviceRules,
  deviceParamRules,
  GROUP_ID_PATTERN,
  DEVICE_NAME_PATTERN,
  DEVICE_DIRECTIONS,
};
