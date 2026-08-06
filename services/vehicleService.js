const RegisteredVehicle = require('../models/RegisteredVehicle');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { REGISTRY_DEFAULT_LIMIT, REGISTRY_MAX_LIMIT } = require('../utils/constants');

/**
 * Registered-vehicle registry — the internal dashboard's side of the system.
 *
 * Registration status is never stored: it is derived from `valid_till` on every
 * read. A record cannot go stale, and no cron job is needed to expire anything.
 */

/** Milliseconds in a day, used for the countdown shown in the dashboard. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Escapes a user-supplied search term so it is matched literally.
 * Without this, input like `.*` or `(a+)+` becomes an expensive regex.
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {Date} validTill
 * @param {Date} at
 * @returns {'registered'|'unregistered'} Status at the given instant.
 */
const statusAt = (validTill, at) =>
  new Date(validTill).getTime() >= at.getTime() ? 'registered' : 'unregistered';

/**
 * Shapes a stored registration for the dashboard table.
 * Unlike the Intozi feed, this view discloses everything — it is internal.
 */
const toDashboardRecord = (record, now) => {
  const validTill = new Date(record.valid_till);
  const status = statusAt(validTill, now);

  return {
    id: String(record._id),
    vehicle_number: record.vehicle_number,
    name: record.name,
    phone_number: record.phone_number,
    valid_till: validTill,
    status,
    // Negative once expired, so the UI can show "expired 3 days ago" without
    // recomputing anything.
    days_remaining: Math.ceil((validTill.getTime() - now.getTime()) / DAY_MS),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
};

/**
 * Registers a vehicle, or renews one that is already on the registry.
 *
 * A plate is unique, so re-submitting it from the dashboard updates the holder
 * and extends `valid_till` rather than failing — that is what renewing an
 * expired vehicle means in practice, and it keeps one row per plate.
 *
 * @param {object} payload Validated body: vehicle_number, name, phone_number, valid_till.
 * @param {object} [context]
 * @param {string} [context.requestId] Correlation id for logging.
 * @returns {Promise<{ vehicle: object, created: boolean }>}
 */
const registerVehicle = async (payload, { requestId } = {}) => {
  const log = logger.child({ requestId, vehicle_number: payload.vehicle_number });
  const now = new Date();

  try {
    const existing = await RegisteredVehicle.findOne({ vehicle_number: payload.vehicle_number })
      .select('_id')
      .lean();

    const record = await RegisteredVehicle.findOneAndUpdate(
      { vehicle_number: payload.vehicle_number },
      {
        $set: {
          name: payload.name,
          phone_number: payload.phone_number,
          valid_till: payload.valid_till,
        },
        $setOnInsert: { vehicle_number: payload.vehicle_number },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    const created = !existing;

    log.info(created ? 'Vehicle registered' : 'Vehicle registration renewed', {
      id: String(record._id),
      valid_till: record.valid_till,
    });

    return { vehicle: toDashboardRecord(record, now), created };
  } catch (error) {
    // Two dashboard submissions of the same plate can race past the upsert.
    // The unique index is the authority; the loser simply retries the read.
    if (error.code === 11000) {
      const record = await RegisteredVehicle.findOne({
        vehicle_number: payload.vehicle_number,
      }).lean();

      if (record) return { vehicle: toDashboardRecord(record, now), created: false };

      throw AppError.conflict(`${payload.vehicle_number} is already registered.`);
    }

    log.error('Failed to register vehicle', { error: error.message });
    throw error;
  }
};

/**
 * Lists registrations for the dashboard table.
 *
 * Offset paging (page/limit + total) is deliberate here: a dashboard needs page
 * numbers and a row count. The Intozi feed uses a cursor instead, because it
 * needs exactly-once delivery rather than random access.
 *
 * @param {object} [params]
 * @param {string} [params.search] Matches vehicle number, name or phone (partial, case-insensitive).
 * @param {string} [params.status] 'registered' | 'unregistered' — evaluated against valid_till now.
 * @param {number} [params.page]   1-based page number (default 1).
 * @param {number} [params.limit]  Rows per page (default 25, max 200).
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listVehicles = async ({ search, status, page, limit } = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });
  const now = new Date();

  const pageSize = Math.min(Number(limit) || REGISTRY_DEFAULT_LIMIT, REGISTRY_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = {};

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ vehicle_number: term }, { name: term }, { phone_number: term }];
  }

  // Status is a function of valid_till, so it filters on the date directly —
  // there is no stored flag that could disagree with it.
  if (status === 'registered') filter.valid_till = { $gte: now };
  if (status === 'unregistered') filter.valid_till = { $lt: now };

  const [documents, total] = await Promise.all([
    RegisteredVehicle.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    RegisteredVehicle.countDocuments(filter),
  ]);

  log.info('Vehicle registry listed', { count: documents.length, total, page: currentPage });

  return {
    records: documents.map((record) => toDashboardRecord(record, now)),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize) || 0,
      has_next: currentPage * pageSize < total,
      has_previous: currentPage > 1,
    },
  };
};

/**
 * Resolves the registration status of a detected plate — the bridge between
 * this registry and the Intozi feed.
 *
 * @param {string|null} vehicleNumber Plate read by the camera.
 * @param {Date} at                   Instant to judge validity at (detection time).
 * @returns {Promise<'registered'|'unregistered'|null>} null when the plate is
 *          unknown to the registry, so the caller can decide the fallback.
 */
const resolveVehicleStatus = async (vehicleNumber, at) => {
  if (!vehicleNumber) return null;

  const record = await RegisteredVehicle.findOne({ vehicle_number: vehicleNumber })
    .select('valid_till')
    .lean();

  if (!record) return null;

  return statusAt(record.valid_till, at);
};

module.exports = { registerVehicle, listVehicles, resolveVehicleStatus };
