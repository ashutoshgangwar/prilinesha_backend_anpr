const express = require('express');

const projectController = require('../controllers/projectController');
const validate = require('../middleware/validate');
const {
  authenticate,
  authorize,
  requireSuperAdmin,
  requireProjectAccess,
} = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  createProjectRules,
  updateProjectRules,
  listProjectsRules,
  groupIdParamRules,
  listDevicesRules,
  listScopedDevicesRules,
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
 *
 * The exception is the project registry itself — POST, GET and PATCH on
 * projects also carry `requireSuperAdmin`. Who the tenants are is internal
 * information, so it is stated as a role here rather than being reachable by
 * granting a permission. The device routes below are not restricted this way:
 * a customer admin still manages the gates of a project assigned to them.
 */

// Nothing here is reachable without a valid dashboard token.
router.use(authenticate);

/**
 * POST /api/projects
 * Authorization: Bearer <token>   (super admin)
 *
 * Body: { group_id, address, project_type: parking|society, devices?, … }
 *
 * `group_id` is required and is the project's only name. At least one gate is
 * required and at most 50 — listed by name alone, with spaces, as the cameras
 * send them: `[{ "device_name": "Netru Pro Entry" }]`. A gate's `direction` is
 * set afterwards, through the per-device routes.
 *
 * `create_login: true` also issues the customer's dashboard account, using
 * `contact_email` as the username. Send a `password` or let one be generated.
 * An address that already has an account keeps it — the project is added to it
 * rather than a second account being made.
 *
 * Returns the Intozi API key ONCE — and the generated password, if any; both
 * are stored only as hashes and cannot be shown again.
 *
 * 201 created · 400 validation · 401 unauthorized · 403 not a super admin · 409 group_id taken
 */
router.post(
  '/',
  requireSuperAdmin,
  authorize(PERMISSIONS.PROJECT_CREATE),
  validate(createProjectRules),
  projectController.createProject
);

/**
 * GET /api/projects
 * Authorization: Bearer <token>   (super admin)
 *
 * Every project. ?search= &is_active= &page= &limit=
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not a super admin
 */
router.get(
  '/',
  requireSuperAdmin,
  authorize(PERMISSIONS.PROJECT_READ),
  validate(listProjectsRules),
  projectController.listProjects
);

/**
 * GET /api/projects/devices
 * Authorization: Bearer <token>
 *
 * The gates of one project — the list the vehicle-registration form's gate
 * picker binds to. `?group_id=` names the project; a user assigned to exactly
 * one may omit it and get theirs. `?include_inactive=true` also returns gates
 * that are switched off (left out by default — a decommissioned camera should
 * not be offered as a choice).
 *
 * Declared **before** `/:group_id`, or Express would read "devices" as a
 * group_id and hand the request to the super-admin-only project route.
 *
 * 200 ok · 400 more than one project and no group_id · 403 not your project
 */
router.get(
  '/devices',
  authorize(PERMISSIONS.PROJECT_READ),
  validate(listScopedDevicesRules),
  requireProjectAccess,
  projectController.listDevices
);

/**
 * GET /api/projects/:group_id
 * Authorization: Bearer <token>   (super admin)
 *
 * One project with its devices and live counts.
 *
 * 200 ok · 401 unauthorized · 403 not a super admin · 404 unknown project
 */
router.get(
  '/:group_id',
  requireSuperAdmin,
  authorize(PERMISSIONS.PROJECT_READ),
  validate(groupIdParamRules),
  projectController.getProject
);

/**
 * PATCH /api/projects/:group_id
 * Authorization: Bearer <token>   (super admin)
 *
 * `group_id` itself is immutable — it is stamped on every event already
 * ingested and configured on the cameras — and it is the project's name, so
 * there is no name field to change either.
 *
 * 200 ok · 400 validation · 403 not a super admin · 404 unknown project
 */
router.patch(
  '/:group_id',
  requireSuperAdmin,
  authorize(PERMISSIONS.PROJECT_UPDATE),
  validate(updateProjectRules),
  projectController.updateProject
);

/**
 * DELETE /api/projects/:group_id
 * Authorization: Bearer <token>   (super admin)
 *
 * Deactivates the project; it does not remove anything. Every event, vehicle
 * and user assignment is keyed on `group_id` rather than on the project row, so
 * dropping the row would orphan all of it — and a reused `group_id` would then
 * inherit those orphans. Cameras stop posting and the feed closes; the data
 * stays. Reverse it with `PATCH { "is_active": true }`.
 *
 * Idempotent: deleting an already-inactive project is a 200.
 *
 * 200 ok · 401 unauthorized · 403 not a super admin · 404 unknown project
 */
router.delete(
  '/:group_id',
  requireSuperAdmin,
  authorize(PERMISSIONS.PROJECT_DELETE),
  validate(groupIdParamRules),
  projectController.deleteProject
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
 * GET /api/projects/:group_id/devices
 * Authorization: Bearer <token>
 *
 * The same gate list as `GET /api/projects/devices`, with the project named in
 * the path — which is what a dashboard already holding a group_id sends.
 *
 * Returns both the full device objects and a flat `device_names` array, so a
 * picker can bind to the names and post a subset of them straight back as
 * `device_names` on `POST /api/vehicles`.
 *
 * Not super-admin-only, unlike `GET /api/projects/:group_id`: a customer admin
 * registering a vehicle has to be able to see their own gates.
 *
 * 200 ok · 401 unauthorized · 403 not your project · 404 unknown project
 */
router.get(
  '/:group_id/devices',
  authorize(PERMISSIONS.PROJECT_READ),
  validate(listDevicesRules),
  projectController.listDevices
);

/**
 * POST /api/projects/:group_id/devices
 * Authorization: Bearer <token>
 *
 * Adds a gate: { "device_name": "Netru Pro Exit", "direction": "exit" }
 *
 * 201 created · 400 validation · 403 not your project · 409 device exists or
 * the project already holds 50
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
 * The project's last gate cannot be removed.
 *
 * 200 ok · 403 not your project · 404 unknown device · 409 it is the last one
 */
router.delete(
  '/:group_id/devices/:device_name',
  authorize(PERMISSIONS.PROJECT_DEVICE_MANAGE),
  validate(deviceParamRules),
  projectController.removeDevice
);

module.exports = router;
