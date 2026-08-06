const express = require('express');

const vehicleController = require('../controllers/vehicleController');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireProjectAccess } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const { registerVehicleRules, listVehiclesRules } = require('../validators/vehicleValidator');

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
 * Dashboard table: ?group_id= &search= &status=registered|unregistered &page= &limit=
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

module.exports = router;
