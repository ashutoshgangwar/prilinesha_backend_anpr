const RegisteredVehicle = require('../models/RegisteredVehicle');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { REGISTRY_DEFAULT_LIMIT, REGISTRY_MAX_LIMIT } = require('../utils/constants');

/**
 * Registered-vehicle registry — the internal dashboard's side of the system.
 *
 * Registration status is never stored: it is derived from `valid_till` on every
 * read. A record cannot go stale, and no cron job is needed to expire anything.
 *
 * Every operation here is scoped to a project (`group_id`). A plate registered
 * under ACME_MALL says nothing about the same plate arriving at BLUE_FACTORY —
 * the two registries are independent, and no query in this file runs without a
 * group_id filter.
 */

/** Milliseconds in a day, used for the countdown shown in the dashboard. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields of a `registered_by` / `updated_by` reference this view exposes. */
const ACTOR_FIELDS = 'name email';

/**
 * Shapes a populated user reference for the "who added this?" column.
 *
 * Returns a bare id string when the reference was not populated, and null when
 * there is none — rows created before the field existed, or by the bootstrap.
 * Only name and email go out; the rest of the user document is nobody's
 * business on a vehicle row.
 */
const toActorSummary = (actor) => {
  if (!actor) return null;
  if (!actor._id) return { id: String(actor), name: null, email: null };

  return {
    id: String(actor._id),
    name: actor.name ?? null,
    email: actor.email ?? null,
  };
};

/**
 * Escapes a user-supplied search term so it is matched literally.
 * Without this, input like `.*` or `(a+)+` becomes an expensive regex.
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {Date} validTill
 * @param {Date} at
 * @returns {'registered'|'unregistered'} Status at the given instant, ignoring
 *          the manual switch. Callers that care about what the barrier should
 *          do want `statusOf` instead.
 */
const statusAt = (validTill, at) =>
  new Date(validTill).getTime() >= at.getTime() ? 'registered' : 'unregistered';

/**
 * The status a registration actually has: in date **and** switched on.
 *
 * Single source of truth for the whole system — the dashboard table, the
 * ingestion-time decision and the Intozi feed all read status through here, so
 * a vehicle deactivated on the dashboard cannot still open a barrier.
 *
 * `is_active` is undefined on rows written before the field existed; those are
 * treated as active, which is what they were.
 *
 * @param {object} record Registration with valid_till and is_active.
 * @param {Date} at
 * @returns {'registered'|'unregistered'}
 */
const statusOf = (record, at) => {
  if (record.is_active === false) return 'unregistered';
  return statusAt(record.valid_till, at);
};

/**
 * Shapes a stored registration for the dashboard table.
 * Unlike the Intozi feed, this view discloses everything — it is internal.
 */
const toDashboardRecord = (record, now) => {
  const validTill = new Date(record.valid_till);
  const isActive = record.is_active !== false;

  return {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
    device_names: record.device_names ?? [],
    name: record.name,
    phone_number: record.phone_number,
    vehicle_model: record.vehicle_model ?? null,
    valid_till: validTill,

    // The manual switch, as set by a dashboard user.
    is_active: isActive,

    // What the barrier will actually do: expired **or** switched off reads as
    // unregistered.
    status: statusOf(record, now),

    // Why it is unregistered, so the UI can say "expired" and "deactivated"
    // differently instead of showing one ambiguous badge. Null while registered.
    inactive_reason: !isActive
      ? 'deactivated'
      : statusAt(validTill, now) === 'unregistered'
        ? 'expired'
        : null,

    // Negative once expired, so the UI can show "expired 3 days ago" without
    // recomputing anything. Still reported for a deactivated vehicle, since its
    // pass keeps running down while it is switched off.
    days_remaining: Math.ceil((validTill.getTime() - now.getTime()) / DAY_MS),

    // Who added it and who touched it last. Populated when the caller asked for
    // it; a bare id otherwise, and null on rows predating the field.
    registered_by: toActorSummary(record.registered_by),
    updated_by: toActorSummary(record.updated_by),

    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
};

/**
 * Registers a vehicle in one project, or renews one already on that project's
 * registry.
 *
 * A plate is unique *within a project*, so re-submitting it updates the holder
 * and extends `valid_till` rather than failing — that is what renewing an
 * expired vehicle means in practice, and it keeps one row per plate per project.
 *
 * A renewal also switches the registration back **on**. Submitting the
 * registration form is an explicit "this vehicle is allowed until X"; leaving it
 * deactivated would hand back a record that says registered and a barrier that
 * refuses to open. Use `PATCH /api/vehicles/:id/status` to suspend one.
 *
 * @param {object} payload Validated body: group_id, vehicle_number, name,
 *                         phone_number, valid_till, vehicle_model?, device_names?
 * @param {object} [context]
 * @param {object} [context.actor]     Dashboard user performing the action.
 * @param {string} [context.requestId] Correlation id for logging.
 * @returns {Promise<{ vehicle: object, created: boolean }>}
 */
const registerVehicle = async (payload, { actor, requestId } = {}) => {
  const log = logger.child({
    requestId,
    group_id: payload.group_id,
    vehicle_number: payload.vehicle_number,
  });
  const now = new Date();

  // The identity of a registration is the pair, never the plate alone.
  const identity = { group_id: payload.group_id, vehicle_number: payload.vehicle_number };

  try {
    const existing = await RegisteredVehicle.findOne(identity).select('_id').lean();

    const record = await RegisteredVehicle.findOneAndUpdate(
      identity,
      {
        $set: {
          name: payload.name,
          phone_number: payload.phone_number,
          valid_till: payload.valid_till,
          device_names: payload.device_names ?? [],
          is_active: true,
          updated_by: actor ? actor._id : null,

          // Only written when supplied, so renewing a vehicle without re-typing
          // the model keeps the one already recorded. The required fields above
          // are always present, so they have no such question; this one is
          // optional, and silently wiping optional data because somebody did
          // not repeat it is how a registry loses information.
          ...(payload.vehicle_model !== undefined
            ? { vehicle_model: payload.vehicle_model || null }
            : {}),
        },
        // Only on first insert, so a renewal by someone else does not rewrite
        // who originally added the vehicle.
        $setOnInsert: { ...identity, registered_by: actor ? actor._id : null },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    )
      .populate('registered_by updated_by', ACTOR_FIELDS)
      .lean();

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
      const record = await RegisteredVehicle.findOne(identity)
        .populate('registered_by updated_by', ACTOR_FIELDS)
        .lean();

      if (record) return { vehicle: toDashboardRecord(record, now), created: false };

      throw AppError.conflict(
        `${payload.vehicle_number} is already registered in ${payload.group_id}.`
      );
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
 * @param {string} [params.search]     Matches vehicle number, name or phone (partial, case-insensitive).
 * @param {string} [params.status]     'registered' | 'unregistered' — the effective status, so
 *                                     a deactivated vehicle counts as unregistered whatever
 *                                     its valid_till says.
 * @param {boolean} [params.isActive]  Filter on the manual switch alone, to answer
 *                                     "which vehicles have we suspended?" — a question
 *                                     `status` cannot express, since it folds expiry in.
 * @param {string} [params.registeredBy] Only vehicles added by this user id.
 * @param {number} [params.page]       1-based page number (default 1).
 * @param {number} [params.limit]      Rows per page (default 25, max 200).
 * @param {object} scopeFilter     group_id fragment from buildScopeFilter() — the
 *                                 tenant boundary. Passing `{}` reads every
 *                                 project and is only ever produced for a super
 *                                 admin; a customer admin with no assignments
 *                                 gets `{ $in: [] }` and correctly sees nothing.
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listVehicles = async (
  { search, status, isActive, registeredBy, page, limit } = {},
  scopeFilter = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });
  const now = new Date();

  const pageSize = Math.min(Number(limit) || REGISTRY_DEFAULT_LIMIT, REGISTRY_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = { ...scopeFilter };

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    // The columns this table shows, so a match is always visible on the row
    // that came back.
    filter.$or = [
      { vehicle_number: term },
      { name: term },
      { phone_number: term },
      { vehicle_model: term },
    ];
  }

  if (isActive !== undefined && isActive !== null) {
    // `$ne: false` rather than `true`, so rows written before is_active existed
    // — where the field is simply absent — count as active, which is what they
    // are everywhere else in this file.
    filter.is_active = isActive ? { $ne: false } : false;
  }

  if (registeredBy) filter.registered_by = registeredBy;

  // Status is derived, never stored: registered means switched on AND in date,
  // so it filters on those two directly. There is no status column that could
  // drift out of step with them.
  //
  // Both branches go through $and rather than assigning fields, so combining
  // `status` with `is_active` intersects the two instead of one quietly
  // overwriting the other — `?status=registered&is_active=false` is a
  // contradiction and must return nothing, not the registered rows.
  if (status === 'registered') {
    filter.$and = [
      ...(filter.$and ?? []),
      { is_active: { $ne: false } },
      { valid_till: { $gte: now } },
    ];
  }

  if (status === 'unregistered') {
    // Either half failing is enough. $or, not a single clause, because the two
    // reasons are independent — an in-date vehicle can be switched off, and an
    // expired one can still be switched on.
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: [{ is_active: false }, { valid_till: { $lt: now } }] },
    ];
  }

  const [documents, total] = await Promise.all([
    RegisteredVehicle.find(filter)
      .populate('registered_by updated_by', ACTOR_FIELDS)
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
 * Loads one registration, but only if the caller may see it.
 *
 * The scope filter is folded into the query rather than checked afterwards, so
 * a vehicle in someone else's project is a 404, not a 403. An object id is
 * opaque and guessable in bulk; answering "that exists, but it is not yours"
 * would confirm which ids are real, and for whom.
 *
 * @param {string} id
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [options]
 * @param {boolean} [options.lean] Return a plain object rather than a document.
 * @returns {Promise<object>}
 * @throws {AppError} 404 when it does not exist or is out of scope.
 */
const findVehicleInScope = async (id, scopeFilter = {}, { lean = true } = {}) => {
  const query = RegisteredVehicle.findOne({ _id: id, ...scopeFilter });

  if (lean) query.populate('registered_by updated_by', ACTOR_FIELDS).lean();

  const record = await query;

  if (!record) throw AppError.notFound('No such vehicle in your projects.');

  return record;
};

/**
 * One registration, for the dashboard's detail view.
 *
 * @param {string} id
 * @param {object} scopeFilter
 * @returns {Promise<object>}
 * @throws {AppError} 404 when it does not exist or is out of scope.
 */
const getVehicle = async (id, scopeFilter = {}) => {
  const record = await findVehicleInScope(id, scopeFilter);
  return toDashboardRecord(record, new Date());
};

/**
 * Edits a registration in place.
 *
 * Only the fields present in the payload change — this is a PATCH, so omitting
 * `device_names` leaves the gate list alone rather than clearing it. Sending an
 * explicit `[]` is how you widen a restricted registration back to every gate.
 *
 * `group_id` and `vehicle_number` are deliberately not editable. Together they
 * are the row's identity and its unique index; changing either is registering a
 * different vehicle, which is what POST is for. Editing them here would also
 * let a customer admin move a record into a project they cannot see.
 *
 * @param {string} id
 * @param {object} payload Validated: name?, phone_number?, vehicle_model?,
 *                         valid_till?, device_names?, is_active?
 * @param {object} scopeFilter
 * @param {object} [context]
 * @param {object} [context.actor]
 * @param {string} [context.requestId]
 * @returns {Promise<object>}
 * @throws {AppError} 404 out of scope, 400 when the payload changes nothing.
 */
const updateVehicle = async (id, payload, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await findVehicleInScope(id, scopeFilter, { lean: false });

  const log = logger.child({
    requestId,
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  });

  const updatable = [
    'name',
    'phone_number',
    'vehicle_model',
    'valid_till',
    'device_names',
    'is_active',
  ];
  const changed = updatable.filter((field) => payload[field] !== undefined);

  if (!changed.length) {
    throw AppError.badRequest('Nothing to update.', [
      {
        field: 'body',
        message: `Send at least one of: ${updatable.join(', ')}.`,
      },
    ]);
  }

  changed.forEach((field) => {
    record[field] = payload[field];
  });

  record.updated_by = actor ? actor._id : null;
  await record.save();

  log.info('Vehicle registration updated', { id: String(record._id), fields: changed });

  const populated = await RegisteredVehicle.findById(record._id)
    .populate('registered_by updated_by', ACTOR_FIELDS)
    .lean();

  return toDashboardRecord(populated, new Date());
};

/**
 * Switches a registration on or off.
 *
 * This is the manual half of the status: deactivating reports the plate as
 * unregistered at every gate immediately, whatever `valid_till` says, and the
 * change is live on Intozi's next poll — the feed derives status from the same
 * two fields, so there is nothing to synchronise.
 *
 * Deactivating is not deleting. The record, its history and its `valid_till`
 * survive, so a suspension can be lifted without re-keying anything.
 *
 * @param {string} id
 * @param {boolean} isActive
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<object>}
 * @throws {AppError} 404 when it does not exist or is out of scope.
 */
const setVehicleStatus = async (id, isActive, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await findVehicleInScope(id, scopeFilter, { lean: false });

  const log = logger.child({
    requestId,
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  });

  record.is_active = isActive;
  record.updated_by = actor ? actor._id : null;
  await record.save();

  log.info(isActive ? 'Vehicle registration activated' : 'Vehicle registration deactivated', {
    id: String(record._id),
    by: actor ? String(actor._id) : 'system',
  });

  const populated = await RegisteredVehicle.findById(record._id)
    .populate('registered_by updated_by', ACTOR_FIELDS)
    .lean();

  return toDashboardRecord(populated, new Date());
};

/**
 * Removes a registration outright.
 *
 * Prefer deactivating: a deleted row loses who registered it and when, and the
 * plate simply becomes unknown to the project — indistinguishable from one that
 * was never registered. Deleting is right for a record entered by mistake, not
 * for a resident who moved out.
 *
 * Detections already logged are untouched: VehicleLog stores the status as
 * judged at detection time, not a reference to this row, so the history of what
 * the barrier did stays intact.
 *
 * @param {string} id
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<{ id: string, group_id: string, vehicle_number: string }>}
 * @throws {AppError} 404 when it does not exist or is out of scope.
 */
const deleteVehicle = async (id, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await RegisteredVehicle.findOneAndDelete({ _id: id, ...scopeFilter }).lean();

  if (!record) throw AppError.notFound('No such vehicle in your projects.');

  logger.child({ requestId }).warn('Vehicle registration deleted', {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
    by: actor ? String(actor._id) : 'system',
  });

  return {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  };
};

/**
 * Resolves the registration status of a detected plate — the bridge between
 * this registry and the Intozi feed.
 *
 * The lookup is scoped to the project the camera belongs to, so a vehicle
 * registered at one customer's site is a stranger at another's. A camera that
 * posted without a group_id (legacy global key) has no registry to consult and
 * gets null, leaving the fallback to the caller.
 *
 * A registration limited to specific `device_names` only counts at those gates;
 * an empty list means every gate in the project, which is the common case.
 *
 * @param {string|null} vehicleNumber Plate read by the camera.
 * @param {Date} at                   Instant to judge validity at (detection time).
 * @param {object} [options]
 * @param {string|null} [options.groupId]    Project the detection belongs to.
 * @param {string|null} [options.deviceName] Gate the detection came from.
 * @returns {Promise<'registered'|'unregistered'|null>} null when the plate is
 *          unknown to this project's registry, so the caller can decide the
 *          fallback.
 */
const resolveVehicleStatus = async (vehicleNumber, at, { groupId, deviceName } = {}) => {
  if (!vehicleNumber || !groupId) return null;

  const record = await RegisteredVehicle.findOne({
    group_id: String(groupId).trim().toUpperCase(),
    vehicle_number: vehicleNumber,
  })
    .select('valid_till device_names is_active')
    .lean();

  if (!record) return null;

  // Switched off on the dashboard: unregistered at every gate, whatever the
  // dates or the gate list say. Checked before them so a suspension cannot be
  // undone by a still-valid pass.
  if (record.is_active === false) return 'unregistered';

  const restrictedTo = record.device_names ?? [];

  if (restrictedTo.length && deviceName) {
    const allowed = restrictedTo.some(
      (name) => name.toLowerCase() === String(deviceName).trim().toLowerCase()
    );
    // Registered, but not at this gate — treated exactly like an unregistered
    // vehicle, which is what the barrier should do.
    if (!allowed) return 'unregistered';
  }

  return statusAt(record.valid_till, at);
};

module.exports = {
  registerVehicle,
  listVehicles,
  getVehicle,
  updateVehicle,
  setVehicleStatus,
  deleteVehicle,
  resolveVehicleStatus,
  statusAt,
  statusOf,
  toDashboardRecord,
};
