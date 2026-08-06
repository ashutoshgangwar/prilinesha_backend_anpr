const VehicleLog = require('../models/VehicleLog');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { saveEventImages, removeFiles } = require('../utils/imageStorage');
const { encodeCursor, decodeCursor } = require('../utils/feedCursor');
const { resolveVehicleStatus } = require('./vehicleService');
const {
  DEFAULT_VEHICLE_TYPE,
  FEED_MASKED_FIELDS,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
} = require('../utils/constants');

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
 * @returns {Promise<{ id: string, transaction_id: number, vehicle_number: string|null,
 *                     vehicle_type: string, event_image_path: string, plate_image_path: string }>}
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

  // 2. Decide registered/unregistered from the dashboard registry.
  //    Judged at detection time, not at read time, so the stored event is an
  //    honest record of what the vehicle's status was when it was seen — a
  //    registration expiring tomorrow cannot rewrite today's detections.
  //    An unknown plate falls back to whatever the camera claimed.
  const registryStatus = await resolveVehicleStatus(
    payload.vehicle_number ?? null,
    payload.created_datetime
  );

  const vehicleType = registryStatus ?? payload.vehicle_type ?? DEFAULT_VEHICLE_TYPE;

  log.info('Registration status resolved', {
    vehicle_type: vehicleType,
    source: registryStatus ? 'registry' : 'payload-or-default',
  });

  // 3. Persist whichever images were sent — both are optional.
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

  // 4. Insert the record, discarding the images if the write fails.
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
      vehicle_type: vehicleType,
      vehicle_model: payload.vehicle_model ?? null,
      owner_name: payload.owner_name ?? null,
      contact_no: payload.contact_no ?? null,
      email: payload.email ?? null,
      driver_name: payload.driver_name ?? null,
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
      vehicle_number: record.vehicle_number,
      vehicle_type: record.vehicle_type,
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

/**
 * Shapes one stored event into the record Intozi expects.
 *
 * Only the vehicle number and the registered/unregistered status are disclosed;
 * every field in FEED_MASKED_FIELDS is reported as null even when the database
 * holds a value for it. The key order matches the agreed contract.
 *
 * @param {object} record Lean VehicleLog document.
 */
const toFeedRecord = (record) => {
  const feedRecord = {
    owner_name: null,
    created_datetime: null,
    contact_no: null,
    email: null,
    driver_name: null,
    vehicle_model: null,
    vehicle_type: record.vehicle_type ?? DEFAULT_VEHICLE_TYPE,
    vehicle_number: record.vehicle_number ?? null,
  };

  // Guard against a future contributor "helpfully" un-masking a field: anything
  // listed as masked is forced back to null on the way out.
  FEED_MASKED_FIELDS.forEach((field) => {
    feedRecord[field] = null;
  });

  return feedRecord;
};

/**
 * Reads the polling feed consumed by the Intozi server every 5-10 seconds.
 *
 * Paging is keyset-based over (received_at, _id) ascending: hand the returned
 * `next_cursor` back on the following poll and you get every event ingested
 * since — exactly once, with no gaps or repeats, however many rows were written
 * in between. An offset would drift under concurrent inserts.
 *
 * A first call with no cursor and no `since` returns the newest `limit` events,
 * so a cold start does not replay the entire history.
 *
 * @param {object} [params]
 * @param {string} [params.cursor]       Opaque cursor from a previous response.
 * @param {Date}   [params.since]        Return events received strictly after this instant.
 * @param {number} [params.limit]        Page size (default 100, max 1000).
 * @param {string} [params.vehicleType]  Restrict to 'registered' or 'unregistered'.
 * @param {object} [context]
 * @param {string} [context.requestId]   Correlation id for logging.
 * @returns {Promise<{ records: object[], count: number, next_cursor: string|null, has_more: boolean }>}
 * @throws {AppError} 400 when the cursor is malformed.
 */
const getVehicleFeed = async (
  { cursor, since, limit, vehicleType } = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });
  const pageSize = Math.min(Number(limit) || FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);

  const filter = {};
  if (vehicleType) filter.vehicle_type = vehicleType;

  let position = null;

  if (cursor) {
    position = decodeCursor(cursor);
    if (!position) {
      throw AppError.badRequest('cursor is not a valid feed cursor.', [
        { field: 'cursor', message: 'Send the next_cursor value returned by a previous response.' },
      ]);
    }

    // Strictly after the cursor: same millisecond is disambiguated by _id.
    filter.$or = [
      { received_at: { $gt: position.receivedAt } },
      { received_at: position.receivedAt, _id: { $gt: position.id } },
    ];
  } else if (since) {
    filter.received_at = { $gt: since };
  }

  const projection = 'vehicle_number vehicle_type received_at';

  // No cursor and no `since` means a cold start: take the newest page from the
  // tail and flip it, so the caller still receives it oldest-first.
  const coldStart = !position && !since;

  const documents = await VehicleLog.find(filter)
    .select(projection)
    .sort(coldStart ? { received_at: -1, _id: -1 } : { received_at: 1, _id: 1 })
    .limit(pageSize + 1) // one extra row answers has_more without a second query
    .lean();

  const hasMore = documents.length > pageSize;
  const page = hasMore ? documents.slice(0, pageSize) : documents;

  if (coldStart) page.reverse();

  const last = page[page.length - 1];

  log.info('Intozi feed served', {
    count: page.length,
    has_more: coldStart ? false : hasMore,
    cursor: cursor || null,
  });

  return {
    records: page.map(toFeedRecord),
    count: page.length,
    // Keep the previous cursor alive on an empty poll so the caller never has
    // to remember it themselves.
    next_cursor: last ? encodeCursor(last) : cursor || null,
    // On a cold start the extra row is older than the page, not newer.
    has_more: coldStart ? false : hasMore,
  };
};

module.exports = { createAnprEvent, getVehicleFeed };
