const VehicleLog = require('../models/VehicleLog');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { saveEventImages, removeFiles } = require('../utils/imageStorage');

/**
 * ANPR business logic.
 *
 * Owns the full ingestion workflow: duplicate detection, image persistence,
 * database insertion and rollback. It receives an already-validated payload and
 * never touches req/res — the controller adapts HTTP to this API.
 */

/**
 * @param {object} payload Validated ANPR event.
 * @param {object} [context]
 * @param {string} [context.requestId] Correlation id for logging.
 * @returns {Promise<{ id: string, transaction_id: number, event_image_path: string, plate_image_path: string }>}
 * @throws {AppError} 409 when transaction_id was already ingested.
 */
const createAnprEvent = async (payload, { requestId } = {}) => {
  const log = logger.child({ requestId, transaction_id: payload.transaction_id });

  log.info('Processing ANPR event', {
    device_name: payload.device_name,
    cam_id: payload.cam_id,
    vehicle_number: payload.vehicle_number || null,
  });

  // 1. Reject a replayed delivery before doing any expensive work.
  const existing = await VehicleLog.findOne({ transaction_id: payload.transaction_id })
    .select('_id')
    .lean();

  if (existing) {
    log.warn('Duplicate transaction_id rejected', { existingId: String(existing._id) });
    throw AppError.conflict(`An event with transaction_id ${payload.transaction_id} already exists.`);
  }

  // 2. Persist whichever images were sent — both are optional.
  //    Rolls itself back on partial failure.
  const images = await saveEventImages({
    eventImage: payload.event_image,
    plateImage: payload.plate_image,
    transactionId: payload.transaction_id,
  });

  const eventImagePath = images.event ? images.event.relativePath : null;
  const plateImagePath = images.plate ? images.plate.relativePath : null;

  log.info('Images stored', {
    event_image_path: eventImagePath,
    plate_image_path: plateImagePath,
    event_image_bytes: images.event ? images.event.bytes : 0,
    plate_image_bytes: images.plate ? images.plate.bytes : 0,
  });

  // 3. Insert the record, discarding the images if the write fails.
  try {
    const record = await VehicleLog.create({
      application_name: payload.application_name,
      application_id: payload.application_id,
      device_name: payload.device_name,
      device_unique_key: payload.device_unique_key,
      group_id: payload.group_id ?? null,
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      cam_id: payload.cam_id,
      transaction_id: payload.transaction_id,
      vehicle_number: payload.vehicle_number ?? null,
      vehicle_class: payload.vehicle_class ?? null,
      color: payload.color ?? null,
      triple_riding: payload.triple_riding ?? false,
      no_helmet: payload.no_helmet ?? false,
      no_seatbelt: payload.no_seatbelt ?? false,
      driver_on_call_status: payload.driver_on_call_status ?? false,
      event_image_path: eventImagePath,
      plate_image_path: plateImagePath,
      created_datetime: payload.created_datetime,
      received_at: new Date(),
    });

    log.info('ANPR event stored', { id: String(record._id) });

    return {
      id: String(record._id),
      transaction_id: record.transaction_id,
      event_image_path: record.event_image_path,
      plate_image_path: record.plate_image_path,
    };
  } catch (error) {
    await removeFiles([images.event?.absolutePath, images.plate?.absolutePath]);

    // Two concurrent deliveries of the same event race past the check above;
    // the unique index is the authority.
    if (error.code === 11000) {
      log.warn('Duplicate transaction_id rejected by unique index');
      throw AppError.conflict(`An event with transaction_id ${payload.transaction_id} already exists.`);
    }

    log.error('Failed to store ANPR event', { error: error.message });
    throw error;
  }
};

module.exports = { createAnprEvent };
