/**
 * Domain constants shared by validators, the Mongoose model and Swagger docs.
 * Single source of truth — never re-declare these lists elsewhere.
 */

const VEHICLE_CLASSES = ['bus', 'car', 'bike', 'truck', 'auto'];

const VEHICLE_COLORS = ['White', 'Gray', 'Yellow', 'Red', 'Green', 'Blue', 'Black'];

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
  IMAGE_KIND,
  IMAGE_DIRECTORIES,
};
