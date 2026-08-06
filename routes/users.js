const express = require('express');

const userController = require('../controllers/userController');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  createUserRules,
  listUsersRules,
  userIdParamRules,
  assignProjectsRules,
  setRoleRules,
  setActiveRules,
  resetPasswordRules,
} = require('../validators/userValidator');

const router = express.Router();

/**
 * Dashboard user administration.
 *
 * Only `super_admin` holds USER_READ / USER_MANAGE / USER_ASSIGN_PROJECT (see
 * ROLE_PERMISSIONS in utils/constants.js), so this whole router is effectively
 * internal — but it is still expressed as permissions, so a future "customer
 * manager" role could be given a subset without touching these routes.
 */

router.use(authenticate);

/**
 * POST /api/users
 * Authorization: Bearer <token>   (super admin)
 *
 * Creates a user with a role and the projects they run. For an `admin`,
 * `group_ids` must name at least one project — that choice is what this endpoint
 * is for, and an admin without one sees nothing. A `super_admin` must omit it,
 * being scoped to every project by role. This is the only way to create another
 * super admin.
 *
 * 201 created · 400 validation · 403 forbidden · 409 email taken
 */
router.post(
  '/',
  authorize(PERMISSIONS.USER_MANAGE),
  validate(createUserRules),
  userController.createUser
);

/**
 * GET /api/users
 * Authorization: Bearer <token>   (super admin)
 *
 * ?search= &role= &group_id= &is_active= &page= &limit=
 * `group_id` answers "who has access to this project?".
 *
 * 200 ok · 400 validation · 403 forbidden
 */
router.get(
  '/',
  authorize(PERMISSIONS.USER_READ),
  validate(listUsersRules),
  userController.listUsers
);

/**
 * GET /api/users/:id
 * Authorization: Bearer <token>   (super admin)
 *
 * 200 ok · 403 forbidden · 404 unknown user
 */
router.get(
  '/:id',
  authorize(PERMISSIONS.USER_READ),
  validate(userIdParamRules),
  userController.getUser
);

/**
 * PUT /api/users/:id/projects
 * Authorization: Bearer <token>   (super admin)
 *
 * The access grant itself: { "group_ids": ["ACME_MALL"], "mode": "replace" }
 * mode is 'replace' (default), 'add' or 'remove'. Takes effect on the user's
 * next request — no re-login needed.
 *
 * 200 ok · 400 unknown group_id · 403 forbidden · 404 unknown user
 */
router.put(
  '/:id/projects',
  authorize(PERMISSIONS.USER_ASSIGN_PROJECT),
  validate(assignProjectsRules),
  userController.assignProjects
);

/**
 * PATCH /api/users/:id/role
 * Authorization: Bearer <token>   (super admin)
 *
 * Signs the user out — a role change is an authorisation change.
 * Refuses to demote the last active super admin.
 *
 * 200 ok · 400 validation / last super admin · 403 forbidden · 404 unknown user
 */
router.patch(
  '/:id/role',
  authorize(PERMISSIONS.USER_MANAGE),
  validate(setRoleRules),
  userController.setRole
);

/**
 * PATCH /api/users/:id/status
 * Authorization: Bearer <token>   (super admin)
 *
 * { "is_active": false } revokes access on the user's next request.
 *
 * 200 ok · 400 validation / last super admin · 403 forbidden · 404 unknown user
 */
router.patch(
  '/:id/status',
  authorize(PERMISSIONS.USER_MANAGE),
  validate(setActiveRules),
  userController.setActive
);

/**
 * POST /api/users/:id/reset-password
 * Authorization: Bearer <token>   (super admin)
 *
 * For the "customer forgot their password" case. Signs them out everywhere.
 *
 * 200 ok · 400 validation · 403 forbidden · 404 unknown user
 */
router.post(
  '/:id/reset-password',
  authorize(PERMISSIONS.USER_MANAGE),
  validate(resetPasswordRules),
  userController.resetPassword
);

module.exports = router;
