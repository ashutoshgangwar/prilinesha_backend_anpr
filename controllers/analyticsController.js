const analyticsService = require('../services/analyticsService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter } = require('../middleware/auth');

/**
 * Reporting for the internal dashboard: registry totals, and entries/exits over
 * time. Read-only, and scoped exactly like `GET /api/logs` — `?group_id=`
 * narrows to one project, omitting it covers every project the caller can see.
 */

/** Maps the validated query into the shape the service takes. */
const reportParams = (req) => ({
  from: req.query.from,
  to: req.query.to,
  timezone: req.query.timezone,
  granularity: req.query.granularity,
  direction: req.query.direction,
  deviceName: req.query.device_name,
  vehicleType: req.query.vehicle_type,
  vehicleNumber: req.query.vehicle_number,
});

/**
 * GET /api/analytics/summary
 * The number tiles: how many vehicles are registered against the project (a
 * standing count, not a daily one), and how many came in and went out.
 */
const getSummary = asyncHandler(async (req, res) => {
  // Throws 403 when group_id is outside the caller's scope, so the service is
  // never handed a filter the user is not entitled to.
  const scopeFilter = buildScopeFilter(req, req.query.group_id);

  const data = await analyticsService.getSummary(reportParams(req), scopeFilter, {
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Analytics summary fetched successfully.',
    data,
    requestId: req.id,
  });
});

/**
 * GET /api/analytics/traffic
 * The chart behind the tiles: entries and exits per hour, day, week or month,
 * with every bucket in the window present even when it is empty.
 */
const getTrafficSeries = asyncHandler(async (req, res) => {
  const scopeFilter = buildScopeFilter(req, req.query.group_id);

  const data = await analyticsService.getTrafficSeries(reportParams(req), scopeFilter, {
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Traffic series fetched successfully.',
    count: data.series.length,
    data,
    requestId: req.id,
  });
});

/**
 * GET /api/analytics/filters
 * What the filter bar above the reports can offer, plus the ready-made date
 * ranges behind the "Today / Last 7 days / This month" chips.
 */
const getAnalyticsFilters = asyncHandler(async (req, res) => {
  const scopeFilter = buildScopeFilter(req, req.query.group_id);

  const data = await analyticsService.getAnalyticsFilters(
    { timezone: req.query.timezone },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Analytics filters fetched successfully.',
    data,
    requestId: req.id,
  });
});

module.exports = { getSummary, getTrafficSeries, getAnalyticsFilters };
