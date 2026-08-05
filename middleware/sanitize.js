/**
 * Input sanitizer.
 *
 * Strips NoSQL-operator injection vectors (`$gt`, dotted paths) from every
 * incoming object and trims stray whitespace from strings. Mutates in place so
 * it works on Express' read-only `req.query` getter as well.
 */

const MAX_DEPTH = 8;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Buffer.isBuffer(value);

const sanitizeValue = (value, depth) => {
  if (typeof value === 'string') return value.trim();
  if (!isPlainObject(value) || depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      value[index] = sanitizeValue(item, depth + 1);
    });
    return value;
  }

  Object.keys(value).forEach((key) => {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor') {
      delete value[key];
      return;
    }
    value[key] = sanitizeValue(value[key], depth + 1);
  });

  return value;
};

module.exports = function sanitize(req, _res, next) {
  ['body', 'query', 'params'].forEach((source) => {
    if (isPlainObject(req[source])) sanitizeValue(req[source], 0);
  });
  next();
};
