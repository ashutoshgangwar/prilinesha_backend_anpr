const config = require('./env');
const User = require('../models/User');
const logger = require('../utils/logger');
const { ROLES } = require('../utils/constants');

/**
 * First-run bootstrap.
 *
 * Somebody has to be able to log in before anyone can be granted anything, and
 * signup only ever produces a customer `admin`. This seeds the first
 * `super_admin` from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD.
 *
 * It is deliberately a no-op once any super admin exists, so leaving the
 * variables in the environment cannot resurrect a deleted account, undo a
 * password change, or re-promote someone who was demoted.
 *
 * @returns {Promise<void>}
 */
const ensureSuperAdmin = async () => {
  const existing = await User.countDocuments({ role: ROLES.SUPER_ADMIN });

  if (existing > 0) {
    logger.info('Super admin present — bootstrap skipped', { count: existing });
    return;
  }

  if (!config.SUPER_ADMIN_EMAIL || !config.SUPER_ADMIN_PASSWORD) {
    logger.warn(
      'No super admin exists and SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are not set — ' +
        'nobody can administer projects or users yet. Set them and restart.'
    );
    return;
  }

  const email = config.SUPER_ADMIN_EMAIL.trim().toLowerCase();

  // The address may already belong to someone who signed up as a customer
  // admin; promote them rather than colliding with the unique email index.
  const claimed = await User.findOne({ email });

  if (claimed) {
    claimed.role = ROLES.SUPER_ADMIN;
    claimed.projects = [];
    claimed.is_active = true;
    await claimed.save();

    logger.warn('Existing account promoted to super admin by bootstrap', { email });
    return;
  }

  await User.create({
    name: config.SUPER_ADMIN_NAME,
    email,
    password_hash: config.SUPER_ADMIN_PASSWORD, // hashed by the model's pre-save hook
    role: ROLES.SUPER_ADMIN,
    projects: [],
    is_active: true,
  });

  logger.warn('First super admin created from environment variables', {
    email,
    hint: 'Log in, change this password, then clear SUPER_ADMIN_PASSWORD from the environment.',
  });
};

module.exports = { ensureSuperAdmin };
