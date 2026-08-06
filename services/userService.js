const User = require('../models/User');
const Project = require('../models/Project');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { currentSecond } = require('../utils/jwt');
const {
  ROLES,
  ROLE_VALUES,
  ROLE_PERMISSIONS,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
} = require('../utils/constants');

/**
 * Dashboard user administration — the super admin's side of the system.
 *
 * The important operation here is `assignProjects`: signing up gives someone an
 * account with an empty project list, which every scoped query reads as
 * "matches nothing". Putting a group_id on their record is the actual grant of
 * access, and taking it off revokes it on their very next request (the auth
 * middleware reloads the user rather than trusting the token).
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shapes a user for the admin table. Never includes the password hash. */
const toUserRecord = (user) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone_number: user.phone_number ?? null,
  role: user.role,
  group_ids: user.role === ROLES.SUPER_ADMIN ? 'ALL' : [...(user.projects ?? [])],
  permissions: ROLE_PERMISSIONS[user.role] ?? [],
  is_active: user.is_active,
  last_login_at: user.last_login_at ?? null,
  created_at: user.createdAt,
  updated_at: user.updatedAt,
});

/**
 * Rejects group_ids that do not exist.
 *
 * Assigning a typo'd project would silently grant access to nothing and look
 * like a bug in the dashboard, so it fails loudly instead.
 *
 * @param {string[]} groupIds
 * @returns {Promise<string[]>} Normalised, de-duplicated ids.
 * @throws {AppError} 400 listing the unknown ids.
 */
const validateGroupIds = async (groupIds = []) => {
  const normalised = [...new Set(groupIds.map((id) => String(id).trim().toUpperCase()))].filter(
    Boolean
  );

  if (!normalised.length) return [];

  const found = await Project.find({ group_id: { $in: normalised } })
    .select('group_id')
    .lean();

  const known = new Set(found.map((project) => project.group_id));
  const unknown = normalised.filter((id) => !known.has(id));

  if (unknown.length) {
    throw AppError.badRequest('One or more projects do not exist.', [
      { field: 'group_ids', message: `Unknown group_id: ${unknown.join(', ')}.` },
    ]);
  }

  return normalised;
};

/**
 * Loads a user by id or fails with a 404.
 *
 * @param {string} userId
 * @returns {Promise<object>} Mongoose document.
 */
const findUserOrFail = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('No user found with that id.');
  return user;
};

/**
 * Creates a user directly, with a role and projects set up front.
 *
 * Unlike signup this can mint a super admin, which is why the route behind it
 * is restricted to existing super admins.
 *
 * @param {object} payload Validated: name, email, password, role?, group_ids?
 * @param {object} [context]
 * @param {object} [context.actor]
 * @returns {Promise<object>}
 * @throws {AppError} 409 when the email is taken.
 */
const createUser = async (payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, email: payload.email });

  const email = String(payload.email).trim().toLowerCase();
  const role = payload.role && ROLE_VALUES.includes(payload.role) ? payload.role : ROLES.ADMIN;

  const existing = await User.findOne({ email }).select('_id').lean();
  if (existing) throw AppError.conflict('An account with this email address already exists.');

  // A super admin is scoped to everything by role, so a project list on one is
  // dead weight that would later read as a restriction it never was.
  const projects = role === ROLES.SUPER_ADMIN ? [] : await validateGroupIds(payload.group_ids ?? []);

  try {
    const user = await User.create({
      name: payload.name,
      email,
      phone_number: payload.phone_number ?? null,
      password_hash: payload.password, // hashed by the model's pre-save hook
      role,
      projects,
      is_active: true,
      created_by: actor ? actor._id : null,
    });

    log.info('User created', {
      userId: String(user._id),
      role,
      projects,
      by: actor ? String(actor._id) : 'system',
    });

    return toUserRecord(user);
  } catch (error) {
    if (error.code === 11000) {
      throw AppError.conflict('An account with this email address already exists.');
    }
    throw error;
  }
};

/**
 * Lists dashboard users.
 *
 * @param {object} params search?, role?, group_id?, is_active?, page?, limit?
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listUsers = async (
  { search, role, group_id: groupId, is_active: isActive, page, limit } = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });

  const pageSize = Math.min(Number(limit) || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = {};

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: term }, { email: term }, { phone_number: term }];
  }

  if (role) filter.role = role;
  if (groupId) filter.projects = String(groupId).trim().toUpperCase();
  if (isActive !== undefined && isActive !== null) filter.is_active = isActive;

  const [documents, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    User.countDocuments(filter),
  ]);

  log.info('Users listed', { count: documents.length, total });

  return {
    records: documents.map(toUserRecord),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 0,
      has_next: currentPage * pageSize < total,
      has_previous: currentPage > 1,
    },
  };
};

/**
 * @param {string} userId
 * @returns {Promise<object>}
 */
const getUser = async (userId) => toUserRecord(await findUserOrFail(userId));

/**
 * Sets which projects a user may access.
 *
 * `mode` decides how the list is applied:
 *   'replace' (default) — the given list becomes the whole assignment
 *   'add'               — union with what they already have
 *   'remove'            — subtract from what they already have
 *
 * @param {string} userId
 * @param {object} payload group_ids, mode?
 * @param {object} [context]
 * @returns {Promise<object>}
 * @throws {AppError} 400 on unknown group_ids.
 */
const assignProjects = async (userId, payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, userId });
  const user = await findUserOrFail(userId);

  if (user.role === ROLES.SUPER_ADMIN) {
    throw AppError.badRequest(
      'A super admin already has access to every project — assignments do not apply to them.'
    );
  }

  const requested = await validateGroupIds(payload.group_ids ?? []);
  const mode = payload.mode ?? 'replace';
  const existing = new Set(user.projects ?? []);

  let next;
  if (mode === 'add') {
    next = [...new Set([...existing, ...requested])];
  } else if (mode === 'remove') {
    const removing = new Set(requested);
    next = [...existing].filter((id) => !removing.has(id));
  } else {
    next = requested;
  }

  user.projects = next;
  await user.save();

  log.info('Project assignment updated', {
    mode,
    projects: next,
    by: actor ? String(actor._id) : 'system',
  });

  return toUserRecord(user);
};

/**
 * Changes a user's role.
 *
 * Demoting a super admin clears nothing — they simply stop being unscoped, and
 * with an empty project list they see nothing until one is assigned. That is
 * intentional: a demotion should not silently leave access behind.
 *
 * @param {string} userId
 * @param {string} role
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const setRole = async (userId, role, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, userId });

  if (!ROLE_VALUES.includes(role)) {
    throw AppError.badRequest(`role must be one of: ${ROLE_VALUES.join(', ')}.`);
  }

  const user = await findUserOrFail(userId);

  if (actor && String(actor._id) === String(user._id) && role !== user.role) {
    throw AppError.badRequest('You cannot change your own role.');
  }

  // Never leave the system with no way back in.
  if (user.role === ROLES.SUPER_ADMIN && role !== ROLES.SUPER_ADMIN) {
    const remaining = await User.countDocuments({
      role: ROLES.SUPER_ADMIN,
      is_active: true,
      _id: { $ne: user._id },
    });

    if (remaining === 0) {
      throw AppError.badRequest('This is the last active super admin — promote another one first.');
    }
  }

  user.role = role;
  if (role === ROLES.SUPER_ADMIN) user.projects = [];

  // A role change is an authorisation change, so previously issued tokens must
  // stop carrying the old one.
  user.tokens_valid_from = currentSecond();
  await user.save();

  log.info('User role changed', { role, by: actor ? String(actor._id) : 'system' });

  return toUserRecord(user);
};

/**
 * Activates or deactivates a user.
 *
 * Deactivating also retires their outstanding tokens, so access ends on the
 * next request rather than when the token happens to expire.
 *
 * @param {string} userId
 * @param {boolean} isActive
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const setActive = async (userId, isActive, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, userId });
  const user = await findUserOrFail(userId);

  if (actor && String(actor._id) === String(user._id) && !isActive) {
    throw AppError.badRequest('You cannot deactivate your own account.');
  }

  if (!isActive && user.role === ROLES.SUPER_ADMIN) {
    const remaining = await User.countDocuments({
      role: ROLES.SUPER_ADMIN,
      is_active: true,
      _id: { $ne: user._id },
    });

    if (remaining === 0) {
      throw AppError.badRequest('This is the last active super admin — promote another one first.');
    }
  }

  user.is_active = isActive;
  if (!isActive) user.tokens_valid_from = currentSecond();
  await user.save();

  log.info(isActive ? 'User activated' : 'User deactivated', {
    by: actor ? String(actor._id) : 'system',
  });

  return toUserRecord(user);
};

/**
 * Sets a new password on someone else's account, for the "user forgot theirs"
 * case. Retires their existing tokens too.
 *
 * @param {string} userId
 * @param {string} newPassword
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const resetPassword = async (userId, newPassword, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, userId });
  const user = await findUserOrFail(userId);

  user.password_hash = newPassword; // hashed by the model's pre-save hook
  user.tokens_valid_from = currentSecond();
  await user.save();

  log.warn('Password reset by an administrator', { by: actor ? String(actor._id) : 'system' });

  return toUserRecord(user);
};

module.exports = {
  createUser,
  listUsers,
  getUser,
  assignProjects,
  setRole,
  setActive,
  resetPassword,
  toUserRecord,
  validateGroupIds,
};
