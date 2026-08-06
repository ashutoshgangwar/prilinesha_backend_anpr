const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const config = require('../config/env');
const { currentSecond } = require('../utils/jwt');
const { ROLE_VALUES, DEFAULT_ROLE, ROLES } = require('../utils/constants');

/**
 * A dashboard user.
 *
 * Two roles, by design (see utils/constants.js):
 *   super_admin — internal Prilinesha staff. Sees every project, manages users
 *                 and projects. `projects` is ignored for them.
 *   admin       — the customer's operator. Sees only the projects listed in
 *                 `projects`, and nothing at all until a super admin puts a
 *                 group_id there. Signing up therefore grants an account, not
 *                 access — the assignment is the access grant.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      // Stored lowercase so "A@b.com" and "a@b.com" cannot become two accounts.
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email must be a valid email address'],
    },

    phone_number: { type: String, trim: true, default: null },

    // bcrypt hash. `select: false` keeps it out of every query that does not
    // explicitly ask for it, so it cannot leak through a forgotten projection.
    password_hash: { type: String, required: true, select: false },

    role: { type: String, enum: ROLE_VALUES, default: DEFAULT_ROLE, required: true },

    // group_id values this user may read and write. Empty means no data access.
    // Uppercased on write to match Project.group_id exactly.
    projects: {
      type: [{ type: String, trim: true, uppercase: true }],
      default: [],
    },

    // Deactivating beats deleting: the audit trail on their registrations stays
    // intact, and their token stops working on the next request.
    is_active: { type: Boolean, default: true },

    last_login_at: { type: Date, default: null },

    // Any token issued before this instant is rejected. Bumped on password
    // change and on deactivation, which is what logs a stolen token out.
    // Truncated to a whole second to line up with a JWT's `iat` claim — see
    // currentSecond() in utils/jwt.js.
    tokens_valid_from: { type: Date, default: currentSecond },

    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.password_hash;
        return ret;
      },
    },
  }
);

// One account per email address.
userSchema.index({ email: 1 }, { unique: true, name: 'uniq_email' });

// "Who has access to this project?" — answered without scanning the collection.
userSchema.index({ projects: 1 }, { name: 'idx_user_projects' });

userSchema.index({ createdAt: -1 }, { name: 'idx_user_created_at' });

/**
 * Hashes `password_hash` whenever it has been set to a plaintext value.
 *
 * Doing it here rather than in the service means no code path can write a
 * plaintext password to the database by forgetting a call.
 */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password_hash')) return next();

  try {
    this.password_hash = await bcrypt.hash(this.password_hash, config.BCRYPT_ROUNDS);
    return next();
  } catch (error) {
    return next(error);
  }
});

/**
 * @param {string} plaintext
 * @returns {Promise<boolean>}
 */
userSchema.methods.verifyPassword = function verifyPassword(plaintext) {
  if (!this.password_hash) return Promise.resolve(false);
  return bcrypt.compare(String(plaintext), this.password_hash);
};

/** @returns {boolean} true when this user is internal and unscoped. */
userSchema.methods.isSuperAdmin = function isSuperAdmin() {
  return this.role === ROLES.SUPER_ADMIN;
};

module.exports = mongoose.model('User', userSchema);
