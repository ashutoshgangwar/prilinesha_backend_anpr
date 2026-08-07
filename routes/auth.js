const express = require('express');

const authController = require('../controllers/authController');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const {
  signupRules,
  loginRules,
  refreshRules,
  logoutRules,
  changePasswordRules,
} = require('../validators/authValidator');

const router = express.Router();

/**
 * Dashboard authentication.
 *
 * Signup, login and refresh are the only endpoints in the whole API reachable
 * without a bearer credential, so all three sit behind the strict `authLimiter`
 * rather than the general one. `authLimiter` does not count successful calls,
 * so a whole office behind one NAT address never locks itself out by working
 * normally — only failures accumulate.
 *
 * The token model: a short-lived access token (12h) is sent on every request
 * and is never checked against the database beyond reloading the user; a
 * long-lived refresh token (30d) is sent only here, is stored as a hash, is
 * rotated on every use and can be revoked individually. See utils/jwt.js.
 */

/**
 * POST /api/auth/signup
 *
 * Creates a customer `admin` with no project access. The role in the body, if
 * any, is ignored — super admins are created by other super admins.
 *
 * 201 created · 400 validation · 403 signup disabled · 409 email taken · 429 too many attempts
 */
router.post('/signup', authLimiter, validate(signupRules), authController.signup);

/**
 * POST /api/auth/login
 *
 * 200 ok · 400 validation · 401 bad credentials · 403 deactivated · 429 too many attempts
 */
router.post('/login', authLimiter, validate(loginRules), authController.login);

/**
 * POST /api/auth/refresh
 *
 * Exchanges a refresh token for a fresh access + refresh pair. No Authorization
 * header — the refresh token in the body IS the credential, which is the whole
 * point: it works after the access token has expired.
 *
 * Single-use. The token presented is rotated away, and presenting a rotated
 * token again revokes every session on the account.
 *
 * 200 ok · 400 validation · 401 invalid, expired, revoked or already used · 429 too many attempts
 */
router.post('/refresh', authLimiter, validate(refreshRules), authController.refresh);

/**
 * POST /api/auth/logout
 * Authorization: Bearer <token>
 *
 * Body `{ refresh_token }` ends that one session; `{ all: true }` ends every
 * session and retires outstanding access tokens too.
 *
 * 200 ok · 400 validation · 401 unauthorized
 */
router.post('/logout', authenticate, validate(logoutRules), authController.logout);

/**
 * GET /api/auth/me
 * Authorization: Bearer <token>
 *
 * The caller's identity, role, permissions and assigned projects.
 *
 * 200 ok · 401 unauthorized
 */
router.get('/me', authenticate, authController.getProfile);

/**
 * POST /api/auth/change-password
 * Authorization: Bearer <token>
 *
 * Signs every other session out and returns a fresh token for this one.
 *
 * 200 ok · 400 validation · 401 wrong current password
 */
router.post(
  '/change-password',
  authenticate,
  validate(changePasswordRules),
  authController.changePassword
);

module.exports = router;
