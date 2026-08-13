const { query } = require('express-validator');

/**
 * Date-window rules shared by every dashboard table that filters on a range.
 *
 * The detection log filters on when a vehicle was seen and the registry filters
 * on when a pass expires, but an operator types the same thing into both — a
 * bare date, or an ISO timestamp — and expects it to mean the same thing. Kept
 * here rather than copied per validator so the two cannot drift apart on the one
 * detail that is easy to get wrong: which end of the day a bare date lands on.
 */

/**
 * Parses one boundary of a `from` / `to` window.
 *
 * A bare date means the whole of that day, so `to=2026-08-07` includes the 7th
 * rather than stopping at midnight — an operator asking for "up to the 7th"
 * means the day, not the instant it began. Anything with a time is taken as
 * given, and a timestamp with no offset is UTC, matching the convention
 * `created_datetime` and `valid_till` are stored under.
 *
 * @param {'start'|'end'} edge Which end of the day a bare date expands to.
 */
const toInstant = (edge) => (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`);
  }

  const hasTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
};

/**
 * One optional boundary of a date window, parsed into a Date.
 *
 * @param {string} field Query parameter name.
 * @param {'start'|'end'} edge Which end of the day a bare date expands to.
 */
const dateQueryRule = (field, edge) =>
  query(field)
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage(`${field} must be a date (YYYY-MM-DD) or an ISO 8601 datetime.`)
    .bail()
    .trim()
    .isISO8601()
    .withMessage(`${field} must be a valid date (e.g. 2026-08-07) or ISO 8601 datetime.`)
    .bail()
    .customSanitizer(toInstant(edge))
    .custom((value) => {
      if (Number.isNaN(value.getTime())) throw new Error(`${field} is not a parsable date.`);
      return true;
    });

/**
 * Rejects a window that ends before it starts.
 *
 * Must be listed *after* both `dateQueryRule` calls for the same pair, so the
 * comparison is on the parsed Dates rather than on the raw strings.
 *
 * @param {string} fromField
 * @param {string} toField
 */
const orderedRangeRule = (fromField, toField) =>
  query(toField).custom((value, { req }) => {
    const from = req.query?.[fromField];
    if (value && from && value < from) {
      throw new Error(`${toField} must be the same as or after ${fromField}.`);
    }
    return true;
  });

/**
 * A complete `from`/`to` window: both boundaries plus the ordering check.
 *
 * @param {string} fromField
 * @param {string} toField
 * @returns {object[]} Rules, in the order they must run.
 */
const dateRangeRules = (fromField, toField) => [
  dateQueryRule(fromField, 'start'),
  dateQueryRule(toField, 'end'),
  orderedRangeRule(fromField, toField),
];

module.exports = { toInstant, dateQueryRule, orderedRangeRule, dateRangeRules };
