const vehicleService = require('../services/vehicleService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter } = require('../middleware/auth');

/**
 * POST /api/vehicles
 * Adds a vehicle to a project's registry from the dashboard, or renews it if
 * the plate is already registered there.
 *
 * The project is resolved and access-checked by `requireProjectAccess` before
 * this runs, so `req.groupId` is always one the caller is entitled to.
 */
const registerVehicle = asyncHandler(async (req, res) => {
  const { vehicle, created } = await vehicleService.registerVehicle(
    { ...req.body, group_id: req.groupId },
    { actor: req.user, requestId: req.id }
  );

  res.status(created ? 201 : 200).json({
    success: true,
    message: created
      ? 'Vehicle registered successfully.'
      : 'Vehicle registration updated successfully.',
    created,
    data: vehicle,
    requestId: req.id,
  });
});

/**
 * GET /api/vehicles
 * Registry table for the dashboard: search, status filter and page numbers.
 *
 * Results are limited to the caller's projects. `?group_id=` narrows to one of
 * them; omitting it returns every project they can see.
 */
const listVehicles = asyncHandler(async (req, res) => {
  const { search, status, page, limit, group_id: groupId } = req.query;

  const scopeFilter = buildScopeFilter(req, groupId);

  const { records, pagination } = await vehicleService.listVehicles(
    { search, status, page, limit },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Vehicles fetched successfully.',
    count: records.length,
    pagination,
    data: records,
    requestId: req.id,
  });
});

module.exports = { registerVehicle, listVehicles };
