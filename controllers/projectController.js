const projectService = require('../services/projectService');
const asyncHandler = require('../utils/asyncHandler');
const { buildScopeFilter, assertProjectAccess } = require('../middleware/auth');

/**
 * Project (group_id) administration.
 *
 * Creating, updating and rotating keys is super-admin work; reading is open to
 * the customer admins assigned to the project, which is what `buildScopeFilter`
 * and `assertProjectAccess` enforce.
 */

/**
 * POST /api/projects
 * Creates a project and issues its Intozi API key.
 */
const createProject = asyncHandler(async (req, res) => {
  const { project, api_key: apiKey, login } = await projectService.createProject(req.body, {
    actor: req.user,
    requestId: req.id,
  });

  // Two different secrets can be in this response, and both are shown once.
  const warning = login?.password
    ? 'Store the api_key and the login password now — both are shown once and cannot be retrieved later.'
    : 'Store this api_key now — it is shown once and cannot be retrieved later.';

  res.status(201).json({
    success: true,
    message: login?.created
      ? 'Project created and a dashboard login was issued for the customer.'
      : 'Project created successfully.',
    // Said plainly, because there is no second chance to read it.
    warning,
    data: {
      project,
      api_key: apiKey,
      // Null when no login was asked for, so the key is always present in the
      // shape and a client can test it rather than probing for its absence.
      login: login ?? null,
      intozi_setup: {
        group_id: project.group_id,
        post_url: '/api',
        feed_url: '/api/feed',
        authorization_header: `Bearer ${apiKey}`,
      },
    },
    requestId: req.id,
  });
});

/**
 * GET /api/projects
 * Lists projects the caller can see.
 */
const listProjects = asyncHandler(async (req, res) => {
  const { search, is_active: isActive, page, limit } = req.query;

  const scopeFilter = buildScopeFilter(req);

  const { records, pagination } = await projectService.listProjects(
    { search, is_active: isActive, page, limit },
    scopeFilter,
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Projects fetched successfully.',
    count: records.length,
    pagination,
    data: records,
    requestId: req.id,
  });
});

/**
 * GET /api/projects/:group_id
 * One project with its devices and live counts.
 */
const getProject = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const project = await projectService.getProject(req.params.group_id);

  res.status(200).json({
    success: true,
    message: 'Project fetched successfully.',
    data: project,
    requestId: req.id,
  });
});

/** PATCH /api/projects/:group_id */
const updateProject = asyncHandler(async (req, res) => {
  // Redundant today — only a super admin holds PROJECT_UPDATE, and they are
  // unscoped — but it keeps the scope check attached to the handler rather than
  // to who currently happens to hold the permission.
  assertProjectAccess(req, req.params.group_id);

  const project = await projectService.updateProject(req.params.group_id, req.body, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Project updated successfully.',
    data: project,
    requestId: req.id,
  });
});

/**
 * DELETE /api/projects/:group_id
 *
 * Deactivates rather than removes — see deactivateProject for why the document
 * has to survive. The response says so plainly, so nobody reads a 200 here as
 * "the customer's data is gone".
 */
const deleteProject = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const { project, was_active: wasActive, retained } = await projectService.deactivateProject(
    req.params.group_id,
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: wasActive
      ? 'Project deactivated. Its cameras can no longer post, its feed is closed, and its admins can no longer sign in.'
      : 'Project was already inactive. Nothing changed.',
    note: 'Nothing was deleted — the events, vehicles and user assignments below are retained. Re-enable with PATCH { "is_active": true }.',
    data: { project, retained },
    requestId: req.id,
  });
});

/**
 * POST /api/projects/:group_id/rotate-key
 * Issues a new API key and invalidates the previous one immediately.
 */
const rotateApiKey = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const { project, api_key: apiKey } = await projectService.rotateApiKey(req.params.group_id, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'API key rotated successfully.',
    warning:
      'The previous key stopped working immediately. Update the cameras for this project now — this key is shown once.',
    data: { project, api_key: apiKey },
    requestId: req.id,
  });
});

/**
 * POST /api/projects/:group_id/devices
 * Adds a gate (entry1, exit2, …) to the project.
 */
const addDevice = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const project = await projectService.addDevice(req.params.group_id, req.body, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(201).json({
    success: true,
    message: 'Device added successfully.',
    data: project,
    requestId: req.id,
  });
});

/** PATCH /api/projects/:group_id/devices/:device_name */
const updateDevice = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const project = await projectService.updateDevice(
    req.params.group_id,
    req.params.device_name,
    req.body,
    { actor: req.user, requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Device updated successfully.',
    data: project,
    requestId: req.id,
  });
});

/** DELETE /api/projects/:group_id/devices/:device_name */
const removeDevice = asyncHandler(async (req, res) => {
  assertProjectAccess(req, req.params.group_id);

  const project = await projectService.removeDevice(req.params.group_id, req.params.device_name, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Device removed successfully. Events already recorded from it are unaffected.',
    data: project,
    requestId: req.id,
  });
});

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  rotateApiKey,
  addDevice,
  updateDevice,
  removeDevice,
};
