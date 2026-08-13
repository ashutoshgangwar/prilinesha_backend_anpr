const visitorService = require('../services/visitorService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter } = require('../middleware/auth');

/**
 * POST /api/visitors
 * Issues a visitor pass: a plate, a host, and the window it is allowed in for.
 *
 * The project is resolved and access-checked by `requireProjectAccess` before
 * this runs, so `req.groupId` is always one the caller is entitled to.
 *
 * Always a 201 — unlike `POST /api/vehicles`, a plate visiting again is a new
 * visit rather than a renewal of the last one.
 */
const createVisitor = asyncHandler(async (req, res) => {
  const visitor = await visitorService.createVisitor(
    { ...req.body, group_id: req.groupId },
    { actor: req.user, requestId: req.id }
  );

  res.status(201).json({
    success: true,
    message: 'Visitor pass issued successfully.',
    data: visitor,
    requestId: req.id,
  });
});

/**
 * GET /api/visitors
 * The visitor table: search, status and host filtering, with page numbers.
 *
 * Results are limited to the caller's projects. `?group_id=` narrows to one of
 * them; omitting it returns every project they can see.
 */
const listVisitors = asyncHandler(async (req, res) => {
  const {
    search,
    status,
    is_active: isActive,
    on_site: onSite,
    host_vehicle_id: hostVehicleId,
    issued_by: issuedBy,
    device_name: deviceName,
    from,
    to,
    page,
    limit,
    group_id: groupId,
  } = req.query;

  const scopeFilter = buildScopeFilter(req, groupId);

  const { records, pagination } = await visitorService.listVisitors(
    {
      search,
      status,
      isActive,
      onSite,
      hostVehicleId,
      issuedBy,
      deviceName,
      from,
      to,
      page,
      limit,
    },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Visitor passes fetched successfully.',
    count: records.length,
    pagination,
    data: records,
    requestId: req.id,
  });
});

/**
 * GET /api/visitors/filters
 * The values the visitor table's filter bar can offer, and the count behind
 * each chip. Scoped exactly like the list it drives.
 */
const getVisitorFilters = asyncHandler(async (req, res) => {
  const scopeFilter = buildScopeFilter(req, req.query.group_id);

  const filters = await visitorService.listVisitorFilters(scopeFilter, { requestId: req.id });

  res.status(200).json({
    success: true,
    message: 'Visitor filters fetched successfully.',
    data: filters,
    requestId: req.id,
  });
});

/**
 * GET /api/visitors/:id
 * One pass, for the detail view. Scoped by folding the caller's projects into
 * the query — a pass in another customer's project is a 404, never a 403.
 */
const getVisitor = asyncHandler(async (req, res) => {
  const visitor = await visitorService.getVisitor(req.params.id, buildScopeFilter(req));

  res.status(200).json({
    success: true,
    message: 'Visitor pass fetched successfully.',
    data: visitor,
    requestId: req.id,
  });
});

/**
 * PATCH /api/visitors/:id
 * Extends the window, corrects the host, or restricts the gates.
 *
 * `group_id` and `vehicle_number` are not editable — a different plate is a
 * different visit.
 */
const updateVisitor = asyncHandler(async (req, res) => {
  const visitor = await visitorService.updateVisitor(
    req.params.id,
    req.body,
    buildScopeFilter(req),
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Visitor pass updated successfully.',
    data: visitor,
    requestId: req.id,
  });
});

/**
 * PATCH /api/visitors/:id/status
 * Revokes a pass, or reinstates one.
 *
 * Separate from the edit endpoint for the same reason the registry's is: it is
 * the one action an operator performs on its own, and it is the half of the
 * status a person controls — the window is the other half, and time owns that.
 */
const setVisitorStatus = asyncHandler(async (req, res) => {
  const visitor = await visitorService.setVisitorStatus(
    req.params.id,
    req.body.is_active,
    buildScopeFilter(req),
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: req.body.is_active
      ? 'Visitor pass reinstated. It is valid again for whatever remains of its window.'
      : 'Visitor pass revoked. The vehicle reads as unregistered at every gate.',
    data: visitor,
    requestId: req.id,
  });
});

/**
 * DELETE /api/visitors/:id
 * Removes the pass entirely.
 *
 * Detections already logged are untouched — they record the status as judged at
 * the time, not a reference to this row.
 */
const deleteVisitor = asyncHandler(async (req, res) => {
  const removed = await visitorService.deleteVisitor(req.params.id, buildScopeFilter(req), {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Visitor pass deleted.',
    data: removed,
    requestId: req.id,
  });
});

module.exports = {
  createVisitor,
  listVisitors,
  getVisitorFilters,
  getVisitor,
  updateVisitor,
  setVisitorStatus,
  deleteVisitor,
};
