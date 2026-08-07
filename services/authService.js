const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Project = require('../models/Project');
const { assertDashboardAccess } = require('./projectService');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  currentSecond,
} = require('../utils/jwt');
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
 * Issues an access + refresh token pair and records the refresh token as a live
 * session on the user.
 *
 * Everything that hands out tokens goes through here, so the session cap, the
 * pruning of expired entries and the "store only the hash" rule are stated once
 * and cannot be forgotten by a new caller.
 *
 * The caller must have loaded `user` with `+refresh_sessions` selected; when it
 * has not, the list is fetched here rather than silently overwritten — dropping
 * a user's other devices because of a missing projection would be a very quiet
 * bug.
 *
 * Passing `rotateFrom` advances an existing session to its next generation
 * instead of opening a new one — a refresh is the same device continuing, not a
 * second sign-in, and counting it as one would evict a real device from the cap
 * every time someone's token expired.
 *
 * @param {object} user Mongoose User document (saved by this function).
 * @param {object} [context]
 * @param {string} [context.userAgent]
 * @param {string} [context.ip]
 * @param {string} [context.rotateFrom] Hash of the refresh token being replaced.
 * @returns {Promise<{ token: string, token_type: string, expires_in: string,
 *                     refresh_token: string, refresh_expires_in: string }>}
 */
const issueTokens = async (user, { userAgent = null, ip = null, rotateFrom = null } = {}) => {
  if (!Array.isArray(user.refresh_sessions)) {
    const stored = await User.findById(user._id).select('+refresh_sessions').lean();
    user.refresh_sessions = stored?.refresh_sessions ?? [];
  }

  const access = signAccessToken(user);
  const refresh = signRefreshToken(user);

  const now = new Date();
  const agent = userAgent ? String(userAgent).slice(0, 300) : null;

  // Plain objects, because the whole array is reassigned below. Expired
  // sessions are dropped on the way through: nothing checks them, and left in
  // place they would fill the cap with tokens that can no longer be used.
  const sessions = user.refresh_sessions
    .map((session) => (typeof session.toObject === 'function' ? session.toObject() : { ...session }))
    .filter((session) => new Date(session.expires_at).getTime() > now.getTime());

  const rotated = rotateFrom
    ? sessions.find((session) => session.token_hash === rotateFrom)
    : null;

  if (rotated) {
    rotated.previous_token_hash = rotated.token_hash;
    rotated.token_hash = hashRefreshToken(refresh.token);
    rotated.last_used_at = now;
    rotated.expires_at = refresh.expires_at;
    rotated.user_agent = agent ?? rotated.user_agent;
    rotated.ip = ip ?? rotated.ip;
  } else {
    sessions.sort(
      (a, b) =>
        new Date(a.last_used_at ?? a.issued_at) - new Date(b.last_used_at ?? b.issued_at)
    );
    while (sessions.length >= config.MAX_ACTIVE_SESSIONS) sessions.shift();

    sessions.push({
      token_hash: hashRefreshToken(refresh.token),
      previous_token_hash: null,
      issued_at: now,
      last_used_at: now,
      expires_at: refresh.expires_at,
      user_agent: agent,
      ip: ip ?? null,
    });
  }

  user.refresh_sessions = sessions;
  await user.save();

  return {
    token: access.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    refresh_token: refresh.token,
    refresh_expires_in: refresh.expires_in,
  };
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
 * @param {string} [context.userAgent]
 * @param {string} [context.ip]
 * @returns {Promise<{ user: object, token: string, token_type: string,
 *                     expires_in: string, refresh_token: string,
 *                     refresh_expires_in: string }>}
 * @throws {AppError} 403 when signup is disabled, 409 when the email is taken.
 */
const signup = async (payload, { requestId, userAgent, ip } = {}) => {
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

    const tokens = await issueTokens(user, { userAgent, ip });

    return { user: toAuthUser(user, []), ...tokens };
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
 * @param {string} [context.userAgent]
 * @param {string} [context.ip]
 * @returns {Promise<{ user: object, token: string, token_type: string,
 *                     expires_in: string, refresh_token: string,
 *                     refresh_expires_in: string }>}
 * @throws {AppError} 401 on bad credentials, 403 on a deactivated account.
 */
const login = async (payload, { requestId, userAgent, ip } = {}) => {
  const log = logger.child({ requestId, email: payload.email });
  const email = String(payload.email).trim().toLowerCase();

  const user = await User.findOne({ email }).select('+password_hash +refresh_sessions');

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

  // A live account is not enough — the customer's project has to be live too.
  // Checked after the password, so this never becomes an oracle for which
  // addresses are registered.
  await assertDashboardAccess(user, { requestId });

  user.last_login_at = new Date();

  // issueTokens saves, so last_login_at rides along on the same write.
  const tokens = await issueTokens(user, { userAgent, ip });
  const projects = await loadProjectSummaries(user);

  log.info('User logged in', { userId: String(user._id), role: user.role });

  return { user: toAuthUser(user, projects), ...tokens };
};

/**
 * Exchanges a refresh token for a new access + refresh pair.
 *
 * Three things have to hold, and a valid signature is only the first:
 *
 *   1. the token verifies against the refresh secret and is tagged `refresh`;
 *   2. the account still exists, is active, and has not had its tokens retired
 *      since (a password change, a role change or a deactivation all do that);
 *   3. the token is a *live session* — its hash is still in refresh_sessions.
 *
 * The presented token is then rotated away: it is removed and a new one issued,
 * so every refresh token is single-use. That turns a stolen token into a
 * detectable event rather than a silent, permanent foothold — see below.
 *
 * @param {object} payload Validated: refresh_token.
 * @param {object} [context]
 * @returns {Promise<{ user: object, token: string, token_type: string,
 *                     expires_in: string, refresh_token: string,
 *                     refresh_expires_in: string }>}
 * @throws {AppError} 401 for anything that is not a live session.
 */
const refresh = async (payload, { requestId, userAgent, ip } = {}) => {
  const log = logger.child({ requestId });

  const decoded = verifyRefreshToken(payload.refresh_token);

  if (!decoded) {
    log.warn('Refresh rejected: invalid or expired refresh token', { ip });
    throw AppError.unauthorized('Invalid or expired refresh token. Please log in again.');
  }

  const user = await User.findById(decoded.sub).select('+refresh_sessions');

  if (!user || !user.is_active) {
    throw AppError.unauthorized('This account is no longer active.');
  }

  const issuedAt = decoded.iat ? decoded.iat * 1000 : 0;
  if (user.tokens_valid_from && issuedAt < user.tokens_valid_from.getTime()) {
    log.warn('Refresh rejected: token predates the account cutoff', { userId: String(user._id) });
    throw AppError.unauthorized('Session expired. Please log in again.');
  }

  // Same gate as login: a session cannot be renewed into a project that was
  // switched off while it was running.
  await assertDashboardAccess(user, { requestId });

  const presentedHash = hashRefreshToken(payload.refresh_token);
  const active = user.refresh_sessions.find((session) => session.token_hash === presentedHash);

  if (!active) {
    // Not the token this session currently accepts. Two very different reasons
    // land here, and conflating them would be a bug users feel:
    const superseded = user.refresh_sessions.find(
      (session) => session.previous_token_hash === presentedHash
    );

    if (superseded) {
      // It is the generation immediately before the live one. The legitimate
      // client already exchanged it and holds the replacement, so whoever sent
      // this kept a copy of a spent token — the textbook signature of theft.
      // Assume the worst and end every session, so the thief and the victim
      // both have to come back through the password.
      user.refresh_sessions = [];
      user.tokens_valid_from = currentSecond();
      await user.save();

      log.warn('Refresh token reuse detected — every session revoked', {
        userId: String(user._id),
        ip,
      });

      throw AppError.unauthorized(
        'This refresh token has already been used. All sessions have been signed out for safety — please log in again.'
      );
    }

    // Otherwise it was revoked on purpose — logged out, dropped by the session
    // cap, or cleared by a password change. Nothing sinister; refuse it and
    // leave the user's other devices alone.
    log.warn('Refresh rejected: token is not a live session', { userId: String(user._id) });
    throw AppError.unauthorized('This session has ended. Please log in again.');
  }

  const tokens = await issueTokens(user, { userAgent, ip, rotateFrom: presentedHash });
  const projects = await loadProjectSummaries(user);

  log.info('Tokens refreshed', { userId: String(user._id), role: user.role });

  return { user: toAuthUser(user, projects), ...tokens };
};

/**
 * Signs the caller out.
 *
 * Two modes, because they are genuinely different requests:
 *
 *   this session — pass the `refresh_token` being retired. Only that device is
 *                  affected. Its access token is NOT killed, because access
 *                  tokens are stateless; it simply expires within the hour or
 *                  twelve. That is the accepted cost of not doing a database
 *                  lookup on every single request.
 *
 *   everywhere   — pass `all: true`. Clears every session and bumps
 *                  `tokens_valid_from`, which retires outstanding *access*
 *                  tokens too. This is the one to call when a laptop is lost.
 *
 * Logging out is never an error: a token that was already revoked reports zero
 * sessions removed rather than a 4xx, so a client retrying a failed logout does
 * not surface a scary message to a user who is, in fact, logged out.
 *
 * @param {object} user    Document attached by the authenticate middleware.
 * @param {object} payload Validated: refresh_token? , all?
 * @param {object} [context]
 * @returns {Promise<{ sessions_revoked: number, scope: 'session'|'all' }>}
 */
const logout = async (user, payload = {}, { requestId } = {}) => {
  const log = logger.child({ requestId, userId: String(user._id) });

  const current = await User.findById(user._id).select('+refresh_sessions');
  if (!current) throw AppError.unauthorized('This account is no longer active.');

  const before = current.refresh_sessions.length;

  if (payload.all === true) {
    current.refresh_sessions = [];
    current.tokens_valid_from = currentSecond();
    await current.save();

    log.info('Logged out of every session', { sessionsRevoked: before });
    return { sessions_revoked: before, scope: 'all' };
  }

  // Either generation identifies the session — a client that refreshed and then
  // logged out with the token it started the page with still means "this one".
  const presentedHash = hashRefreshToken(payload.refresh_token);
  current.refresh_sessions = current.refresh_sessions.filter(
    (session) =>
      session.token_hash !== presentedHash && session.previous_token_hash !== presentedHash
  );
  await current.save();

  const revoked = before - current.refresh_sessions.length;
  log.info('Logged out of one session', { sessionsRevoked: revoked });

  return { sessions_revoked: revoked, scope: 'session' };
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
 * Bumps `tokens_valid_from`, which invalidates every access token issued
 * earlier, and drops every refresh session — including any an attacker may
 * already hold. The caller is issued a fresh pair so they are not logged out of
 * the session they are sitting in; every other device has to log in again,
 * which is the entire point of changing a password.
 *
 * @param {object} user       Document attached by the authenticate middleware.
 * @param {object} payload    Validated: current_password, new_password.
 * @param {object} [context]
 * @returns {Promise<{ token: string, token_type: string, expires_in: string,
 *                     refresh_token: string, refresh_expires_in: string }>}
 * @throws {AppError} 401 when the current password is wrong.
 */
const changePassword = async (user, payload, { requestId, userAgent, ip } = {}) => {
  const log = logger.child({ requestId, userId: String(user._id) });

  const current = await User.findById(user._id).select('+password_hash +refresh_sessions');
  if (!current) throw AppError.unauthorized('This account is no longer active.');

  const matches = await current.verifyPassword(payload.current_password);
  if (!matches) {
    log.warn('Password change rejected: wrong current password');
    throw AppError.unauthorized('Your current password is incorrect.');
  }

  current.password_hash = payload.new_password; // re-hashed by the pre-save hook
  current.tokens_valid_from = currentSecond();
  current.refresh_sessions = []; // every other device is signed out
  await current.save();

  log.info('Password changed');

  return issueTokens(current, { userAgent, ip });
};

module.exports = {
  signup,
  login,
  refresh,
  logout,
  getProfile,
  changePassword,
  toAuthUser,
};
