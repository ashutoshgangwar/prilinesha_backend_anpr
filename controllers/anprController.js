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
 * Polling feed for the Intozi server (hit every 5-10 seconds).
 *
 * Returns *changes* to vehicle access, not the vehicle list: each row is
 * vehicle_number, group_id, vehicle_type, device_names and event_type. Intozi
 * keeps its own allow-list and applies each row to it, so a quiet minute costs
 * an indexed lookup that matches nothing rather than a walk of the registry.
 *
 * A per-project API key sees only its own project's changes — no `group_id`
 * parameter needed, and none accepted that would widen it. The legacy global key
 * reads across every project and may narrow with `?group_id=`.
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
    // True when the cursor is older than the change log's retention window, so
    // changes may have been pruned before this consumer read them. Additive, and
    // false on every ordinary poll — a client that ignores it behaves exactly as
    // before, but one that honours it re-seeds instead of resuming across a gap
    // that could be hiding a revocation.
    resync_required: feed.resync_required,
    data: feed.records,
    requestId: req.id,
  });
});

module.exports = { createAnprEvent, getVehicleFeed };
