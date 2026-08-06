const vehicleService = require('../services/vehicleService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/vehicles
 * Adds a vehicle to the registry from the internal dashboard, or renews it if
 * the plate is already registered.
 */
const registerVehicle = asyncHandler(async (req, res) => {
  const { vehicle, created } = await vehicleService.registerVehicle(req.body, {
    requestId: req.id,
  });

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
 */
const listVehicles = asyncHandler(async (req, res) => {
  const { search, status, page, limit } = req.query;

  const { records, pagination } = await vehicleService.listVehicles(
    { search, status, page, limit },
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
