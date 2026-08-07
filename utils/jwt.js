const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const config = require('../config/env');

/**
 * Tokens for dashboard users. Two kinds, with deliberately different jobs:
 *
 *   access  — short-lived (12h), sent on every request. Carries identity only:
 *             id, role and email. It does NOT carry the user's project list,
 *             because projects change when a super admin reassigns them and a
 *             claim baked into the token would keep granting access to a
 *             project revoked an hour ago. The middleware reloads the user on
 *             every request instead, so a revocation is immediate.
 *
 *   refresh — long-lived (30d), sent only to /api/auth/refresh. Carries no
 *             identity claims at all beyond `sub` — it is a ticket to be
 *             exchanged, not an assertion of who you are. Its SHA-256 is
 *             recorded on the user as an active session, so unlike the access
 *             token it can be revoked individually, and it is rotated on every
 *             exchange (see services/authService.js).
 *
 * The two are signed with different secrets AND tagged with a `typ` claim, so
 * neither can be presented where the other is expected even if a signing key
 * were somehow shared.
 */

const TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
};

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
      typ: TOKEN_TYPE.ACCESS,
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
 * Mints a refresh token.
 *
 * `expires_at` is read back off the signed token rather than recomputed from
 * the config string, so the session record and the token itself can never
 * disagree about when it dies.
 *
 * @param {object} user Mongoose User document.
 * @returns {{ token: string, jti: string, expires_in: string, expires_at: Date }}
 */
const signRefreshToken = (user) => {
  const jti = crypto.randomUUID();

  const token = jwt.sign(
    {
      sub: String(user._id),
      typ: TOKEN_TYPE.REFRESH,
      jti,
    },
    config.JWT_REFRESH_SECRET,
    {
      expiresIn: config.JWT_REFRESH_EXPIRES_IN,
      issuer: config.JWT_ISSUER,
    }
  );

  const { exp } = jwt.decode(token);

  return {
    token,
    jti,
    expires_in: config.JWT_REFRESH_EXPIRES_IN,
    expires_at: new Date(exp * 1000),
  };
};

/**
 * @param {string} token
 * @returns {object|null} Decoded payload, or null when the token is missing,
 *          malformed, expired, signed with a different secret, or is a refresh
 *          token being passed off as an access token. The caller cannot tell
 *          these apart on purpose — an attacker learns nothing about why a
 *          token was rejected.
 */
const verifyAccessToken = (token) => {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { issuer: config.JWT_ISSUER });

    // Tokens minted before `typ` existed carry no such claim and stay valid;
    // anything explicitly marked as another kind does not.
    if (payload.typ && payload.typ !== TOKEN_TYPE.ACCESS) return null;

    return payload;
  } catch {
    return null;
  }
};

/**
 * @param {string} token
 * @returns {object|null} Decoded payload, or null for anything that is not a
 *          currently-valid refresh token. Signature validity is only half the
 *          check — the caller must still confirm the token is a *live session*
 *          on the user, which is what makes revocation and rotation work.
 */
const verifyRefreshToken = (token) => {
  try {
    const payload = jwt.verify(token, config.JWT_REFRESH_SECRET, { issuer: config.JWT_ISSUER });

    if (payload.typ !== TOKEN_TYPE.REFRESH) return null;

    return payload;
  } catch {
    return null;
  }
};

/**
 * What gets stored against the user for a live session.
 *
 * The token is never persisted in the clear: a database dump then yields no
 * usable credential, exactly as with the password hash. SHA-256 rather than
 * bcrypt is right here because the input is 200+ bits of signed randomness,
 * not a guessable human password — there is nothing to brute force.
 *
 * @param {string} token
 * @returns {string} hex digest
 */
const hashRefreshToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = {
  TOKEN_TYPE,
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  currentSecond,
};
