const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * The request details recorded against a refresh session, so a later "your
 * active sessions" screen — or an investigation after a reuse alert — can say
 * which device a token belongs to.
 */
const sessionContext = (req) => ({
  requestId: req.id,
  userAgent: req.get('user-agent') ?? null,
  ip: req.ip ?? null,
});

/**
 * POST /api/auth/signup
 * Registers a dashboard user.
 *
 * The account is created as a customer `admin` with no projects: they can log
 * in immediately, but they see no data until a super admin assigns them a
 * group_id. That is deliberate — signing up is not self-granted access.
 */
const signup = asyncHandler(async (req, res) => {
  const { user, ...tokens } = await authService.signup(req.body, sessionContext(req));

  res.status(201).json({
    success: true,
    message:
      'Account created. An administrator must assign you to a project before you can see its data.',
    data: { user, ...tokens },
    requestId: req.id,
  });
});

/**
 * POST /api/auth/login
 * Exchanges email + password for an access token and a refresh token.
 */
const login = asyncHandler(async (req, res) => {
  const { user, ...tokens } = await authService.login(req.body, sessionContext(req));

  res.status(200).json({
    success: true,
    message: 'Logged in successfully.',
    data: { user, ...tokens },
    requestId: req.id,
  });
});

/**
 * POST /api/auth/refresh
 * Exchanges a refresh token for a new pair.
 *
 * The user is returned alongside the tokens so a dashboard resuming a session
 * after a reload does not need a second call to /api/auth/me — the role,
 * permissions and project list may all have changed while it was closed.
 */
const refresh = asyncHandler(async (req, res) => {
  const { user, ...tokens } = await authService.refresh(req.body, sessionContext(req));

  res.status(200).json({
    success: true,
    message: 'Token refreshed successfully.',
    data: { user, ...tokens },
    requestId: req.id,
  });
});

/**
 * POST /api/auth/logout
 * Revokes the refresh token supplied, or every session when `all` is true.
 */
const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout(req.user, req.body, { requestId: req.id });

  res.status(200).json({
    success: true,
    message:
      result.scope === 'all'
        ? 'Signed out of every device.'
        : 'Signed out. Discard the access token — it stays valid until it expires.',
    data: result,
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
 * Changes the caller's own password and issues a replacement token pair,
 * retiring every token issued before now.
 */
const changePassword = asyncHandler(async (req, res) => {
  const tokens = await authService.changePassword(req.user, req.body, sessionContext(req));

  res.status(200).json({
    success: true,
    message: 'Password changed. Other sessions have been signed out.',
    data: tokens,
    requestId: req.id,
  });
});

module.exports = { signup, login, refresh, logout, getProfile, changePassword };
