const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Project = require('../models/Project');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { signAccessToken, currentSecond } = require('../utils/jwt');
const { ROLES, DEFAULT_ROLE, ROLE_PERMISSIONS } = require('../utils/constants');

/**
 * Signup, login and self-service account operations.
 *
 * Signing up creates an account, not access: a new user is an `admin` with an
 * empty project list, which every scoped query reads as "matches nothing". A
 * super admin assigning them a group_id is the moment they can actually see
 * anything — see services/userService.js.
 */

/**
 * A real bcrypt hash of a value nobody knows, compared against when the email
 * does not exist. Without it, "no such account" would return in microseconds
 * while a wrong password takes ~250ms — a timing oracle that lets an attacker
 * enumerate which addresses are registered.
 */
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9YkQ8ZQ1hFDvGxwXQZ5v0Q0Q0Q0Q0Q0';

/**
 * The user shape every authenticated response returns.
 *
 * Includes the permission list so the dashboard can hide actions the role
 * cannot perform. It is a convenience for the UI, never the enforcement point:
 * the server checks the same permissions on every request regardless.
 */
const toAuthUser = (user, projects = null) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone_number: user.phone_number ?? null,
  role: user.role,
  is_super_admin: user.role === ROLES.SUPER_ADMIN,
  // A super admin is scoped to every project, present and future, so listing
  // ids for them would be a snapshot that lies the next time one is created.
  group_ids: user.role === ROLES.SUPER_ADMIN ? 'ALL' : [...user.projects],
  projects,
  permissions: ROLE_PERMISSIONS[user.role] ?? [],
  is_active: user.is_active,
  last_login_at: user.last_login_at ?? null,
  created_at: user.createdAt,
});

/**
 * Loads the name of each project a user is assigned to, so the dashboard can
 * render a project switcher without a second round trip.
 */
const loadProjectSummaries = async (user) => {
  const filter =
    user.role === ROLES.SUPER_ADMIN ? {} : { group_id: { $in: user.projects ?? [] } };

  // A super admin with no projects yet should not be handed the whole table on
  // login either — the switcher is a convenience, not a report.
  if (user.role !== ROLES.SUPER_ADMIN && !(user.projects ?? []).length) return [];

  const projects = await Project.find(filter)
    .select('group_id project_name is_active')
    .sort({ project_name: 1 })
    .limit(200)
    .lean();

  return projects.map((project) => ({
    group_id: project.group_id,
    project_name: project.project_name,
    is_active: project.is_active,
  }));
};

/**
 * Registers a new dashboard user.
 *
 * The role is forced to `admin` no matter what the body says — a public
 * endpoint that honoured a `role` field would let anyone mint a super admin.
 * Super admins are created by another super admin, or seeded at boot.
 *
 * @param {object} payload Validated: name, email, password, phone_number?
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{ user: object, token: string, expires_in: string }>}
 * @throws {AppError} 403 when signup is disabled, 409 when the email is taken.
 */
const signup = async (payload, { requestId } = {}) => {
  const log = logger.child({ requestId, email: payload.email });

  if (!config.SIGNUP_ENABLED) {
    throw AppError.forbidden('Public signup is disabled. Ask an administrator for an account.');
  }

  const email = String(payload.email).trim().toLowerCase();

  const existing = await User.findOne({ email }).select('_id').lean();
  if (existing) {
    log.warn('Signup rejected: email already registered');
    throw AppError.conflict('An account with this email address already exists.');
  }

  try {
    const user = await User.create({
      name: payload.name,
      email,
      phone_number: payload.phone_number ?? null,
      password_hash: payload.password, // hashed by the model's pre-save hook
      role: DEFAULT_ROLE,
      projects: [],
    });

    log.info('User signed up', { userId: String(user._id), role: user.role });

    const { token, expires_in } = signAccessToken(user);

    return { user: toAuthUser(user, []), token, expires_in };
  } catch (error) {
    // Two simultaneous signups with the same address race past the check above;
    // the unique index is the authority.
    if (error.code === 11000) {
      throw AppError.conflict('An account with this email address already exists.');
    }
    throw error;
  }
};

/**
 * Exchanges credentials for an access token.
 *
 * A wrong email and a wrong password produce the identical 401, and the
 * password is compared even when no user was found, so response timing does not
 * reveal which addresses are registered.
 *
 * @param {object} payload Validated: email, password.
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{ user: object, token: string, expires_in: string }>}
 * @throws {AppError} 401 on bad credentials, 403 on a deactivated account.
 */
const login = async (payload, { requestId } = {}) => {
  const log = logger.child({ requestId, email: payload.email });
  const email = String(payload.email).trim().toLowerCase();

  const user = await User.findOne({ email }).select('+password_hash');

  if (!user) {
    // Burn a comparable amount of time against a throwaway hash so a missing
    // account is not detectably faster than a wrong password.
    await bcrypt.compare(String(payload.password), DUMMY_PASSWORD_HASH).catch(() => false);

    log.warn('Login failed: no such account');
    throw AppError.unauthorized('Invalid email or password.');
  }

  const passwordMatches = await user.verifyPassword(payload.password);

  if (!passwordMatches) {
    log.warn('Login failed: wrong password', { userId: String(user._id) });
    throw AppError.unauthorized('Invalid email or password.');
  }

  if (!user.is_active) {
    log.warn('Login failed: account deactivated', { userId: String(user._id) });
    throw AppError.forbidden('This account has been deactivated. Contact your administrator.');
  }

  user.last_login_at = new Date();
  await user.save();

  const { token, expires_in } = signAccessToken(user);
  const projects = await loadProjectSummaries(user);

  log.info('User logged in', { userId: String(user._id), role: user.role });

  return { user: toAuthUser(user, projects), token, expires_in };
};

/**
 * The current user, refreshed from the database — used by the dashboard on
 * page load to rebuild its session and project switcher.
 *
 * @param {object} user Document attached by the authenticate middleware.
 * @returns {Promise<object>}
 */
const getProfile = async (user) => {
  const projects = await loadProjectSummaries(user);
  return toAuthUser(user, projects);
};

/**
 * Changes the caller's own password.
 *
 * Bumps `tokens_valid_from`, which invalidates every token issued earlier —
 * including one an attacker may already hold. The caller is issued a fresh
 * token so they are not logged out of the session they are sitting in.
 *
 * @param {object} user       Document attached by the authenticate middleware.
 * @param {object} payload    Validated: current_password, new_password.
 * @param {object} [context]
 * @returns {Promise<{ token: string, expires_in: string }>}
 * @throws {AppError} 401 when the current password is wrong.
 */
const changePassword = async (user, payload, { requestId } = {}) => {
  const log = logger.child({ requestId, userId: String(user._id) });

  const current = await User.findById(user._id).select('+password_hash');
  if (!current) throw AppError.unauthorized('This account is no longer active.');

  const matches = await current.verifyPassword(payload.current_password);
  if (!matches) {
    log.warn('Password change rejected: wrong current password');
    throw AppError.unauthorized('Your current password is incorrect.');
  }

  current.password_hash = payload.new_password; // re-hashed by the pre-save hook
  current.tokens_valid_from = currentSecond();
  await current.save();

  log.info('Password changed');

  const { token, expires_in } = signAccessToken(current);
  return { token, expires_in };
};

module.exports = { signup, login, getProfile, changePassword, toAuthUser };
