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
  const {
    search,
    status,
    is_active: isActive,
    registered_by: registeredBy,
    device_name: deviceName,
    valid_from: validFrom,
    valid_to: validTo,
    expiring_in_days: expiringInDays,
    page,
    limit,
    group_id: groupId,
  } = req.query;

  const scopeFilter = buildScopeFilter(req, groupId);

  const { records, pagination } = await vehicleService.listVehicles(
    {
      search,
      status,
      isActive,
      registeredBy,
      deviceName,
      validFrom,
      validTo,
      expiringInDays,
      page,
      limit,
    },
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

/**
 * GET /api/vehicles/filters
 * The values the registry's filter bar can offer — projects, gates, statuses,
 * the operators who have registered something, and the count behind each chip.
 *
 * Scoped exactly like `GET /api/vehicles`, so a dropdown can never offer a
 * project the caller would then get a 403 for.
 */
const getVehicleFilters = asyncHandler(async (req, res) => {
  const scopeFilter = buildScopeFilter(req, req.query.group_id);

  const filters = await vehicleService.listVehicleFilters(scopeFilter, { requestId: req.id });

  res.status(200).json({
    success: true,
    message: 'Vehicle filters fetched successfully.',
    data: filters,
    requestId: req.id,
  });
});

/**
 * GET /api/vehicles/:id
 * One registration, for the dashboard's detail view.
 *
 * Scoped by the same filter as the list, folded into the query — a vehicle in
 * another customer's project is a 404, never a 403.
 */
const getVehicle = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.getVehicle(req.params.id, buildScopeFilter(req));

  res.status(200).json({
    success: true,
    message: 'Vehicle fetched successfully.',
    data: vehicle,
    requestId: req.id,
  });
});

/**
 * PATCH /api/vehicles/:id
 * Edits the holder, their phone, the expiry or the gate list.
 *
 * `group_id` and `vehicle_number` are not editable — they are the row's
 * identity, and changing them is registering a different vehicle.
 */
const updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.updateVehicle(
    req.params.id,
    req.body,
    buildScopeFilter(req),
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Vehicle updated successfully.',
    data: vehicle,
    requestId: req.id,
  });
});

/**
 * PATCH /api/vehicles/:id/status
 * Marks the vehicle registered (active) or unregistered (inactive).
 *
 * Separate from the edit endpoint because it is the one action an operator
 * performs on its own, and it is the half of the status a person controls —
 * expiry is the other half, and time owns that.
 */
const setVehicleStatus = asyncHandler(async (req, res) => {
  const vehicle = await vehicleService.setVehicleStatus(
    req.params.id,
    req.body.is_active,
    buildScopeFilter(req),
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: req.body.is_active
      ? 'Vehicle activated. It is registered again from the next detection.'
      : 'Vehicle deactivated. It reads as unregistered at every gate until reactivated.',
    data: vehicle,
    requestId: req.id,
  });
});

/**
 * DELETE /api/vehicles/:id
 * Removes the registration entirely.
 *
 * Detections already logged are untouched — they record the status as judged at
 * the time, not a reference to this row.
 */
const deleteVehicle = asyncHandler(async (req, res) => {
  const removed = await vehicleService.deleteVehicle(req.params.id, buildScopeFilter(req), {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Vehicle registration deleted.',
    data: removed,
    requestId: req.id,
  });
});

module.exports = {
  registerVehicle,
  listVehicles,
  getVehicleFilters,
  getVehicle,
  updateVehicle,
  setVehicleStatus,
  deleteVehicle,
};
