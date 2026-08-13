const RegisteredVehicle = require('../models/RegisteredVehicle');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { resolveDeviceNames, resolveOccupantType, listScopedGates } = require('./projectService');
const { recordChange } = require('./accessChangeService');
const {
  VEHICLE_TYPES,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_MAX_LIMIT,
  RESIDENT_OCCUPANT_TYPES,
  ACCESS_EVENT_TYPES,
  ACCESS_CHANGE_SOURCES,
} = require('../utils/constants');

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

/**
 * The window the filter-options endpoint reports an "expiring soon" count over,
 * and the value a dashboard should send back as `expiring_in_days` when the
 * operator clicks that chip. A month is roughly how much notice a resident needs
 * to renew; the filter itself takes any number, so this is only the default.
 */
const EXPIRING_SOON_DAYS = 30;

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

    // What the holder is to this site — `resident` in a society, `tenant` in a
    // parking project. Null on rows registered before the field existed, or
    // under a project that never stated its type.
    occupant_type: record.occupant_type ?? null,
    unit_number: record.unit_number ?? null,

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
 * Writes one registration's change to the feed's log.
 *
 * Every write path below calls this after its own save has succeeded, so the
 * event describes something that actually happened. The resulting access state
 * is computed with the same `statusOf` the dashboard and the ingestion path use,
 * so the log can never disagree with them about what a row means.
 *
 * @param {object} record   The saved registration (document or lean).
 * @param {string} eventType One of ACCESS_EVENT_TYPES.
 * @param {object} [context]
 */
const emitRegistrationChange = (record, eventType, { requestId } = {}) =>
  recordChange(
    {
      groupId: record.group_id,
      vehicleNumber: record.vehicle_number,
      eventType,
      // DELETED describes a row that no longer exists: whatever its dates said a
      // moment ago, the only correct instruction now is "stop letting it in".
      vehicleType:
        eventType === ACCESS_EVENT_TYPES.DELETED ? 'unregistered' : statusOf(record, new Date()),
      deviceNames: eventType === ACCESS_EVENT_TYPES.DELETED ? [] : record.device_names ?? [],
      source: ACCESS_CHANGE_SOURCES.REGISTRATION,
      sourceId: record._id,
    },
    { requestId }
  );

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
 * The gate selection is resolved against the project before anything is
 * written — see resolveDeviceNames. `all_devices: true` is stored as every
 * active gate by name, a list is checked to be real gates and rewritten to their
 * stored casing, and omitting both stores `[]`, which means every gate.
 *
 * @param {object} payload Validated body: group_id, vehicle_number, name,
 *                         phone_number, valid_till, vehicle_model?,
 *                         device_names?, all_devices?
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

  // Before the upsert, so an unknown gate name fails the request rather than
  // being stored as a restriction no camera can ever satisfy. `undefined` back
  // means neither field was sent, which on a create is the "every gate" default.
  const deviceNames =
    (await resolveDeviceNames(payload.group_id, {
      deviceNames: payload.device_names,
      allDevices: payload.all_devices,
    })) ?? [];

  // `resident` or `tenant`, according to what kind of site this project is.
  // Also before the upsert: sending the wrong one for the site type is a 400,
  // not a row that quietly disagrees with its own project. `undefined` back
  // means neither the caller nor the project had an answer.
  const occupantType = await resolveOccupantType(payload.group_id, payload.occupant_type);

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
          device_names: deviceNames,
          is_active: true,
          updated_by: actor ? actor._id : null,

          // Re-arms expiry. A renewal pushes valid_till into the future, so the
          // EXPIRED change already reported for the previous term must be
          // forgotten — otherwise the sweeper would never report the new one.
          expiry_emitted_at: null,

          // Only written when supplied, so renewing a vehicle without re-typing
          // the model keeps the one already recorded. The required fields above
          // are always present, so they have no such question; this one is
          // optional, and silently wiping optional data because somebody did
          // not repeat it is how a registry loses information.
          ...(payload.vehicle_model !== undefined
            ? { vehicle_model: payload.vehicle_model || null }
            : {}),

          // Same rule for the two fields below, and the same reason: written
          // only when there is something to write, so renewing a vehicle
          // without re-typing its flat number keeps the one on record.
          ...(occupantType !== undefined ? { occupant_type: occupantType } : {}),
          ...(payload.unit_number !== undefined
            ? { unit_number: payload.unit_number || null }
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

    // CREATED the first time this plate is known to the project, UPDATED on a
    // renewal — Intozi applies both the same way (add or replace), but the
    // distinction is what lets an operator read the log.
    await emitRegistrationChange(
      record,
      created ? ACCESS_EVENT_TYPES.CREATED : ACCESS_EVENT_TYPES.UPDATED,
      { requestId }
    );

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
 * @param {string} [params.occupantType] 'resident' | 'tenant' — the "residents" tab
 *                                     of the table. Rows registered before the field
 *                                     existed have none and are excluded by it.
 * @param {boolean} [params.isActive]  Filter on the manual switch alone, to answer
 *                                     "which vehicles have we suspended?" — a question
 *                                     `status` cannot express, since it folds expiry in.
 * @param {string} [params.registeredBy] Only vehicles added by this user id.
 * @param {string} [params.deviceName] Registrations that count at this gate — which
 *                                     includes every unrestricted one, since an empty
 *                                     `device_names` means every gate in the project.
 * @param {Date}   [params.validFrom]  Passes expiring at or after this instant.
 * @param {Date}   [params.validTo]    Passes expiring at or before this instant.
 * @param {number} [params.expiringInDays] Shorthand for the renewals queue: still switched
 *                                     on, and lapsing within this many days.
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
  {
    search,
    status,
    occupantType,
    isActive,
    registeredBy,
    deviceName,
    validFrom,
    validTo,
    expiringInDays,
    page,
    limit,
  } = {},
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
      { unit_number: term },
    ];
  }

  if (occupantType) filter.occupant_type = occupantType;

  if (isActive !== undefined && isActive !== null) {
    // `$ne: false` rather than `true`, so rows written before is_active existed
    // — where the field is simply absent — count as active, which is what they
    // are everywhere else in this file.
    filter.is_active = isActive ? { $ne: false } : false;
  }

  if (registeredBy) filter.registered_by = registeredBy;

  // "Who may come through this gate?" — the question a guard on one entrance
  // asks. An empty `device_names` is the wildcard meaning every gate in the
  // project, so those registrations count here too: they are valid at this gate,
  // they simply were not written down gate by gate.
  if (deviceName) {
    const gate = new RegExp(`^${escapeRegex(deviceName)}$`, 'i');
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: [{ device_names: { $size: 0 } }, { device_names: gate }] },
    ];
  }

  // A window on the expiry date itself — "which passes run out this month?".
  // Independent of `status`, which only asks whether the date has already
  // passed.
  if (validFrom || validTo) {
    filter.$and = [
      ...(filter.$and ?? []),
      {
        valid_till: {
          ...(validFrom ? { $gte: validFrom } : {}),
          ...(validTo ? { $lte: validTo } : {}),
        },
      },
    ];
  }

  // The renewals queue, as one parameter. Deliberately excludes the already
  // expired (the window starts at `now`) and the deactivated: a vehicle that is
  // switched off is not waiting on a renewal, it is waiting on a decision.
  if (expiringInDays !== undefined && expiringInDays !== null) {
    const until = new Date(now.getTime() + Number(expiringInDays) * DAY_MS);
    filter.$and = [
      ...(filter.$and ?? []),
      { is_active: { $ne: false } },
      { valid_till: { $gte: now, $lte: until } },
    ];
  }

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
 * Everything the registry's filter bar can offer, for the caller's scope.
 *
 * The list endpoint accepts filters; this says which values are worth sending —
 * the projects and gates that exist, the operators who have actually registered
 * something, and how many rows sit behind each status chip. A dashboard that
 * had to discover those by paging the registry would go stale the day a gate is
 * added or a colleague joins.
 *
 * The counts partition the registry exactly: registered + expired + deactivated
 * = total, with `unregistered` being the last two added up. That is the same
 * decomposition `status` and `is_active` filter on, so a chip's number always
 * matches the table it opens.
 *
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<object>}
 */
const listVehicleFilters = async (scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });
  const now = new Date();
  const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY_MS);

  // Same `$ne: false` as everywhere else in this file: rows written before
  // is_active existed count as active, which is what they are.
  const switchedOn = { is_active: { $ne: false } };

  const [gates, total, registered, expired, deactivated, expiringSoon, occupantCounts, actorIds] =
    await Promise.all([
      listScopedGates(scopeFilter),
      RegisteredVehicle.countDocuments(scopeFilter),
      RegisteredVehicle.countDocuments({ ...scopeFilter, ...switchedOn, valid_till: { $gte: now } }),
      RegisteredVehicle.countDocuments({ ...scopeFilter, ...switchedOn, valid_till: { $lt: now } }),
      RegisteredVehicle.countDocuments({ ...scopeFilter, is_active: false }),
      RegisteredVehicle.countDocuments({
        ...scopeFilter,
        ...switchedOn,
        valid_till: { $gte: now, $lte: soon },
      }),
      // The "residents" / "tenants" chips. One grouped pass rather than a count
      // per kind, so adding a third occupant kind later costs no extra query.
      RegisteredVehicle.aggregate([
        { $match: scopeFilter },
        { $group: { _id: '$occupant_type', count: { $sum: 1 } } },
      ]),
      // Only operators who have registered something in this scope, so the
      // dropdown is the handful of people whose names appear in the table rather
      // than every account on the system.
      RegisteredVehicle.distinct('registered_by', scopeFilter),
    ]);

  const ids = actorIds.filter(Boolean);

  const actors = ids.length
    ? await User.find({ _id: { $in: ids } })
        .select('name email')
        .sort({ name: 1 })
        .lean()
    : [];

  log.info('Vehicle registry filters listed', {
    projects: gates.projects.length,
    devices: gates.device_names.length,
    total,
  });

  // Keyed by kind, with a zero for any kind nobody has registered yet — a chip
  // that vanishes when its count hits zero is a filter an operator cannot find
  // again. `unspecified` is the rows predating the field, reported rather than
  // hidden so the numbers still add up to `total`.
  const byOccupantType = Object.fromEntries(RESIDENT_OCCUPANT_TYPES.map((kind) => [kind, 0]));
  let unspecifiedOccupants = 0;

  occupantCounts.forEach(({ _id: kind, count }) => {
    if (kind && kind in byOccupantType) byOccupantType[kind] = count;
    else unspecifiedOccupants += count;
  });

  return {
    projects: gates.projects,
    device_names: gates.device_names,
    statuses: [...VEHICLE_TYPES],

    // What the "resident / tenant" filter can offer. Both kinds are always
    // listed: which one a given project uses is decided by its project_type, and
    // a scope covering several projects can legitimately hold both.
    occupant_types: [...RESIDENT_OCCUPANT_TYPES],

    registered_by: actors.map((actor) => ({
      id: String(actor._id),
      name: actor.name ?? null,
      email: actor.email ?? null,
    })),

    counts: {
      total,
      registered,
      unregistered: expired + deactivated,
      // The two reasons a vehicle reads as unregistered, kept apart because the
      // dashboard shows them as different badges and they are fixed differently:
      // one needs renewing, the other switching back on.
      expired,
      deactivated,

      // A second, independent partition of the same rows — by who the holder
      // is rather than by whether their pass is current. These also sum to
      // `total`, `unspecified` included.
      by_occupant_type: { ...byOccupantType, unspecified: unspecifiedOccupants },
    },

    // Send `expiring_in_days=<within_days>` to open exactly these rows.
    expiring_soon: { within_days: EXPIRING_SOON_DAYS, count: expiringSoon },

    paging: { default_limit: REGISTRY_DEFAULT_LIMIT, max_limit: REGISTRY_MAX_LIMIT },
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
 * explicit `[]` is how you widen a restricted registration back to every gate,
 * and `all_devices: true` widens it to every gate the project has *by name*.
 *
 * A gate list sent here is checked against the vehicle's own project, not
 * against one named in the body — `group_id` is not editable, so there is only
 * ever one project a gate could belong to.
 *
 * `group_id` and `vehicle_number` are deliberately not editable. Together they
 * are the row's identity and its unique index; changing either is registering a
 * different vehicle, which is what POST is for. Editing them here would also
 * let a customer admin move a record into a project they cannot see.
 *
 * @param {string} id
 * @param {object} payload Validated: name?, phone_number?, vehicle_model?,
 *                         valid_till?, device_names?, all_devices?, is_active?
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

  // Resolved onto `device_names` so the rest of this function sees one field.
  // `all_devices` on its own is a real edit — it becomes the project's gate
  // list — so this runs before the "nothing to update" check below.
  const resolved = await resolveDeviceNames(record.group_id, {
    deviceNames: payload.device_names,
    allDevices: payload.all_devices,
  });

  if (resolved !== undefined) payload.device_names = resolved;

  // Checked against the vehicle's own project — `group_id` is not editable, so
  // there is only ever one project whose type could answer this. Only when the
  // caller actually sent one: a PATCH that says nothing about the occupant kind
  // must not have the project's default written over what is already there.
  if (payload.occupant_type !== undefined) {
    payload.occupant_type = await resolveOccupantType(record.group_id, payload.occupant_type);
  }

  const updatable = [
    'name',
    'phone_number',
    'vehicle_model',
    'occupant_type',
    'unit_number',
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

  // Extending (or shortening) the term re-arms expiry: the new valid_till has
  // not been reported yet, whatever was reported about the old one.
  if (changed.includes('valid_till')) record.expiry_emitted_at = null;

  record.updated_by = actor ? actor._id : null;
  await record.save();

  log.info('Vehicle registration updated', { id: String(record._id), fields: changed });

  // An edit that switches the registration off is a suspension, and Intozi has
  // to treat it as "stop letting this vehicle in" rather than as an update it
  // can merge. The resulting vehicle_type says so too, but the event type is
  // what makes it unambiguous in the log.
  await emitRegistrationChange(
    record,
    changed.includes('is_active') && record.is_active === false
      ? ACCESS_EVENT_TYPES.SUSPENDED
      : ACCESS_EVENT_TYPES.UPDATED,
    { requestId }
  );

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

  // Switching off is a suspension; switching back on is an update that restores
  // access, and carries the current gate list so Intozi can re-add it correctly.
  await emitRegistrationChange(
    record,
    isActive ? ACCESS_EVENT_TYPES.UPDATED : ACCESS_EVENT_TYPES.SUSPENDED,
    { requestId }
  );

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

  // The tombstone, and the only reason a hard delete is survivable at all: the
  // row is gone, so nothing else could ever tell Intozi to drop the plate from
  // its allow-list. Without this the vehicle would keep opening barriers on the
  // strength of a record that no longer exists.
  await emitRegistrationChange(record, ACCESS_EVENT_TYPES.DELETED, { requestId });

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
  listVehicleFilters,
  getVehicle,
  updateVehicle,
  setVehicleStatus,
  deleteVehicle,
  resolveVehicleStatus,
  statusAt,
  statusOf,
  toDashboardRecord,
};
