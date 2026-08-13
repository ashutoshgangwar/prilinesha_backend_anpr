const VehicleLog = require('../models/VehicleLog');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { saveEventImages, removeFiles } = require('../utils/imageStorage');
const { encodeCursor, decodeCursor } = require('../utils/feedCursor');
const { resolveVehicleStatus, statusOf } = require('./vehicleService');
const { touchDevice } = require('./projectService');
const {
  DEFAULT_VEHICLE_TYPE,
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
const createAnprEvent = async (payload, { project, requestId } = {}) => {
  const log = logger.child({ requestId, transaction_id: payload.transaction_id });

  // The project the API key belongs to wins over anything in the body. A key
  // scoped to ACME_MALL cannot write into BLUE_FACTORY by putting a different
  // group_id in its payload — that is the whole point of a per-project key.
  const groupId = project ? project.group_id : payload.group_id ?? null;

  log.info('Processing ANPR event', {
    group_id: groupId,
    device_name: payload.device_name,
    cam_id: payload.cam_id,
    vehicle_number: payload.vehicle_number || null,
  });

  // 1. Reject a replayed delivery before doing any expensive work. Scoped to
  //    the project, because transaction_id is only unique within the Intozi
  //    deployment that produced it.
  const existing = await VehicleLog.findOne({
    group_id: groupId,
    transaction_id: payload.transaction_id,
  })
    .select('_id')
    .lean();

  if (existing) {
    log.warn('Duplicate transaction_id rejected', { existingId: String(existing._id) });
    throw AppError.conflict(`An event with transaction_id ${payload.transaction_id} already exists.`);
  }

  // 2. Decide registered/unregistered from this project's dashboard registry.
  //    Judged at detection time, not at read time, so the stored event is an
  //    honest record of what the vehicle's status was when it was seen — a
  //    registration expiring tomorrow cannot rewrite today's detections.
  //    An unknown plate falls back to whatever the camera claimed.
  const registryStatus = await resolveVehicleStatus(
    payload.vehicle_number ?? null,
    payload.created_datetime,
    { groupId, deviceName: payload.device_name }
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
      group_id: groupId,
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

    // Keep the project's device list current. Deliberately not awaited into the
    // response path's failure modes: this is bookkeeping, and an event that is
    // already safely stored must not be reported as failed because a device
    // list could not be updated.
    if (project) {
      await touchDevice(project, payload.device_name, { requestId });
    }

    return {
      id: String(record._id),
      group_id: record.group_id,
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
 * Shapes one registration into the record Intozi expects.
 *
 * The fields that go out are exactly FEED_DISCLOSED_FIELDS: the plate, the
 * project, whether it is currently registered, and the gates that holds at.
 * Everything else on the record — the owner's name, their phone number, who
 * registered it — is internal and never leaves the dashboard. Building the
 * object literally, rather than deleting fields from the document, means a
 * column added to the registry later cannot leak by default.
 *
 * The gates are disclosed because `vehicle_type` alone is not a barrier
 * decision: a registration restricted to `entry1` is `registered` here and must
 * still be refused at `exit2`. Prilinesha applies that rule itself when it
 * stamps an incoming event (see resolveVehicleStatus), but a poller acting on
 * the feed has no way to apply it without the list.
 *
 * The list goes out exactly as stored — no "valid everywhere" flag is derived
 * here. The dashboard resolves the operator's gate selection when the vehicle
 * is registered (`all_devices: true` is expanded to every active gate by name,
 * see resolveDeviceNames), so what a consumer receives is already the explicit
 * set of gates and needs no second rule to interpret it.
 *
 * @param {object} record Lean RegisteredVehicle document.
 * @param {Date} now      Instant to judge `valid_till` against.
 */
const toFeedRecord = (record, now) => {
  const deviceNames = record.device_names ?? [];

  return {
    vehicle_number: record.vehicle_number ?? null,
    group_id: record.group_id ?? null,
    // Derived, never stored, from the same two fields the dashboard reads: the
    // moment valid_till passes the plate reads as unregistered without anyone
    // flipping a flag, and a registration switched off on the dashboard reads as
    // unregistered here on the very next poll.
    vehicle_type: record.valid_till ? statusOf(record, now) : DEFAULT_VEHICLE_TYPE,
    // The gates this registration is good for, exactly as the dashboard stored
    // them. The frontend resolves "all gates" into the full list at
    // registration time, so this is the complete set — not a restriction to be
    // read against a wildcard.
    device_names: [...deviceNames],
  };
};

/**
 * Reads the vehicle list consumed by the Intozi server every 5-10 seconds.
 *
 * The source is the dashboard's registered-vehicle registry, not the detection
 * log: Intozi asks "which plates do you know about, and are they current?", so
 * every registered vehicle appears whether or not a camera has ever seen it.
 * `vehicle_type` is computed per row from `valid_till` at read time.
 *
 * Paging is keyset-based over (updatedAt, _id) ascending: hand the returned
 * `next_cursor` back on the following poll and you get every registration
 * created or renewed since — exactly once, with no gaps or repeats. An offset
 * would drift as rows are added between two polls. A renewal moves the row to
 * the end of the ordering, so it is re-sent with its new status; that is
 * deliberate, since a poller holding the old status needs to learn about it.
 *
 * A first call with no cursor returns the *oldest* page and reports `has_more`
 * until the registry is drained — a caller starting fresh must receive every
 * plate, not just recent ones.
 *
 * The feed is scoped by `scopeFilter`: a per-project API key can only ever walk
 * its own project's registrations, so a key leaked from one site cannot be used
 * to read another customer's plates. Only the legacy global key reads across
 * projects, which is why every row names its own `group_id`.
 *
 * @param {object} [params]
 * @param {string} [params.cursor]       Opaque cursor from a previous response.
 * @param {Date}   [params.since]        Return rows changed strictly after this instant.
 * @param {number} [params.limit]        Page size (default 100, max 1000).
 * @param {string} [params.vehicleType]  Restrict to 'registered' or 'unregistered'.
 * @param {object} [scopeFilter]         group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]   Correlation id for logging.
 * @returns {Promise<{ records: object[], count: number, next_cursor: string|null, has_more: boolean }>}
 * @throws {AppError} 400 when the cursor is malformed.
 */
const getVehicleFeed = async (
  { cursor, since, limit, vehicleType } = {},
  scopeFilter = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });
  const pageSize = Math.min(Number(limit) || FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);

  // One instant for the whole page, so two rows expiring in the same millisecond
  // cannot disagree with each other.
  const now = new Date();

  const filter = { ...scopeFilter };

  // Status is derived, not stored, so filtering by it compares the date and the
  // manual switch rather than matching a column. Both halves must hold for
  // registered; either failing is enough for unregistered.
  if (vehicleType === 'registered') {
    filter.is_active = { $ne: false };
    filter.valid_till = { $gte: now };
  } else if (vehicleType === 'unregistered') {
    filter.$and = [{ $or: [{ is_active: false }, { valid_till: { $lt: now } }] }];
  }

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
      { updatedAt: { $gt: position.receivedAt } },
      { updatedAt: position.receivedAt, _id: { $gt: position.id } },
    ];
  } else if (since) {
    filter.updatedAt = { $gt: since };
  }

  // is_active is read but never emitted — it feeds vehicle_type, which is the
  // only form the feed discloses it in. Everything else here goes out as-is.
  const projection = 'vehicle_number group_id valid_till is_active device_names updatedAt';

  // Always oldest-first, including the very first call.
  //
  // The detection feed this replaced started a cold caller at the newest page,
  // because replaying months of old sightings helps nobody. A registry is the
  // opposite: a caller with no cursor is asking "what do you know about?", and
  // anything skipped is a plate they will never be told about. So the first
  // page is the oldest, and `has_more` walks the caller through the rest.
  const documents = await RegisteredVehicle.find(filter)
    .select(projection)
    .sort({ updatedAt: 1, _id: 1 })
    .limit(pageSize + 1) // one extra row answers has_more without a second query
    .lean();

  const hasMore = documents.length > pageSize;
  const page = hasMore ? documents.slice(0, pageSize) : documents;

  const last = page[page.length - 1];

  log.info('Intozi feed served', {
    count: page.length,
    has_more: hasMore,
    cursor: cursor || null,
    scope: scopeFilter.group_id ?? 'all',
  });

  return {
    records: page.map((record) => toFeedRecord(record, now)),
    count: page.length,
    // Keep the previous cursor alive on an empty poll so the caller never has
    // to remember it themselves.
    next_cursor: last ? encodeCursor({ received_at: last.updatedAt, _id: last._id }) : cursor || null,
    has_more: hasMore,
  };
};

module.exports = { createAnprEvent, getVehicleFeed };
