const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/auth/signup
 * Registers a dashboard user.
 *
 * The account is created as a customer `admin` with no projects: they can log
 * in immediately, but they see no data until a super admin assigns them a
 * group_id. That is deliberate — signing up is not self-granted access.
 */
const signup = asyncHandler(async (req, res) => {
  const { user, token, expires_in } = await authService.signup(req.body, { requestId: req.id });

  res.status(201).json({
    success: true,
    message:
      'Account created. An administrator must assign you to a project before you can see its data.',
    data: { user, token, token_type: 'Bearer', expires_in },
    requestId: req.id,
  });
});

/**
 * POST /api/auth/login
 * Exchanges email + password for an access token.
 */
const login = asyncHandler(async (req, res) => {
  const { user, token, expires_in } = await authService.login(req.body, { requestId: req.id });

  res.status(200).json({
    success: true,
    message: 'Logged in successfully.',
    data: { user, token, token_type: 'Bearer', expires_in },
    requestId: req.id,
  });
});

/**
 * GET /api/auth/me
 * The current user, their role, permissions and assigned projects — what the
 * dashboard calls on load to rebuild its session.
 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user);

  res.status(200).json({
    success: true,
    message: 'Profile fetched successfully.',
    data: user,
    requestId: req.id,
  });
});

/**
 * POST /api/auth/change-password
 * Changes the caller's own password and issues a replacement token, retiring
 * every token issued before now.
 */
const changePassword = asyncHandler(async (req, res) => {
  const { token, expires_in } = await authService.changePassword(req.user, req.body, {
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'Password changed. Other sessions have been signed out.',
    data: { token, token_type: 'Bearer', expires_in },
    requestId: req.id,
  });
});

module.exports = { signup, login, getProfile, changePassword };
