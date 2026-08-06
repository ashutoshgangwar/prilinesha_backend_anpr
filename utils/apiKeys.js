const crypto = require('crypto');

const { PROJECT_API_KEY_PREFIX } = require('./constants');

/**
 * Per-project API keys — the credential Intozi installs on site.
 *
 * The plaintext is returned exactly once, when the project is created or its
 * key is rotated. Only the SHA-256 digest is stored, so a database dump does
 * not yield a working camera credential.
 *
 * SHA-256 (not bcrypt) is the right choice here: the key is 256 bits of
 * generated randomness, so there is no dictionary to defend against, and the
 * ingestion path authenticates on every event — it has to be an indexed lookup,
 * not a per-candidate hash comparison.
 */

/**
 * Builds a key of the form `pk_<GROUP_ID>_<48 hex chars>`.
 *
 * Embedding the group makes a key found in a config file traceable to its
 * project without querying anything; the entropy is entirely in the suffix.
 *
 * @param {string} groupId
 * @returns {string} Plaintext key — store the hash, hand this to the customer.
 */
const generateProjectApiKey = (groupId) => {
  const slug = String(groupId)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 16);

  return `${PROJECT_API_KEY_PREFIX}${slug}_${crypto.randomBytes(24).toString('hex')}`;
};

/**
 * @param {string} plaintextKey
 * @returns {string} Hex SHA-256 digest, as stored in Project.api_key_hash.
 */
const hashApiKey = (plaintextKey) =>
  crypto.createHash('sha256').update(String(plaintextKey)).digest('hex');

/**
 * @param {string} plaintextKey
 * @returns {string} The last 4 characters, safe to show in the dashboard so an
 *          operator can tell which key is installed without being able to
 *          reconstruct it.
 */
const keyLast4 = (plaintextKey) => String(plaintextKey).slice(-4);

/**
 * @param {string} value
 * @returns {boolean} true when the value is shaped like a project key. Lets the
 *          auth middleware skip a database lookup for the global API key.
 */
const looksLikeProjectKey = (value) =>
  typeof value === 'string' && value.startsWith(PROJECT_API_KEY_PREFIX);

module.exports = { generateProjectApiKey, hashApiKey, keyLast4, looksLikeProjectKey };
