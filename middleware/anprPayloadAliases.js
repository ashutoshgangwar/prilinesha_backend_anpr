const logger = require('../utils/logger');
const { looksLikeBase64Payload } = require('../utils/imageStorage');

/**
 * Vendor key aliases for POST /api.
 *
 * The Intozi edge software names several fields differently from this API's
 * canonical model (`plate` for the licence plate, `frame`/`plate_roi` for the
 * two images, `vehicle_category` for the registration status). Rather than
 * teaching every validator, service and schema a second vocabulary, the
 * incoming body is translated here — once, before validation — so everything
 * downstream keeps working with one set of names.
 *
 * The canonical key always wins: an alias is only read when the canonical field
 * was not sent, so a camera already posting `vehicle_number` is unaffected.
 *
 * The translation is then undone on the way out (see toSenderVocabulary), so a
 * sender reads its own field names back in the response and never has to learn
 * ours to interpret it.
 */

/** canonical field -> accepted aliases, in priority order. */
const ALIASES = {
  vehicle_number: ['plate', 'plate_number', 'license_plate'],
  vehicle_type: ['vehicle_category', 'vehicle_status'],
  event_image: ['frame'],
  plate_image: ['plate_roi'],
};

/** Fields whose value is a base64 image, so a sentinel string is not one. */
const IMAGE_FIELDS = new Set(['event_image', 'plate_image']);

const isMissing = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const normalizeAnprPayloadAliases = (req, _res, next) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return next();

  // canonical -> the alias this sender used for it. Read back by the controller
  // to answer in the vocabulary the request arrived in.
  req.anprAliases = {};

  Object.entries(ALIASES).forEach(([canonical, aliases]) => {
    const alias = aliases.find((candidate) => !isMissing(body[candidate]));
    if (!alias) return;

    const value = body[alias];
    delete body[alias];

    // Recorded even when the value below is discarded: the sender named the
    // field, so the response is owed that name whether an image arrived or not.
    if (isMissing(body[canonical])) req.anprAliases[canonical] = alias;

    // The sender uses these image keys unconditionally and fills them with a
    // human-readable sentinel ("No frame found") when the camera produced no
    // image. Treating that as image data would fail the whole event on a
    // detail the event does not depend on, so anything that could not decode
    // is dropped the same way an omitted image is.
    if (IMAGE_FIELDS.has(canonical) && !looksLikeBase64Payload(value)) return;

    if (isMissing(body[canonical])) body[canonical] = value;
  });

  if (Object.keys(req.anprAliases).length > 0) {
    logger.child({ requestId: req.id }).info('Mapped vendor payload keys', req.anprAliases);
  }

  return next();
};

/**
 * Renames the response body back into the vocabulary the request used.
 *
 * A canonical field is renamed to the alias the sender chose for it, and a
 * derived `<field>_path` key follows its field — so `event_image` sent as
 * `frame` is reported as `frame_path`. Fields the sender named canonically, and
 * every field with no alias at all, are left exactly as they were: an existing
 * consumer sees a byte-identical response.
 *
 * @param {object} data       Response payload in canonical names.
 * @param {object} [aliases]  canonical -> alias, as recorded on the request.
 * @returns {object} The same data with sender-facing key names.
 */
const toSenderVocabulary = (data, aliases) => {
  if (!data || !aliases || Object.keys(aliases).length === 0) return data;

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (aliases[key]) return [aliases[key], value];

      const pathField = key.endsWith('_path') ? key.slice(0, -'_path'.length) : null;
      if (pathField && aliases[pathField]) return [`${aliases[pathField]}_path`, value];

      return [key, value];
    })
  );
};

/** The name this API prefers to answer with when asked for a field's alias. */
const preferredAlias = (canonical) => (ALIASES[canonical] || [canonical])[0];

/**
 * The vocabulary GET /api/feed switches to for `?keys=intozi`.
 *
 * The feed has no request body to infer a vocabulary from, so the caller asks
 * for one. Only the two fields that have an alias are renamed — `group_id`,
 * `device_names` and `event_type` are named the same in both vocabularies.
 */
const FEED_VENDOR_VOCABULARY = {
  vehicle_number: preferredAlias('vehicle_number'),
  vehicle_type: preferredAlias('vehicle_type'),
};

module.exports = normalizeAnprPayloadAliases;
module.exports.toSenderVocabulary = toSenderVocabulary;
module.exports.ALIASES = ALIASES;
module.exports.FEED_VENDOR_VOCABULARY = FEED_VENDOR_VOCABULARY;
