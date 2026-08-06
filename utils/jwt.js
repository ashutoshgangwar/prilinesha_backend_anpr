const jwt = require('jsonwebtoken');

const config = require('../config/env');

/**
 * Access tokens for dashboard users.
 *
 * The token carries identity only — id, role and email. It deliberately does
 * NOT carry the user's project list: projects change when a super admin
 * reassigns them, and a claim baked into a 12-hour token would keep granting
 * access to a project that was revoked an hour ago. The middleware reloads the
 * user on every request instead, so a revocation takes effect immediately.
 */

/**
 * "Now", truncated to a whole second.
 *
 * A token's `iat` claim is in whole seconds, so a millisecond-precision cutoff
 * stored in `tokens_valid_from` would sit a fraction of a second *ahead* of a
 * token minted in that very same second and reject it immediately. Every
 * writer of `tokens_valid_from` goes through this.
 *
 * @returns {Date}
 */
const currentSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/**
 * @param {object} user Mongoose User document.
 * @returns {{ token: string, expires_in: string }}
 */
const signAccessToken = (user) => {
  const token = jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      role: user.role,
    },
    config.JWT_SECRET,
    {
      expiresIn: config.JWT_EXPIRES_IN,
      issuer: config.JWT_ISSUER,
    }
  );

  return { token, expires_in: config.JWT_EXPIRES_IN };
};

/**
 * @param {string} token
 * @returns {object|null} Decoded payload, or null when the token is missing,
 *          malformed, expired or signed with a different secret. The caller
 *          cannot tell these apart on purpose — an attacker learns nothing
 *          about why a token was rejected.
 */
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, config.JWT_SECRET, { issuer: config.JWT_ISSUER });
  } catch {
    return null;
  }
};

module.exports = { signAccessToken, verifyAccessToken, currentSecond };
