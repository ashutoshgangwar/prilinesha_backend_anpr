const User = require('../models/User');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { verifyAccessToken } = require('../utils/jwt');
const { ROLES, AUTH_SUBJECT, roleHasPermission } = require('../utils/constants');

/**
 * Dashboard authentication and authorisation.
 *
 * Three layers, applied in this order on a protected route:
 *
 *   authenticate          — who are you? (verifies the JWT, loads the user)
 *   authorize(permission) — are you allowed to do this at all? (role → permission)
 *   project scope         — on which projects? (group_id filtering)
 *
 * The third layer is the one that keeps customers apart, and it is enforced in
 * two places: `requireProjectAccess` for writes naming a group_id, and
 * `req.scope.groupIds` for reads, which every service turns into a filter.
 */

/** Extracts the bearer token from `Authorization: Bearer <token>`. */
const extractBearerToken = (req) => {
  const authorization = req.get('authorization');
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

/**
 * Verifies the access token and loads the user behind it.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the token's claims. That costs one indexed lookup and buys immediate
 * revocation: deactivating a user, changing their role, or removing a project
 * takes effect on their very next call instead of whenever their token expires.
 */
const authenticate = async (req, _res, next) => {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return next(
        AppError.unauthorized('Missing access token. Send it as: Authorization: Bearer <token>.')
      );
    }

    const payload = verifyAccessToken(token);

    if (!payload) {
      logger.warn('Rejected request: invalid or expired access token', {
        requestId: req.id,
        ip: req.ip,
        path: req.originalUrl,
      });
      return next(AppError.unauthorized('Invalid or expired access token. Please log in again.'));
    }

    const user = await User.findById(payload.sub);

    if (!user || !user.is_active) {
      return next(AppError.unauthorized('This account is no longer active.'));
    }

    // Password changes and forced logouts bump tokens_valid_from, retiring every
    // token minted before that instant. `iat` is in seconds; compare in seconds.
    const issuedAt = payload.iat ? payload.iat * 1000 : 0;
    if (user.tokens_valid_from && issuedAt < user.tokens_valid_from.getTime()) {
      return next(AppError.unauthorized('Session expired. Please log in again.'));
    }

    req.user = user;
    req.authSubject = AUTH_SUBJECT.USER;

    // The project scope for this request. `null` means "every project" and is
    // only ever produced for a super admin — a customer admin with no projects
    // gets `[]`, which filters everything out rather than letting everything in.
    req.scope = {
      groupIds: user.role === ROLES.SUPER_ADMIN ? null : [...user.projects],
      isSuperAdmin: user.role === ROLES.SUPER_ADMIN,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Requires one or more permissions (see PERMISSIONS in utils/constants.js).
 *
 * Routes name a permission, never a role, so granting a customer admin a new
 * capability later is a one-line edit to ROLE_PERMISSIONS — no route changes.
 *
 * @param {...string} permissions All must be held.
 * @returns {Function} Express middleware.
 */
const authorize =
  (...permissions) =>
  (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized('Authentication required.'));

    const missing = permissions.filter(
      (permission) => !roleHasPermission(req.user.role, permission)
    );

    if (missing.length) {
      logger.warn('Rejected request: insufficient permissions', {
        requestId: req.id,
        userId: String(req.user._id),
        role: req.user.role,
        missing,
        path: req.originalUrl,
      });
      return next(
        AppError.forbidden(`Your role (${req.user.role}) is not allowed to perform this action.`)
      );
    }

    return next();
  };

/** Convenience wrapper for the handful of endpoints that are internal-only. */
const requireSuperAdmin = (req, _res, next) => {
  if (!req.user) return next(AppError.unauthorized('Authentication required.'));
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    return next(AppError.forbidden('This endpoint is restricted to super admins.'));
  }
  return next();
};

/**
 * Throws unless the request's subject may act on `groupId`.
 *
 * @param {object} req
 * @param {string} groupId
 * @throws {AppError} 403
 */
const assertProjectAccess = (req, groupId) => {
  const scope = req.scope;

  if (!scope) throw AppError.unauthorized('Authentication required.');
  if (scope.groupIds === null) return; // super admin / unscoped root key

  const normalised = String(groupId || '').trim().toUpperCase();

  if (!normalised || !scope.groupIds.includes(normalised)) {
    logger.warn('Rejected request: project not in scope', {
      requestId: req.id,
      userId: req.user ? String(req.user._id) : null,
      requested: normalised || null,
      allowed: scope.groupIds,
    });
    throw AppError.forbidden(
      `You do not have access to project "${groupId}". Ask a super admin to assign it to your account.`
    );
  }
};

/**
 * Resolves the project a request is acting on, from `group_id` in the body,
 * query or route params, and checks it against the caller's scope.
 *
 * Convenience rule: a customer admin assigned to exactly one project may omit
 * `group_id` entirely — the single project they have is used. Anyone with
 * access to several (or to all) must say which one, because guessing on their
 * behalf is how data lands in the wrong tenant.
 *
 * On success sets `req.groupId` and rewrites `req.body.group_id` to the
 * normalised value, so services never have to re-derive it.
 */
const requireProjectAccess = (req, _res, next) => {
  try {
    const supplied = req.body?.group_id ?? req.query?.group_id ?? req.params?.group_id ?? null;

    let groupId = supplied ? String(supplied).trim().toUpperCase() : null;

    if (!groupId) {
      const scoped = req.scope?.groupIds;

      if (Array.isArray(scoped) && scoped.length === 1) {
        [groupId] = scoped;
      } else if (Array.isArray(scoped) && scoped.length === 0) {
        return next(
          AppError.forbidden(
            'Your account is not assigned to any project yet. Ask a super admin to assign one.'
          )
        );
      } else {
        return next(
          AppError.badRequest('group_id is required.', [
            {
              field: 'group_id',
              message:
                'You have access to more than one project — name the one this request applies to.',
            },
          ])
        );
      }
    }

    assertProjectAccess(req, groupId);

    req.groupId = groupId;
    if (req.body && typeof req.body === 'object') req.body.group_id = groupId;

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Builds the `group_id` clause for a list query.
 *
 * @param {object} req
 * @param {string} [requestedGroupId] Optional `?group_id=` narrowing filter.
 * @returns {object} A Mongo filter fragment: `{}` for an unscoped super admin,
 *          `{ group_id: X }` for one project, `{ group_id: { $in: [...] } }`
 *          for several. An admin with no projects yields `{ $in: [] }`, which
 *          correctly matches nothing.
 * @throws {AppError} 403 when `requestedGroupId` is outside the caller's scope.
 */
const buildScopeFilter = (req, requestedGroupId) => {
  const requested = requestedGroupId ? String(requestedGroupId).trim().toUpperCase() : null;

  if (requested) {
    assertProjectAccess(req, requested);
    return { group_id: requested };
  }

  const scoped = req.scope?.groupIds;
  if (scoped === null || scoped === undefined) return {};

  return { group_id: { $in: scoped } };
};

module.exports = {
  authenticate,
  authorize,
  requireSuperAdmin,
  requireProjectAccess,
  assertProjectAccess,
  buildScopeFilter,
};
