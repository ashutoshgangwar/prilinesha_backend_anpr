const express = require('express');

const authController = require('../controllers/authController');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { signupRules, loginRules, changePasswordRules } = require('../validators/authValidator');

const router = express.Router();

/**
 * Dashboard authentication.
 *
 * Signup and login are the only endpoints in the whole API that are reachable
 * without a credential, so both sit behind the strict `authLimiter` rather than
 * the general one.
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
