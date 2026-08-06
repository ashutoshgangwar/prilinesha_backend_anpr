const userService = require('../services/userService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Dashboard user administration — super-admin only (see routes/users.js).
 *
 * The endpoint that matters is `assignProjects`: it is the moment a signed-up
 * customer admin actually gains access to a project's data.
 */

/**
 * POST /api/users
 * Creates a user with a role and, optionally, project assignments up front.
 */
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body, { actor: req.user, requestId: req.id });

  res.status(201).json({
    success: true,
    message: 'User created successfully.',
    data: user,
    requestId: req.id,
  });
});

/** GET /api/users */
const listUsers = asyncHandler(async (req, res) => {
  const { search, role, group_id: groupId, is_active: isActive, page, limit } = req.query;

  const { records, pagination } = await userService.listUsers(
    { search, role, group_id: groupId, is_active: isActive, page, limit },
    { requestId: req.id }
  );

  res.status(200).json({
    success: true,
    message: 'Users fetched successfully.',
    count: records.length,
    pagination,
    data: records,
    requestId: req.id,
  });
});

/** GET /api/users/:id */
const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUser(req.params.id);

  res.status(200).json({
    success: true,
    message: 'User fetched successfully.',
    data: user,
    requestId: req.id,
  });
});

/**
 * PUT /api/users/:id/projects
 * Sets which projects a user may access — the access grant itself.
 *
 * `mode` is 'replace' (default), 'add' or 'remove'.
 */
const assignProjects = asyncHandler(async (req, res) => {
  const user = await userService.assignProjects(req.params.id, req.body, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Project access updated successfully.',
    data: user,
    requestId: req.id,
  });
});

/** PATCH /api/users/:id/role */
const setRole = asyncHandler(async (req, res) => {
  const user = await userService.setRole(req.params.id, req.body.role, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Role updated. The user must sign in again.',
    data: user,
    requestId: req.id,
  });
});

/** PATCH /api/users/:id/status */
const setActive = asyncHandler(async (req, res) => {
  const user = await userService.setActive(req.params.id, req.body.is_active, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: user.is_active ? 'User activated successfully.' : 'User deactivated successfully.',
    data: user,
    requestId: req.id,
  });
});

/** POST /api/users/:id/reset-password */
const resetPassword = asyncHandler(async (req, res) => {
  const user = await userService.resetPassword(req.params.id, req.body.new_password, {
    actor: req.user,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Password reset. The user has been signed out of all sessions.',
    data: user,
    requestId: req.id,
  });
});

module.exports = {
  createUser,
  listUsers,
  getUser,
  assignProjects,
  setRole,
  setActive,
  resetPassword,
};
