const { body } = require('express-validator');

/**
 * Validation rules for the signup / login endpoints.
 *
 * The password policy lives here so it is stated once and applies identically
 * to signup, admin-created accounts and password changes.
 */

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Builds the rules for a password field.
 *
 * Length is the requirement that actually matters; the character-class check is
 * a light guard against "password" and "12345678" rather than a claim to
 * strength. It is not applied to the *current* password on a change, which only
 * has to match whatever was set before the policy existed.
 *
 * @param {string} field
 * @param {string} [label]
 */
const passwordRules = (field, label = field) => [
  body(field)
    .exists({ checkNull: true })
    .withMessage(`${label} is required.`)
    .bail()
    .isString()
    .withMessage(`${label} must be a string.`)
    .bail()
    .isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
    .withMessage(
      `${label} must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`
    )
    .bail()
    .matches(/[A-Za-z]/)
    .withMessage(`${label} must contain at least one letter.`)
    .matches(/[0-9]/)
    .withMessage(`${label} must contain at least one number.`),
];

const emailRule = (field = 'email') =>
  body(field)
    .exists({ checkNull: true })
    .withMessage('email is required.')
    .bail()
    .isString()
    .withMessage('email must be a string.')
    .bail()
    .trim()
    .isEmail()
    .withMessage('email must be a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false })
    .isLength({ max: 254 })
    .withMessage('email must be at most 254 characters.');

const nameRule = (field = 'name') =>
  body(field)
    .exists({ checkNull: true })
    .withMessage('name is required.')
    .bail()
    .isString()
    .withMessage('name must be a string.')
    .bail()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('name must be between 2 and 100 characters.');

const phoneRule = (field = 'phone_number') =>
  body(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('phone_number must be a string.')
    .bail()
    .trim()
    .matches(/^\+?[0-9][0-9\s-]{5,19}$/)
    .withMessage(
      'phone_number must be 6-20 characters of digits, optionally prefixed with + and separated by spaces or hyphens.'
    );

const signupRules = [nameRule(), emailRule(), phoneRule(), ...passwordRules('password')];

const loginRules = [
  emailRule(),

  // Deliberately only a presence check: applying the policy here would reject a
  // legacy password before it was ever compared, and would leak the policy to
  // anyone probing the endpoint.
  body('password')
    .exists({ checkNull: true })
    .withMessage('password is required.')
    .bail()
    .isString()
    .withMessage('password must be a string.')
    .bail()
    .notEmpty()
    .withMessage('password cannot be empty.'),
];

/**
 * A JWT is base64url text with two dots. Checking the shape here turns a
 * mangled or truncated token into a 400 that names the field, rather than a
 * bare 401 that a client cannot tell apart from an expired session.
 */
const refreshTokenRule = (field = 'refresh_token') =>
  body(field)
    .isString()
    .withMessage('refresh_token must be a string.')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('refresh_token cannot be empty.')
    .bail()
    .isLength({ max: 4096 })
    .withMessage('refresh_token is not a valid token.')
    .bail()
    .matches(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    .withMessage('refresh_token is not a valid token.');

const refreshRules = [
  body('refresh_token').exists({ checkNull: true }).withMessage('refresh_token is required.').bail(),
  refreshTokenRule(),
];

const logoutRules = [
  // Declared first so the sanitiser has run by the time the rule below reads it.
  body('all')
    .optional()
    .isBoolean()
    .withMessage('all must be a boolean.')
    .bail()
    .toBoolean(),

  // Signing out one device needs to know which one. Signing out everywhere does
  // not, so `all: true` excuses the token — otherwise a user whose phone was
  // stolen could not revoke it from the laptop they still have.
  body('refresh_token')
    .if((_value, { req }) => req.body?.all !== true)
    .exists({ checkNull: true })
    .withMessage('refresh_token is required, unless you send all: true to sign out everywhere.'),

  refreshTokenRule().optional(),
];

const changePasswordRules = [
  body('current_password')
    .exists({ checkNull: true })
    .withMessage('current_password is required.')
    .bail()
    .isString()
    .withMessage('current_password must be a string.')
    .bail()
    .notEmpty()
    .withMessage('current_password cannot be empty.'),

  ...passwordRules('new_password'),

  body('new_password')
    .custom((value, { req }) => {
      if (value === req.body.current_password) {
        throw new Error('new_password must be different from current_password.');
      }
      return true;
    }),
];

module.exports = {
  signupRules,
  loginRules,
  refreshRules,
  logoutRules,
  changePasswordRules,
  passwordRules,
  emailRule,
  nameRule,
  phoneRule,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
};
