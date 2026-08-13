const VehicleLog = require('../models/VehicleLog');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { saveEventImages, removeFiles } = require('../utils/imageStorage');
const { resolveVehicleStatus } = require('./vehicleService');
const { resolveVisitorStatus } = require('./visitorService');
const { readChanges } = require('./accessChangeService');
const { touchDevice } = require('./projectService');
const { DEFAULT_VEHICLE_TYPE } = require('../utils/constants');

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
  //    A plate can be known to this project in two ways — a permanent
  //    registration, or a visitor pass open right now — so both are asked, and
  //    a `registered` from either is enough. Being on one list does not make a
  //    vehicle less allowed for being absent from the other: a former resident
  //    whose registration lapsed but who holds an afternoon's pass must get in.
  const [registryStatus, visitorStatus] = await Promise.all([
    resolveVehicleStatus(payload.vehicle_number ?? null, payload.created_datetime, {
      groupId,
      deviceName: payload.device_name,
    }),
    resolveVisitorStatus(payload.vehicle_number ?? null, payload.created_datetime, {
      groupId,
      deviceName: payload.device_name,
    }),
  ]);

  // null from both means the plate is unknown to this project entirely, and only
  // then does the camera's own claim get a say.
  const knownStatus =
    registryStatus === 'registered' || visitorStatus === 'registered'
      ? 'registered'
      : registryStatus ?? visitorStatus;

  const vehicleType = knownStatus ?? payload.vehicle_type ?? DEFAULT_VEHICLE_TYPE;

  log.info('Registration status resolved', {
    vehicle_type: vehicleType,
    registry: registryStatus,
    visitor: visitorStatus,
    source: knownStatus
      ? visitorStatus === 'registered' && registryStatus !== 'registered'
        ? 'visitor-pass'
        : 'registry'
      : 'payload-or-default',
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
 * Reads the change feed consumed by the Intozi server every 5-10 seconds.
 *
 * ## What this returns
 *
 * Changes, not vehicles. Each row says what happened to one plate — CREATED,
 * UPDATED, SUSPENDED, REVOKED, EXPIRED, DELETED — together with the access state
 * that leaves it in and the gates it holds at. Intozi keeps its own allow-list
 * and applies each row to it.
 *
 * This replaced a feed that returned the vehicle list itself. That version could
 * not survive the registry growing: every poll, every 5-10 seconds, read rows
 * proportional to the number of vehicles rather than to the number of things
 * that had actually changed. With several lakh registrations that is a scan on a
 * loop. Here a quiet minute costs an indexed lookup that matches nothing.
 *
 * It also fixes two states the old feed could never express:
 *
 *   expiry  — the clock passing valid_till writes nothing to the row, so no
 *             cursor over the vehicle collections could carry it. It is now
 *             published by jobs/accessSweeper.js, which is where the whole
 *             argument is written out.
 *   deletion — a hard-deleted row leaves nothing behind to describe. The write
 *             paths now leave a DELETED tombstone in the log instead.
 *
 * ## Cursor
 *
 * A keyset over (changed_at, _id) — see readChanges in accessChangeService, and
 * the compound index it is served by. Send the previous response's `next_cursor`
 * back and you get every change since, exactly once, in order. Re-sending the
 * same cursor returns the same page, so a consumer that fails to apply a page
 * simply asks for it again; the cursor only ever moves when the consumer says it
 * has processed one.
 *
 * A first call with no cursor replays the log from the beginning, which for a
 * cold consumer is how it builds its list — see scripts/seedAccessChanges.js,
 * which puts a CREATED row in the log for every vehicle that predates it.
 *
 * ## Scope
 *
 * `scopeFilter` is the same `group_id` fragment every other read in this system
 * uses, applied unchanged: a per-project API key can only ever walk its own
 * project's changes, and a change from one customer can never appear in
 * another's feed. Only the legacy global key reads across projects, which is why
 * every row still names its own `group_id`.
 *
 * @param {object} [params]
 * @param {string} [params.cursor]      Opaque cursor from a previous response.
 * @param {Date}   [params.since]       Cold start from an instant. Ignored when cursor is sent.
 * @param {number} [params.limit]       Page size (default 100, max 1000).
 * @param {string} [params.vehicleType] Restrict to changes resulting in this state.
 *                                      Discouraged — filtering a change feed by
 *                                      outcome hides the events that take access
 *                                      away. Kept for query-contract compatibility.
 * @param {object} [scopeFilter]        group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{records: object[], count: number, next_cursor: string|null,
 *                    has_more: boolean, resync_required: boolean}>}
 * @throws {AppError} 400 when the cursor is malformed.
 */
const getVehicleFeed = async (params = {}, scopeFilter = {}, context = {}) =>
  readChanges(params, scopeFilter, context);

module.exports = { createAnprEvent, getVehicleFeed };
