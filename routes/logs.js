const express = require('express');

const logController = require('../controllers/logController');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const { listVehicleLogsRules, logFilterOptionsRules } = require('../validators/logValidator');

const router = express.Router();

/**
 * The detection log, for the Prilinesha internal dashboard.
 *
 * Dashboard-only by construction: a dashboard JWT is the only credential
 * accepted, so a camera or Intozi API key cannot read it. That separation is
 * the point — the Intozi feed reads the *registry* and discloses three fields,
 * while this reads the events themselves and names the owner.
 */

router.use(authenticate);

/**
 * GET /api/logs
 * Authorization: Bearer <token>
 *
 * Query: ?group_id= &search= &vehicle_number= &vehicle_type=registered|unregistered
 *        &device_name= &from=YYYY-MM-DD &to=YYYY-MM-DD &page= &limit=
 *
 * Scoped to the caller: a super admin reads every project, a customer admin
 * only the ones assigned to them, and an unassigned account sees nothing at all
 * rather than everything. Omit `group_id` for all of the caller's projects.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/',
  authorize(PERMISSIONS.EVENT_READ),
  validate(listVehicleLogsRules),
  logController.listVehicleLogs
);

/**
 * GET /api/logs/filters
 * Authorization: Bearer <token>
 *
 * Query: ?group_id=
 *
 * What the filter bar above the table can offer: the caller's projects, their
 * gates, the vehicle types, and the span the detections actually cover. Fetch it
 * once when the screen opens, then send the chosen values back to `GET /api/logs`.
 *
 * Same scope as the table, so a dropdown can never offer a project the caller
 * would get a 403 for.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/filters',
  authorize(PERMISSIONS.EVENT_READ),
  validate(logFilterOptionsRules),
  logController.getVehicleLogFilters
);

module.exports = router;
