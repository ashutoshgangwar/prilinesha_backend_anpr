const express = require('express');

const projectController = require('../controllers/projectController');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  createProjectRules,
  updateProjectRules,
  listProjectsRules,
  groupIdParamRules,
  addDeviceRules,
  updateDeviceRules,
  deviceParamRules,
} = require('../validators/projectValidator');

const router = express.Router();

/**
 * Projects — the `group_id` a customer configures in Intozi, and the gates
 * (device_name) that belong to it.
 *
 * Every route names a permission rather than a role, so widening what a
 * customer admin may do later is a change to ROLE_PERMISSIONS in
 * utils/constants.js, not to this file.
 */

// Nothing here is reachable without a valid dashboard token.
router.use(authenticate);

/**
 * POST /api/projects
 * Authorization: Bearer <token>   (super admin)
 *
 * Body: { project_name, address, project_type: parking|society, … }
 *
 * `group_id` is optional — omitted, it is derived from `project_name`. Returns
 * the Intozi API key ONCE; it is stored only as a hash and cannot be shown again.
 *
 * 201 created · 400 validation · 401 unauthorized · 403 forbidden · 409 group_id taken
 */
router.post(
  '/',
  authorize(PERMISSIONS.PROJECT_CREATE),
  validate(createProjectRules),
  projectController.createProject
);

/**
 * GET /api/projects
 * Authorization: Bearer <token>
 *
 * Super admin: every project. Customer admin: only their assigned ones.
 * ?search= &is_active= &page= &limit=
 *
 * 200 ok · 400 validation · 401 unauthorized
 */
router.get(
  '/',
  authorize(PERMISSIONS.PROJECT_READ),
  validate(listProjectsRules),
  projectController.listProjects
);

/**
 * GET /api/projects/:group_id
 * Authorization: Bearer <token>
 *
 * 200 ok · 401 unauthorized · 403 not your project · 404 unknown project
 */
router.get(
  '/:group_id',
  authorize(PERMISSIONS.PROJECT_READ),
  validate(groupIdParamRules),
  projectController.getProject
);

/**
 * PATCH /api/projects/:group_id
 * Authorization: Bearer <token>   (super admin)
 *
 * `group_id` itself is immutable — it is stamped on every event already
 * ingested and configured on the cameras.
 *
 * 200 ok · 400 validation · 403 forbidden · 404 unknown project
 */
router.patch(
  '/:group_id',
  authorize(PERMISSIONS.PROJECT_UPDATE),
  validate(updateProjectRules),
  projectController.updateProject
);

/**
 * POST /api/projects/:group_id/rotate-key
 * Authorization: Bearer <token>   (super admin)
 *
 * Cameras on the old key start failing immediately.
 *
 * 200 ok · 403 forbidden · 404 unknown project
 */
router.post(
  '/:group_id/rotate-key',
  authorize(PERMISSIONS.PROJECT_ROTATE_KEY),
  validate(groupIdParamRules),
  projectController.rotateApiKey
);

/**
 * POST /api/projects/:group_id/devices
 * Authorization: Bearer <token>
 *
 * Adds a gate: { "device_name": "entry1", "direction": "entry" }
 *
 * 201 created · 400 validation · 403 not your project · 409 device exists
 */
router.post(
  '/:group_id/devices',
  authorize(PERMISSIONS.PROJECT_DEVICE_MANAGE),
  validate(addDeviceRules),
  projectController.addDevice
);

/**
 * PATCH /api/projects/:group_id/devices/:device_name
 * Authorization: Bearer <token>
 *
 * 200 ok · 400 validation · 403 not your project · 404 unknown device
 */
router.patch(
  '/:group_id/devices/:device_name',
  authorize(PERMISSIONS.PROJECT_DEVICE_MANAGE),
  validate(updateDeviceRules),
  projectController.updateDevice
);

/**
 * DELETE /api/projects/:group_id/devices/:device_name
 * Authorization: Bearer <token>
 *
 * 200 ok · 403 not your project · 404 unknown device
 */
router.delete(
  '/:group_id/devices/:device_name',
  authorize(PERMISSIONS.PROJECT_DEVICE_MANAGE),
  validate(deviceParamRules),
  projectController.removeDevice
);

module.exports = router;
