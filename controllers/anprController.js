const anprService = require('../services/anprService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter } = require('../middleware/auth');

/**
 * POST /api/anpr
 * Ingests one ANPR detection event. Kept deliberately thin: adapt HTTP in,
 * delegate to the service, adapt HTTP out.
 *
 * `req.project` is set by the API-key middleware when the caller used a
 * per-project key; the service binds the event to that project regardless of
 * what the body claims.
 */
const createAnprEvent = asyncHandler(async (req, res) => {
  const result = await anprService.createAnprEvent(req.body, {
    project: req.project,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'ANPR event stored successfully.',
    data: result,
    requestId: req.id,
  });
});

/**
 * GET /api/feed
 * Polling feed for the Intozi server (hit every 5-10 seconds). Reads the
 * registered-vehicle registry and returns exactly vehicle_number, group_id and
 * vehicle_type (registered/unregistered) per row.
 *
 * A per-project API key sees only its own project's registrations — no
 * `group_id` parameter needed, and none accepted that would widen it. The legacy
 * global key reads across every project and may narrow with `?group_id=`.
 */
const getVehicleFeed = asyncHandler(async (req, res) => {
  const { cursor, since, limit, vehicle_type: vehicleType, group_id: groupId } = req.query;

  const scopeFilter = buildScopeFilter(req, groupId);

  const feed = await anprService.getVehicleFeed(
    { cursor, since, limit, vehicleType },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Vehicle feed fetched successfully.',
    count: feed.count,
    group_id: req.groupId ?? groupId ?? null,
    next_cursor: feed.next_cursor,
    has_more: feed.has_more,
    data: feed.records,
    requestId: req.id,
  });
});

module.exports = { createAnprEvent, getVehicleFeed };
