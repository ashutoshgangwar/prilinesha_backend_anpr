/**
 * Domain constants shared by validators, the Mongoose model and Swagger docs.
 * Single source of truth — never re-declare these lists elsewhere.
 */

const VEHICLE_CLASSES = ['bus', 'car', 'bike', 'truck', 'auto'];

const VEHICLE_COLORS = ['White', 'Gray', 'Yellow', 'Red', 'Green', 'Blue', 'Black'];

/** Registration status of the detected vehicle, as exposed on the Intozi feed. */
const VEHICLE_TYPES = ['registered', 'unregistered'];

/** A vehicle is treated as unregistered until it is positively known otherwise. */
const DEFAULT_VEHICLE_TYPE = 'unregistered';

/**
 * Fields the Intozi feed (GET /api/anpr/feed) must always report as null, even
 * when the database holds a value. Intozi consumes only the vehicle number and
 * the registered/unregistered status; everything else is intentionally withheld.
 */
const FEED_MASKED_FIELDS = [
  'owner_name',
  'created_datetime',
  'contact_no',
  'email',
  'driver_name',
  'vehicle_model',
];

/** Paging limits for the Intozi polling feed. */
const FEED_DEFAULT_LIMIT = 100;
const FEED_MAX_LIMIT = 1000;

const IMAGE_KIND = {
  EVENT: 'event',
  PLATE: 'plate',
};

/** Sub-directory (relative to UPLOAD_DIR) each image kind is written to. */
const IMAGE_DIRECTORIES = {
  [IMAGE_KIND.EVENT]: 'event-images',
  [IMAGE_KIND.PLATE]: 'plate-images',
};

module.exports = {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  DEFAULT_VEHICLE_TYPE,
  FEED_MASKED_FIELDS,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  IMAGE_KIND,
  IMAGE_DIRECTORIES,
};
