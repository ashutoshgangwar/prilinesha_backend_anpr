const logService = require('../services/logService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter } = require('../middleware/auth');

/**
 * GET /api/logs
 * The detection-log table for the internal dashboard.
 *
 * Results are limited to the caller's projects. `?group_id=` narrows to one of
 * them; omitting it returns every project they can see — which for a super
 * admin is all of them, and for a customer admin is only their own sites.
 */
const listVehicleLogs = asyncHandler(async (req, res) => {
  const {
    search,
    vehicle_type: vehicleType,
    device_name: deviceName,
    from,
    to,
    page,
    limit,
    group_id: groupId,
  } = req.query;

  // Throws 403 when group_id is outside the caller's scope, so the service is
  // never handed a filter the user is not entitled to.
  const scopeFilter = buildScopeFilter(req, groupId);

  const { records, pagination } = await logService.listVehicleLogs(
    { search, vehicleType, deviceName, from, to, page, limit },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Vehicle logs fetched successfully.',
    count: records.length,
    pagination,
    data: records,
    requestId: req.id,
  });
});

module.exports = { listVehicleLogs };
