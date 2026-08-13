const express = require('express');

const analyticsController = require('../controllers/analyticsController');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  analyticsSummaryRules,
  trafficSeriesRules,
  analyticsFilterOptionsRules,
} = require('../validators/analyticsValidator');

const router = express.Router();

/**
 * Reporting for the internal dashboard — the number tiles and the traffic chart.
 *
 * Dashboard-only, like the detection log: a JWT is the only credential accepted,
 * so a camera or Intozi API key cannot read these. Nothing here writes anything;
 * the ingestion path and the Intozi feed are untouched by it.
 *
 * All three endpoints take the same filters, so a filter bar built from
 * `/filters` can drive `/summary` and `/traffic` with one set of query
 * parameters.
 */

router.use(authenticate);

/**
 * GET /api/analytics/summary
 * Authorization: Bearer <token>
 *
 * Query: ?group_id= &from=YYYY-MM-DD &to=YYYY-MM-DD &timezone=Asia/Kolkata
 *        &direction=entry|exit &device_name= &vehicle_type=registered|unregistered
 *        &vehicle_number=
 *
 * The tiles: `registered_vehicles` is a standing count of the register — total,
 * and what those rows currently mean — and is **not** affected by from/to.
 * `traffic` is entries/exits inside the window; `today` is the same for the local
 * day in progress.
 *
 * Needs both permissions because it reads the registry and the events.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/summary',
  authorize(PERMISSIONS.EVENT_READ, PERMISSIONS.VEHICLE_READ),
  validate(analyticsSummaryRules),
  analyticsController.getSummary
);

/**
 * GET /api/analytics/traffic
 * Authorization: Bearer <token>
 *
 * Query: everything /summary takes, plus &granularity=hour|day|week|month
 *        (default day).
 *
 * One point per bucket, in order and zero-filled, so a chart can plot `bucket`
 * against `entries` and `exits` without filling gaps client-side. Windows wider
 * than the bucket ceiling are a 400 that says to coarsen the granularity.
 *
 * 200 ok · 400 validation / window too wide · 401 unauthorized · 403 not your project
 */
router.get(
  '/traffic',
  authorize(PERMISSIONS.EVENT_READ),
  validate(trafficSeriesRules),
  analyticsController.getTrafficSeries
);

/**
 * GET /api/analytics/filters
 * Authorization: Bearer <token>
 *
 * Query: ?group_id= &timezone=
 *
 * What the filter bar can offer: the caller's projects and gates, each gate's
 * direction and where that direction came from, the granularities, and the
 * ready-made `quick_ranges` behind the date chips. Fetch it once when the screen
 * opens, then send the chosen values back to the two reports above.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/filters',
  authorize(PERMISSIONS.EVENT_READ),
  validate(analyticsFilterOptionsRules),
  analyticsController.getAnalyticsFilters
);

module.exports = router;
