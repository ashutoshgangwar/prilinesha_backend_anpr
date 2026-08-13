const express = require('express');

const vehicleController = require('../controllers/vehicleController');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireProjectAccess } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  registerVehicleRules,
  listVehiclesRules,
  vehicleFilterOptionsRules,
  updateVehicleRules,
  setVehicleStatusRules,
  vehicleIdParamRules,
} = require('../validators/vehicleValidator');

const router = express.Router();

/**
 * Registered-vehicle registry, driven by the dashboard.
 *
 * What is stored here decides what `GET /api/anpr/feed` reports to Intozi: a
 * plate registered under the detecting project and still inside its `valid_till`
 * window is reported as "registered", everything else as "unregistered".
 *
 * These endpoints moved from the shared API key to a dashboard token, because
 * "which vehicles may I see?" is now a per-user question. Cameras never call
 * them — they only POST events and poll the feed.
 */

router.use(authenticate);

/**
 * POST /api/vehicles
 * Authorization: Bearer <token>
 *
 * Adds a vehicle (201) or renews an already-registered plate (200), within one
 * project. `group_id` may be omitted by a user assigned to exactly one project.
 *
 * 200 renewed · 201 created · 400 validation · 401 unauthorized · 403 not your project
 */
router.post(
  '/',
  authorize(PERMISSIONS.VEHICLE_WRITE),
  validate(registerVehicleRules),
  // After validation, so it works on the normalised group_id — and before the
  // controller, so no handler ever runs on an unauthorised project.
  requireProjectAccess,
  vehicleController.registerVehicle
);

/**
 * GET /api/vehicles
 * Authorization: Bearer <token>
 *
 * Dashboard table: ?group_id= &search= &status=registered|unregistered &is_active=
 *                  &registered_by= &device_name= &valid_from= &valid_to=
 *                  &expiring_in_days= &page= &limit=
 * Without `group_id`, returns every project the caller can see.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/',
  authorize(PERMISSIONS.VEHICLE_READ),
  validate(listVehiclesRules),
  vehicleController.listVehicles
);

/**
 * GET /api/vehicles/filters
 * Authorization: Bearer <token>
 *
 * Query: ?group_id=
 *
 * What the filter bar above the registry can offer: the caller's projects and
 * gates, the statuses, the operators who have actually registered something, and
 * the row count behind each chip. Fetch it once when the screen opens, then send
 * the chosen values back to `GET /api/vehicles`.
 *
 * Registered before `/:id` deliberately — that route validates a Mongo id, so a
 * filters request arriving after it would be a 400 about a malformed id rather
 * than this endpoint.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/filters',
  authorize(PERMISSIONS.VEHICLE_READ),
  validate(vehicleFilterOptionsRules),
  vehicleController.getVehicleFilters
);

/**
 * The single-record routes below scope by folding the caller's projects into
 * the query, so a vehicle in another customer's project is a **404**, not a
 * 403. An object id is opaque and guessable in bulk; answering "that exists,
 * but it is not yours" would confirm which ids are real, and for whom.
 *
 * `requireProjectAccess` is deliberately absent here — it resolves a project
 * from the *body*, which is right when creating a vehicle and wrong when acting
 * on one that already names its own project.
 */

/**
 * GET /api/vehicles/:id
 * Authorization: Bearer <token>
 *
 * 200 ok · 400 bad id · 401 unauthorized · 404 no such vehicle in your projects
 */
router.get(
  '/:id',
  authorize(PERMISSIONS.VEHICLE_READ),
  validate(vehicleIdParamRules),
  vehicleController.getVehicle
);

/**
 * PATCH /api/vehicles/:id
 * Authorization: Bearer <token>
 *
 * Edits name, phone_number, valid_till, device_names or is_active. Only the
 * fields sent change. `group_id` and `vehicle_number` are immutable — together
 * they are the row's identity; registering a different vehicle is a POST.
 *
 * 200 ok · 400 validation / empty body · 401 unauthorized · 404 not in your projects
 */
router.patch(
  '/:id',
  authorize(PERMISSIONS.VEHICLE_WRITE),
  validate(updateVehicleRules),
  vehicleController.updateVehicle
);

/**
 * PATCH /api/vehicles/:id/status
 * Authorization: Bearer <token>
 *
 * `{ "is_active": false }` marks the vehicle unregistered at every gate
 * immediately, whatever its valid_till says; `true` restores it. Live on
 * Intozi's next poll — the feed derives status from the same fields.
 *
 * 200 ok · 400 validation · 401 unauthorized · 404 not in your projects
 */
router.patch(
  '/:id/status',
  authorize(PERMISSIONS.VEHICLE_WRITE),
  validate(setVehicleStatusRules),
  vehicleController.setVehicleStatus
);

/**
 * DELETE /api/vehicles/:id
 * Authorization: Bearer <token>
 *
 * Prefer deactivating: deleting loses who registered it and when, and makes the
 * plate indistinguishable from one never registered. Detections already logged
 * are untouched.
 *
 * 200 ok · 400 bad id · 401 unauthorized · 404 not in your projects
 */
router.delete(
  '/:id',
  authorize(PERMISSIONS.VEHICLE_WRITE),
  validate(vehicleIdParamRules),
  vehicleController.deleteVehicle
);

module.exports = router;
