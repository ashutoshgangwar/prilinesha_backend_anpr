const { body, param, query } = require('express-validator');

const { ROLES, ROLE_VALUES, DEFAULT_ROLE, LIST_MAX_LIMIT } = require('../utils/constants');
const { emailRule, nameRule, phoneRule, passwordRules } = require('./authValidator');
const { GROUP_ID_PATTERN } = require('./projectValidator');

/** Validation rules for the super-admin user-management endpoints. */

const ASSIGN_MODES = ['replace', 'add', 'remove'];

const userIdParamRule = param('id')
  .isMongoId()
  .withMessage('id must be a valid user id.');

const roleRule = (optional = true) => {
  const chain = body('role');
  const base = optional ? chain.optional({ nullable: true, checkFalsy: true }) : chain
    .exists({ checkNull: true })
    .withMessage('role is required.')
    .bail();

  return base
    .isString()
    .withMessage('role must be a string.')
    .bail()
    .trim()
    .toLowerCase()
    .isIn(ROLE_VALUES)
    .withMessage(`role must be one of: ${ROLE_VALUES.join(', ')}.`);
};

const groupIdsRule = [
  body('group_ids')
    .exists({ checkNull: true })
    .withMessage('group_ids is required.')
    .bail()
    .isArray({ max: 200 })
    .withMessage('group_ids must be an array of at most 200 project identifiers.'),

  body('group_ids.*')
    .isString()
    .withMessage('each group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('each group_id must be a valid project identifier (e.g. ACME_MALL).'),
];

const createUserRules = [
  nameRule(),
  emailRule(),
  phoneRule(),
  ...passwordRules('password'),
  roleRule(true),

  body('group_ids')
    .optional({ nullable: true })
    .isArray({ max: 200 })
    .withMessage('group_ids must be an array of at most 200 project identifiers.'),

  body('group_ids.*')
    .isString()
    .withMessage('each group_id must be a string.')
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('each group_id must be a valid project identifier (e.g. ACME_MALL).'),

  // Creating a customer admin is the moment the super admin picks which project
  // that admin runs, so the choice is demanded here rather than left to a second
  // call. Without it the account would exist but see nothing — an empty project
  // list matches no data — which reads as a broken dashboard, not as a pending
  // step. A super admin is scoped to every project by role, so naming one is
  // rejected instead of silently dropped.
  body('group_ids').custom((groupIds, { req }) => {
    const role = String(req.body.role ?? DEFAULT_ROLE).trim().toLowerCase();
    const count = Array.isArray(groupIds) ? groupIds.length : 0;

    if (role === ROLES.SUPER_ADMIN) {
      if (count) {
        throw new Error('a super_admin already has access to every project; omit group_ids.');
      }
      return true;
    }

    if (!count) {
      throw new Error('group_ids must name at least one project for an admin.');
    }

    return true;
  }),
];

const listUsersRules = [
  query('search')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('search must be a string.')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters.'),

  query('role')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .bail()
    .trim()
    .toLowerCase()
    .isIn(ROLE_VALUES)
    .withMessage(`role must be one of: ${ROLE_VALUES.join(', ')}.`),

  query('group_id')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .bail()
    .trim()
    .toUpperCase()
    .matches(GROUP_ID_PATTERN)
    .withMessage('group_id is not a valid project identifier.'),

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

const userIdParamRules = [userIdParamRule];

const assignProjectsRules = [
  userIdParamRule,
  ...groupIdsRule,

  body('mode')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .bail()
    .trim()
    .toLowerCase()
    .isIn(ASSIGN_MODES)
    .withMessage(`mode must be one of: ${ASSIGN_MODES.join(', ')}.`),
];

const setRoleRules = [userIdParamRule, roleRule(false)];

const setActiveRules = [
  userIdParamRule,
  body('is_active')
    .exists({ checkNull: true })
    .withMessage('is_active is required.')
    .bail()
    .isBoolean()
    .withMessage('is_active must be true or false.')
    .toBoolean(),
];

const resetPasswordRules = [userIdParamRule, ...passwordRules('new_password')];

module.exports = {
  createUserRules,
  listUsersRules,
  userIdParamRules,
  assignProjectsRules,
  setRoleRules,
  setActiveRules,
  resetPasswordRules,
  ASSIGN_MODES,
};
