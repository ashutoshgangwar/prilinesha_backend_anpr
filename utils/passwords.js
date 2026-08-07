const crypto = require('crypto');

/**
 * Generated first passwords, for accounts a super admin creates on someone
 * else's behalf.
 *
 * The alphabets deliberately exclude the characters that get misread when a
 * password is dictated over the phone or copied off a printed handover sheet:
 * O/0, I/l/1. That is the actual failure mode for a credential a human has to
 * relay once, and the two characters it costs are bought back by length.
 */

// No O, I, l. No 0, 1.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%*?';
const ALPHABET = LETTERS + DIGITS + SYMBOLS;

const DEFAULT_LENGTH = 16;

/**
 * Picks one character uniformly at random.
 *
 * `randomInt` rather than `randomBytes % length`, which would bias the result
 * toward the start of the alphabet whenever the length does not divide 256.
 */
const pick = (alphabet) => alphabet[crypto.randomInt(0, alphabet.length)];

/**
 * Builds a password that satisfies the policy in validators/authValidator.js —
 * at least one letter and at least one number — by construction rather than by
 * retrying until a random string happens to comply.
 *
 * @param {number} [length] At least 8, to stay inside the policy.
 * @returns {string} Plaintext. Show it once; only its bcrypt hash is stored.
 */
const generateInitialPassword = (length = DEFAULT_LENGTH) => {
  const size = Math.max(8, length);

  // Seed the two required classes, fill the rest freely, then shuffle so the
  // guaranteed characters are not always in the same positions.
  const characters = [pick(LETTERS), pick(DIGITS)];

  while (characters.length < size) characters.push(pick(ALPHABET));

  // Fisher-Yates, with a CSPRNG for the same reason as above.
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }

  return characters.join('');
};

module.exports = { generateInitialPassword };
