const anprService = require('../services/anprService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/anpr
 * Ingests one ANPR detection event. Kept deliberately thin: adapt HTTP in,
 * delegate to the service, adapt HTTP out.
 */
const createAnprEvent = asyncHandler(async (req, res) => {
  const result = await anprService.createAnprEvent(req.body, { requestId: req.id });

  res.status(200).json({
    success: true,
    message: 'ANPR event stored successfully.',
    data: result,
    requestId: req.id,
  });
});

/**
 * GET /api/anpr/feed
 * Polling feed for the Intozi server (hit every 5-10 seconds). Returns the
 * vehicle number and its registered/unregistered status; all other fields are
 * reported as null by contract.
 */
const getVehicleFeed = asyncHandler(async (req, res) => {
  const { cursor, since, limit, vehicle_type: vehicleType } = req.query;

  const feed = await anprService.getVehicleFeed(
    { cursor, since, limit, vehicleType },
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Vehicle feed fetched successfully.',
    count: feed.count,
    next_cursor: feed.next_cursor,
    has_more: feed.has_more,
    data: feed.records,
    requestId: req.id,
  });
});

module.exports = { createAnprEvent, getVehicleFeed };
