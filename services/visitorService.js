const Visitor = require('../models/Visitor');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { resolveDeviceNames, findProjectOrFail } = require('./projectService');
const { recordChange } = require('./accessChangeService');
const {
  VEHICLE_TYPES,
  VISITOR_DEFAULT_LIMIT,
  VISITOR_MAX_LIMIT,
  MAX_VISITOR_PASS_DAYS,
  occupantTypeForProjectType,
  ACCESS_EVENT_TYPES,
  ACCESS_CHANGE_SOURCES,
} = require('../utils/constants');

/**
 * Visitor passes — the temporary half of the access list.
 *
 * A pass is a plate, a host and a window. Its status is derived on every read
 * from the window and the manual switch, never stored, for the same reason the
 * registry derives its own: a stored `status` column would need a cron job to
 * flip the instant a pass ran out, and would silently disagree with the dates
 * the moment that job failed. Here, closing time takes care of itself.
 *
 * Everything is scoped to a project. A pass at ACME_MALL says nothing about the
 * same plate at BLUE_FACTORY, and no query in this file runs without a group_id
 * filter folded in.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields of an `issued_by` / `updated_by` reference this view exposes. */
const ACTOR_FIELDS = 'name email';

/** Fields copied onto a pass from the host's registration when one is linked. */
const HOST_FIELDS = 'group_id vehicle_number name phone_number occupant_type unit_number';

/**
 * Escapes a user-supplied search term so it is matched literally.
 * Without this, input like `.*` or `(a+)+` becomes an expensive regex.
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
 * Why a pass is not currently good, or null when it is.
 *
 * Three distinct answers, because they are three different situations and a UI
 * that showed one badge for all of them would be lying about two: a pass that
 * has not started yet is fine and simply early, an expired one did its job, and
 * a revoked one was taken away by a person.
 *
 * @param {object} record Pass with valid_from, valid_till and is_active.
 * @param {Date} at
 * @returns {'revoked'|'not_started'|'expired'|null}
 */
const inactiveReasonOf = (record, at) => {
  if (record.is_active === false) return 'revoked';

  const from = new Date(record.valid_from).getTime();
  const till = new Date(record.valid_till).getTime();
  const now = at.getTime();

  if (now < from) return 'not_started';
  if (now > till) return 'expired';

  return null;
};

/**
 * The status a pass actually has: inside its window **and** not revoked.
 *
 * Single source of truth for the dashboard table, the ingestion-time decision
 * and the Intozi feed, exactly as `statusOf` is for the registry — so a pass
 * revoked on the dashboard cannot still open a barrier anywhere.
 *
 * @param {object} record
 * @param {Date} at
 * @returns {'registered'|'unregistered'}
 */
const statusOf = (record, at) => (inactiveReasonOf(record, at) ? 'unregistered' : 'registered');

/**
 * The Mongo fragment matching passes that are live at `at`.
 *
 * Written once and reused by the list filter, the counts and the feed, because
 * three copies of "switched on and inside the window" is three chances for one
 * of them to disagree with the other two about a boundary.
 *
 * `$ne: false` on the switch, not `true`: a document written without the field
 * is active, which is what it is everywhere else here.
 */
const liveFilter = (at) => ({
  is_active: { $ne: false },
  valid_from: { $lte: at },
  valid_till: { $gte: at },
});

/** The complement of `liveFilter` — any one of the three reasons is enough. */
const notLiveFilter = (at) => ({
  $or: [{ is_active: false }, { valid_from: { $gt: at } }, { valid_till: { $lt: at } }],
});

/**
 * Shapes a stored pass for the dashboard table.
 * Internal view: unlike the Intozi feed, it discloses everything on the record.
 */
const toDashboardRecord = (record, now) => {
  const validFrom = new Date(record.valid_from);
  const validTill = new Date(record.valid_till);
  const reason = inactiveReasonOf(record, now);

  return {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,

    name: record.name,
    phone_number: record.phone_number ?? null,
    vehicle_model: record.vehicle_model ?? null,
    purpose: record.purpose ?? null,

    // Who they are here to see. `host_vehicle` is the resident's or tenant's own
    // registration when one was linked; the name, phone and unit are stored on
    // the pass itself, so they survive that registration being deleted.
    host: {
      type: record.host_type ?? null,
      vehicle_id: record.host_vehicle ? String(record.host_vehicle._id ?? record.host_vehicle) : null,
      vehicle_number: record.host_vehicle?.vehicle_number ?? null,
      name: record.host_name,
      phone_number: record.host_phone ?? null,
      unit_number: record.host_unit ?? null,
    },

    valid_from: validFrom,
    valid_till: validTill,
    device_names: record.device_names ?? [],

    // The manual switch, as set from the dashboard.
    is_active: record.is_active !== false,

    // What the barrier will actually do right now.
    status: statusOf(record, now),

    // Why it is unregistered, so the UI can tell "not yet" from "ran out" from
    // "we revoked it" instead of showing one ambiguous badge. Null while live.
    inactive_reason: reason,

    // Minutes, not days: a visitor pass is usually an afternoon, and a
    // countdown in days would read "0" for its entire useful life. Negative
    // once the window has closed, so "expired 20 minutes ago" needs no second
    // calculation. Null before the pass starts, where time remaining is not yet
    // a meaningful number.
    minutes_remaining:
      reason === 'not_started'
        ? null
        : Math.ceil((validTill.getTime() - now.getTime()) / 60000),

    // How long the whole pass runs for, so a table can show "4 hours" without
    // subtracting two timestamps in the browser.
    window_minutes: Math.round((validTill.getTime() - validFrom.getTime()) / 60000),

    issued_by: toActorSummary(record.issued_by),
    updated_by: toActorSummary(record.updated_by),

    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
};

/**
 * Writes one pass's change to the feed's log.
 *
 * The resulting access state comes from the same `statusOf` the dashboard and
 * the ingestion path read, so a pass issued for tomorrow is correctly logged as
 * `unregistered` — it exists, but it does not open anything yet. The sweeper
 * emits the UPDATED that flips it when its window actually opens.
 *
 * @param {object} record The saved pass.
 * @param {string} eventType
 * @param {object} [context]
 */
const emitVisitorChange = (record, eventType, { requestId } = {}) =>
  recordChange(
    {
      groupId: record.group_id,
      vehicleNumber: record.vehicle_number,
      eventType,
      vehicleType:
        eventType === ACCESS_EVENT_TYPES.DELETED ? 'unregistered' : statusOf(record, new Date()),
      deviceNames: eventType === ACCESS_EVENT_TYPES.DELETED ? [] : record.device_names ?? [],
      source: ACCESS_CHANGE_SOURCES.VISITOR,
      sourceId: record._id,
    },
    { requestId }
  );

/**
 * Resolves the host a pass is being issued on behalf of.
 *
 * Two ways to name one, and they are not alternatives so much as a preference:
 *
 *   host_vehicle_id — the resident's or tenant's own registration. Preferred,
 *                     because it links the visit to a row somebody maintains,
 *                     and their name, phone and flat number are copied from it
 *                     rather than re-typed (and mistyped) at the gate.
 *   host_name (+ unit, phone) — free text, for a host with no vehicle on the
 *                     registry at all. Plenty of flats own no car; refusing to
 *                     admit their visitors would be absurd.
 *
 * The linked registration must be in the same project. Checked, not assumed: a
 * pass whose host lives at another customer's site would be a cross-tenant
 * reference in a system whose entire boundary is the project.
 *
 * The copied fields are stored, not just referenced, so the pass still says who
 * admitted the vehicle after the host's registration is renewed under a new
 * name or deleted outright. A visit is a historical fact.
 *
 * @param {string} groupId       The project the pass belongs to.
 * @param {object} payload       Validated body.
 * @param {string|null} hostType 'resident' | 'tenant' | null, from the project type.
 * @returns {Promise<{host_vehicle: any, host_name: string, host_phone: string|null,
 *                    host_unit: string|null}>}
 * @throws {AppError} 400 when neither form of host was given · 404 when the
 *         named registration is not in this project.
 */
const resolveHost = async (groupId, payload, hostType) => {
  let host = null;

  if (payload.host_vehicle_id) {
    host = await RegisteredVehicle.findOne({ _id: payload.host_vehicle_id, group_id: groupId })
      .select(HOST_FIELDS)
      .lean();

    // Scoped in the query rather than checked after it, exactly as the
    // single-record vehicle routes do: "that host exists, but not in your
    // project" would confirm which ids are real in somebody else's tenant.
    if (!host) {
      throw AppError.notFound('No such resident or tenant vehicle in this project.');
    }

    // A host whose own registration says `tenant` in a project the type field
    // calls a society is a data problem, not a request problem — the pass takes
    // the host's word for it, since that row is the one a person maintains.
    if (host.occupant_type && host.occupant_type !== hostType) {
      logger.warn('Visitor host occupant_type disagrees with the project type', {
        group_id: groupId,
        host_id: String(host._id),
        host_occupant_type: host.occupant_type,
        project_occupant_type: hostType,
      });
    }
  }

  // Typed values win over the copied ones: an operator correcting a stale phone
  // number on the visitor form means the correction, not the registry's copy.
  const name = payload.host_name || host?.name || null;

  if (!name) {
    throw AppError.badRequest('A visitor pass needs a host.', [
      {
        field: 'host_name',
        message:
          'Send host_vehicle_id to link the resident’s or tenant’s own registration, or ' +
          'host_name for a host who has no vehicle on the registry.',
      },
    ]);
  }

  return {
    host_vehicle: host ? host._id : null,
    host_name: name,
    host_phone: payload.host_phone ?? host?.phone_number ?? null,
    host_unit: payload.host_unit ?? host?.unit_number ?? null,
  };
};

/**
 * Rejects a window that is backwards, or longer than a visit plausibly is.
 *
 * The ordering check is here rather than in the validator because it is a rule
 * about the record, and a PATCH can break it with one field: sending only
 * `valid_till` has to be compared against the `valid_from` already stored, which
 * no request-level rule can see.
 *
 * A pass that has already closed is *not* rejected. Recording a visit after the
 * fact is a real thing a gate desk does, and the pass simply reads as expired.
 *
 * @param {Date} validFrom
 * @param {Date} validTill
 * @throws {AppError} 400
 */
const assertWindow = (validFrom, validTill) => {
  if (validTill.getTime() <= validFrom.getTime()) {
    throw AppError.badRequest('The pass ends before it starts.', [
      { field: 'valid_till', message: 'valid_till must be after valid_from.' },
    ]);
  }

  const days = (validTill.getTime() - validFrom.getTime()) / DAY_MS;

  if (days > MAX_VISITOR_PASS_DAYS) {
    throw AppError.badRequest(
      `A visitor pass may not run for more than ${MAX_VISITOR_PASS_DAYS} days.`,
      [
        {
          field: 'valid_till',
          message:
            'Somebody who needs longer than that is not a visitor — register them on ' +
            'POST /api/vehicles instead, where the pass is reviewed when it is renewed.',
        },
      ]
    );
  }
};

/**
 * Refuses a pass for a plate that is already a live registration here.
 *
 * A resident does not need a visitor pass, and issuing one puts the same plate
 * in front of Intozi twice with two independent windows — at which point which
 * answer the barrier acts on depends on the order two feed rows happen to
 * arrive in. Better to say so than to let it become an intermittent gate fault.
 *
 * An *expired* or deactivated registration is no obstacle: a former resident
 * coming back for the afternoon is exactly what a visitor pass is for.
 *
 * @throws {AppError} 409
 */
const assertNotRegistered = async (groupId, vehicleNumber, at) => {
  const registered = await RegisteredVehicle.findOne({
    group_id: groupId,
    vehicle_number: vehicleNumber,
    is_active: { $ne: false },
    valid_till: { $gte: at },
  })
    .select('_id')
    .lean();

  if (registered) {
    throw AppError.conflict(
      `${vehicleNumber} already has a current registration in ${groupId}, so it does not need a visitor pass.`,
      [
        {
          field: 'vehicle_number',
          message:
            'Two live records for one plate would send Intozi two different answers for the ' +
            'same vehicle. Edit the registration instead, or let it lapse first.',
        },
      ]
    );
  }
};

/**
 * Refuses a second pass overlapping one this plate already holds here.
 *
 * Same reasoning as above, within this collection: two overlapping windows for
 * one plate are two feed rows disagreeing about whether the barrier should
 * open. Consecutive visits are fine and expected — it is only the overlap that
 * is ambiguous.
 *
 * @param {string} groupId
 * @param {string} vehicleNumber
 * @param {Date} validFrom
 * @param {Date} validTill
 * @param {any} [excludeId] The pass being edited, which cannot clash with itself.
 * @throws {AppError} 409
 */
const assertNoOverlap = async (groupId, vehicleNumber, validFrom, validTill, excludeId) => {
  // Two windows overlap when each starts before the other ends. Revoked passes
  // are excluded: they grant nothing, so they cannot conflict with anything.
  const clash = await Visitor.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    group_id: groupId,
    vehicle_number: vehicleNumber,
    is_active: { $ne: false },
    valid_from: { $lte: validTill },
    valid_till: { $gte: validFrom },
  })
    .select('_id valid_from valid_till')
    .lean();

  if (clash) {
    throw AppError.conflict(
      `${vehicleNumber} already holds a visitor pass here that overlaps this one.`,
      [
        {
          field: 'valid_from',
          message:
            `The existing pass runs from ${new Date(clash.valid_from).toISOString()} to ` +
            `${new Date(clash.valid_till).toISOString()}. Edit that pass, revoke it, or pick a ` +
            'window that starts after it ends.',
        },
      ]
    );
  }
};

/**
 * Issues a visitor pass.
 *
 * Unlike `POST /api/vehicles`, this never upserts. A plate visiting again is a
 * *new visit*, with its own host, its own window and its own place in the log of
 * who was let in — collapsing the two would overwrite the record of the first
 * one, which is the half of this collection that has any value after the fact.
 *
 * @param {object} payload Validated body: group_id, vehicle_number, name,
 *                         valid_from, valid_till, host_vehicle_id?, host_name?,
 *                         host_phone?, host_unit?, phone_number?, purpose?,
 *                         vehicle_model?, device_names?, all_devices?
 * @param {object} [context]
 * @param {object} [context.actor]     Dashboard user issuing the pass.
 * @param {string} [context.requestId]
 * @returns {Promise<object>} The pass, in dashboard shape.
 */
const createVisitor = async (payload, { actor, requestId } = {}) => {
  const log = logger.child({
    requestId,
    group_id: payload.group_id,
    vehicle_number: payload.vehicle_number,
  });

  const now = new Date();

  assertWindow(payload.valid_from, payload.valid_till);

  // The project decides the word for the host — `resident` in a society,
  // `tenant` in a parking project — so it is loaded before anything is written.
  const project = await findProjectOrFail(payload.group_id);
  const hostType = occupantTypeForProjectType(project.project_type);

  const [host, deviceNames] = await Promise.all([
    resolveHost(payload.group_id, payload, hostType),
    resolveDeviceNames(payload.group_id, {
      deviceNames: payload.device_names,
      allDevices: payload.all_devices,
    }).then((names) => names ?? []),
    assertNotRegistered(payload.group_id, payload.vehicle_number, now),
  ]);

  await assertNoOverlap(
    payload.group_id,
    payload.vehicle_number,
    payload.valid_from,
    payload.valid_till
  );

  const record = await Visitor.create({
    group_id: payload.group_id,
    vehicle_number: payload.vehicle_number,
    name: payload.name,
    phone_number: payload.phone_number ?? null,
    vehicle_model: payload.vehicle_model ?? null,
    purpose: payload.purpose ?? null,
    host_type: hostType,
    ...host,
    valid_from: payload.valid_from,
    valid_till: payload.valid_till,
    device_names: deviceNames,
    is_active: true,

    // A pass whose window is already open is announced as valid by the CREATED
    // change written below, so its activation is already reported and the
    // sweeper must not announce it again. One issued for later is left unmarked,
    // and the sweeper picks it up the moment valid_from arrives.
    activation_emitted_at: payload.valid_from <= now ? now : null,
    expiry_emitted_at: null,

    issued_by: actor ? actor._id : null,
    updated_by: actor ? actor._id : null,
  });

  log.info('Visitor pass issued', {
    id: String(record._id),
    host: host.host_name,
    valid_from: record.valid_from,
    valid_till: record.valid_till,
    by: actor ? String(actor._id) : 'system',
  });

  await emitVisitorChange(record, ACCESS_EVENT_TYPES.CREATED, { requestId });

  const populated = await Visitor.findById(record._id)
    .populate('issued_by updated_by', ACTOR_FIELDS)
    .populate('host_vehicle', 'vehicle_number')
    .lean();

  return toDashboardRecord(populated, new Date());
};

/**
 * Lists visitor passes for the dashboard table.
 *
 * Offset paging with a total, like the registry table and for the same reason:
 * a screen with page numbers needs a row count. Newest pass first, because the
 * question at a gate desk is almost always "who is on site now?".
 *
 * @param {object} [params]
 * @param {string}  [params.search]     Visitor name, plate, phone, host name or unit.
 * @param {string}  [params.status]     'registered' | 'unregistered' — the effective
 *                                      status, so a revoked pass counts as unregistered
 *                                      whatever its window says.
 * @param {boolean} [params.isActive]   The manual switch alone — "what have we revoked?",
 *                                      which `status` cannot express since it folds the
 *                                      window in.
 * @param {boolean} [params.onSite]     Live right now: switched on and inside its window.
 *                                      The same rows as `status=registered`, named for
 *                                      the question the gate desk actually asks.
 * @param {string}  [params.hostVehicleId] Passes issued for one resident or tenant.
 * @param {string}  [params.issuedBy]   Passes issued by one dashboard user.
 * @param {string}  [params.deviceName] Passes that count at this gate, wildcard included.
 * @param {Date}    [params.from]       Passes whose window ends at or after this instant.
 * @param {Date}    [params.to]         Passes whose window starts at or before it.
 *                                      Together: "which passes touch this period?".
 * @param {number}  [params.page]
 * @param {number}  [params.limit]
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listVisitors = async (
  {
    search,
    status,
    isActive,
    onSite,
    hostVehicleId,
    issuedBy,
    deviceName,
    from,
    to,
    page,
    limit,
  } = {},
  scopeFilter = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });
  const now = new Date();

  const pageSize = Math.min(Number(limit) || VISITOR_DEFAULT_LIMIT, VISITOR_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = { ...scopeFilter };

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    // The columns this table shows, so a match is always visible on the row that
    // came back — including the host's, because "who did Ramesh let in?" is
    // typed into the same box.
    filter.$or = [
      { vehicle_number: term },
      { name: term },
      { phone_number: term },
      { vehicle_model: term },
      { host_name: term },
      { host_unit: term },
      { purpose: term },
    ];
  }

  if (isActive !== undefined && isActive !== null) {
    filter.is_active = isActive ? { $ne: false } : false;
  }

  if (hostVehicleId) filter.host_vehicle = hostVehicleId;
  if (issuedBy) filter.issued_by = issuedBy;

  if (deviceName) {
    // An empty device_names is the wildcard meaning every gate, so those passes
    // are valid at this gate too — same rule as the registry's.
    const gate = new RegExp(`^${escapeRegex(deviceName)}$`, 'i');
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: [{ device_names: { $size: 0 } }, { device_names: gate }] },
    ];
  }

  // "Which passes touch this period?" — an overlap test, not a containment one.
  // A pass running 10:00-18:00 is part of the afternoon even though it did not
  // start in it, and a report that dropped it would be wrong about the afternoon.
  if (from || to) {
    filter.$and = [
      ...(filter.$and ?? []),
      ...(from ? [{ valid_till: { $gte: from } }] : []),
      ...(to ? [{ valid_from: { $lte: to } }] : []),
    ];
  }

  // Status is derived, never stored, so it filters on the window and the switch
  // directly. Both go through $and rather than assigning fields, so combining
  // `status` with `is_active` intersects them instead of one overwriting the
  // other — `status=registered&is_active=false` is a contradiction and must
  // return nothing.
  if (status === 'registered' || onSite === true) {
    filter.$and = [...(filter.$and ?? []), liveFilter(now)];
  }

  if (status === 'unregistered' || onSite === false) {
    filter.$and = [...(filter.$and ?? []), notLiveFilter(now)];
  }

  const [documents, total] = await Promise.all([
    Visitor.find(filter)
      .populate('issued_by updated_by', ACTOR_FIELDS)
      .populate('host_vehicle', 'vehicle_number')
      .sort({ createdAt: -1, _id: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Visitor.countDocuments(filter),
  ]);

  log.info('Visitor passes listed', { count: documents.length, total, page: currentPage });

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
 * Everything the visitor table's filter bar can offer, for the caller's scope.
 *
 * Same job as `GET /api/vehicles/filters`: the list endpoint accepts filters,
 * this says which values are worth sending and how many rows sit behind each
 * chip, so a dashboard never has to page the collection to find out.
 *
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const listVisitorFilters = async (scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });
  const now = new Date();

  const [total, onSite, upcoming, expired, revoked, actorIds] = await Promise.all([
    Visitor.countDocuments(scopeFilter),
    Visitor.countDocuments({ ...scopeFilter, ...liveFilter(now) }),
    Visitor.countDocuments({
      ...scopeFilter,
      is_active: { $ne: false },
      valid_from: { $gt: now },
    }),
    Visitor.countDocuments({
      ...scopeFilter,
      is_active: { $ne: false },
      valid_till: { $lt: now },
    }),
    Visitor.countDocuments({ ...scopeFilter, is_active: false }),
    Visitor.distinct('issued_by', scopeFilter),
  ]);

  const ids = actorIds.filter(Boolean);

  const actors = ids.length
    ? await User.find({ _id: { $in: ids } })
        .select('name email')
        .sort({ name: 1 })
        .lean()
    : [];

  log.info('Visitor filters listed', { total, on_site: onSite });

  return {
    statuses: [...VEHICLE_TYPES],

    issued_by: actors.map((actor) => ({
      id: String(actor._id),
      name: actor.name ?? null,
      email: actor.email ?? null,
    })),

    counts: {
      total,
      // The four states a pass can be in, and they partition the collection
      // exactly: on_site + upcoming + expired + revoked = total. `revoked` is
      // counted first in that decomposition — a revoked pass is revoked whether
      // or not its window has also run out.
      on_site: onSite,
      upcoming,
      expired,
      revoked,
    },

    paging: { default_limit: VISITOR_DEFAULT_LIMIT, max_limit: VISITOR_MAX_LIMIT },
  };
};

/**
 * Loads one pass, but only if the caller may see it.
 *
 * The scope filter is folded into the query rather than checked afterwards, so a
 * pass in someone else's project is a 404, not a 403 — an object id is opaque
 * and guessable in bulk, and "that exists, but it is not yours" would confirm
 * which ids are real, and for whom.
 *
 * @param {string} id
 * @param {object} scopeFilter
 * @param {object} [options]
 * @param {boolean} [options.lean]
 * @returns {Promise<object>}
 * @throws {AppError} 404
 */
const findVisitorInScope = async (id, scopeFilter = {}, { lean = true } = {}) => {
  const query = Visitor.findOne({ _id: id, ...scopeFilter });

  if (lean) {
    query.populate('issued_by updated_by', ACTOR_FIELDS).populate('host_vehicle', 'vehicle_number').lean();
  }

  const record = await query;

  if (!record) throw AppError.notFound('No such visitor pass in your projects.');

  return record;
};

/**
 * One pass, for the dashboard's detail view.
 *
 * @param {string} id
 * @param {object} scopeFilter
 * @returns {Promise<object>}
 * @throws {AppError} 404
 */
const getVisitor = async (id, scopeFilter = {}) => {
  const record = await findVisitorInScope(id, scopeFilter);
  return toDashboardRecord(record, new Date());
};

/**
 * Edits a pass in place — extending a visit, correcting the host, restricting
 * the gates.
 *
 * Only the fields sent change. `group_id` and `vehicle_number` are deliberately
 * absent: a different plate is a different visit, which is what POST is for, and
 * editing the project would move a pass into a tenant the caller may not even be
 * able to see.
 *
 * Extending a window is re-checked against the same rules a new pass faces — the
 * ordering, the ceiling, and any other pass this plate holds here — because an
 * edit can create exactly the overlap a create would have been refused for.
 *
 * @param {string} id
 * @param {object} payload
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<object>}
 * @throws {AppError} 404 out of scope · 400 nothing to update · 409 overlap.
 */
const updateVisitor = async (id, payload, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await findVisitorInScope(id, scopeFilter, { lean: false });

  const log = logger.child({
    requestId,
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  });

  // Resolved onto `device_names` so the rest of this function sees one field.
  // `all_devices` alone is a real edit — it becomes the project's gate list — so
  // this runs before the "nothing to update" check.
  const resolved = await resolveDeviceNames(record.group_id, {
    deviceNames: payload.device_names,
    allDevices: payload.all_devices,
  });

  if (resolved !== undefined) payload.device_names = resolved;

  // The window is re-validated as a whole, against whichever end is not being
  // changed — a rule about the record, which no request-level check could see.
  if (payload.valid_from !== undefined || payload.valid_till !== undefined) {
    const validFrom = payload.valid_from ?? record.valid_from;
    const validTill = payload.valid_till ?? record.valid_till;

    assertWindow(new Date(validFrom), new Date(validTill));
    await assertNoOverlap(
      record.group_id,
      record.vehicle_number,
      new Date(validFrom),
      new Date(validTill),
      record._id
    );
  }

  // Re-resolved so linking a host now copies their name and unit across, exactly
  // as issuing the pass would have.
  //
  // `host_vehicle_id: null` is how a link is broken, so the stored id is only
  // used when the field was not sent at all — `??` here would make unlinking
  // impossible. The name already on the pass stands in when none is sent, since
  // unlinking a registration does not un-invite the person.
  if (
    payload.host_vehicle_id !== undefined ||
    payload.host_name !== undefined ||
    payload.host_phone !== undefined ||
    payload.host_unit !== undefined
  ) {
    const host = await resolveHost(
      record.group_id,
      {
        host_vehicle_id:
          payload.host_vehicle_id !== undefined ? payload.host_vehicle_id : record.host_vehicle,
        host_name: payload.host_name ?? record.host_name,
        // Omitted keeps what is stored; an explicit null clears it, or takes the
        // linked registration's value if there is one to take.
        host_phone: payload.host_phone !== undefined ? payload.host_phone : record.host_phone,
        host_unit: payload.host_unit !== undefined ? payload.host_unit : record.host_unit,
      },
      record.host_type
    );

    Object.assign(payload, host);
  }

  const updatable = [
    'name',
    'phone_number',
    'vehicle_model',
    'purpose',
    'host_vehicle',
    'host_name',
    'host_phone',
    'host_unit',
    'valid_from',
    'valid_till',
    'device_names',
    'is_active',
  ];

  const changed = updatable.filter((field) => payload[field] !== undefined);

  if (!changed.length) {
    throw AppError.badRequest('Nothing to update.', [
      {
        field: 'body',
        message:
          'Send at least one of: name, phone_number, vehicle_model, purpose, host_vehicle_id, ' +
          'host_name, host_phone, host_unit, valid_from, valid_till, device_names, is_active.',
      },
    ]);
  }

  changed.forEach((field) => {
    record[field] = payload[field];
  });

  // Moving either end of the window re-arms both time-driven transitions: an
  // extended pass has a new closing time nobody has reported, and one pushed
  // into the future has to be announced again when it opens.
  if (changed.includes('valid_from') || changed.includes('valid_till')) {
    const at = new Date();
    record.activation_emitted_at = record.valid_from <= at ? at : null;
    record.expiry_emitted_at = null;
  }

  record.updated_by = actor ? actor._id : null;
  await record.save();

  log.info('Visitor pass updated', { id: String(record._id), fields: changed });

  // Revoking through the edit endpoint is still a revocation — Intozi must
  // remove access, not merge an update.
  await emitVisitorChange(
    record,
    changed.includes('is_active') && record.is_active === false
      ? ACCESS_EVENT_TYPES.REVOKED
      : ACCESS_EVENT_TYPES.UPDATED,
    { requestId }
  );

  const populated = await Visitor.findById(record._id)
    .populate('issued_by updated_by', ACTOR_FIELDS)
    .populate('host_vehicle', 'vehicle_number')
    .lean();

  return toDashboardRecord(populated, new Date());
};

/**
 * Revokes a pass, or reinstates one.
 *
 * The manual half of the status: `false` reads as unregistered at every gate
 * immediately, whatever the window says — the visitor who left early, or the
 * pass issued to the wrong plate. Live on Intozi's next poll, because the feed
 * derives status from the same fields.
 *
 * Revoking is not deleting. The pass, its host and its window survive, so the
 * record of who was admitted and when it was withdrawn stays readable.
 *
 * @param {string} id
 * @param {boolean} isActive
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<object>}
 * @throws {AppError} 404
 */
const setVisitorStatus = async (id, isActive, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await findVisitorInScope(id, scopeFilter, { lean: false });

  const log = logger.child({
    requestId,
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  });

  // Reinstating can resurrect an overlap that was legal only while this pass was
  // switched off, so it faces the same check a new pass would.
  if (isActive && record.is_active === false) {
    await assertNoOverlap(
      record.group_id,
      record.vehicle_number,
      new Date(record.valid_from),
      new Date(record.valid_till),
      record._id
    );
  }

  record.is_active = isActive;
  record.updated_by = actor ? actor._id : null;
  await record.save();

  log.info(isActive ? 'Visitor pass reinstated' : 'Visitor pass revoked', {
    id: String(record._id),
    by: actor ? String(actor._id) : 'system',
  });

  await emitVisitorChange(
    record,
    isActive ? ACCESS_EVENT_TYPES.UPDATED : ACCESS_EVENT_TYPES.REVOKED,
    { requestId }
  );

  const populated = await Visitor.findById(record._id)
    .populate('issued_by updated_by', ACTOR_FIELDS)
    .populate('host_vehicle', 'vehicle_number')
    .lean();

  return toDashboardRecord(populated, new Date());
};

/**
 * Removes a pass outright.
 *
 * Prefer revoking: a deleted pass takes with it who was admitted, by whom and on
 * whose invitation — which is most of what this collection is for once the
 * visit is over. Deleting is right for a pass entered by mistake.
 *
 * Detections already logged are untouched: VehicleLog stores the status as
 * judged at detection time, not a reference to this row.
 *
 * @param {string} id
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<{ id: string, group_id: string, vehicle_number: string }>}
 * @throws {AppError} 404
 */
const deleteVisitor = async (id, scopeFilter = {}, { actor, requestId } = {}) => {
  const record = await Visitor.findOneAndDelete({ _id: id, ...scopeFilter }).lean();

  if (!record) throw AppError.notFound('No such visitor pass in your projects.');

  logger.child({ requestId }).warn('Visitor pass deleted', {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
    by: actor ? String(actor._id) : 'system',
  });

  // The tombstone. Same reasoning as a deleted registration: the row is gone,
  // so this event is the only thing that can tell Intozi to drop the plate.
  await emitVisitorChange(record, ACCESS_EVENT_TYPES.DELETED, { requestId });

  return {
    id: String(record._id),
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
  };
};

/**
 * Resolves whether a detected plate holds a live visitor pass — the bridge
 * between this collection and the ANPR ingestion path.
 *
 * Scoped to the project the camera belongs to, so a pass at one customer's site
 * is nothing at another's. A pass limited to specific `device_names` only counts
 * at those gates; an empty list means every gate, matching the registry exactly.
 *
 * Only a pass covering the detection instant counts. A plate may legitimately
 * hold several non-overlapping passes — the same courier booked in for Monday
 * and for Thursday — so "the newest one" is the wrong question and today's
 * answer must not come from Thursday's row.
 *
 * @param {string|null} vehicleNumber
 * @param {Date} at Instant to judge the window at (detection time).
 * @param {object} [options]
 * @param {string|null} [options.groupId]
 * @param {string|null} [options.deviceName]
 * @returns {Promise<'registered'|'unregistered'|null>} null when this plate has
 *          no pass here at all, so the caller can fall back to the registry.
 */
const resolveVisitorStatus = async (vehicleNumber, at, { groupId, deviceName } = {}) => {
  if (!vehicleNumber || !groupId) return null;

  const identity = {
    group_id: String(groupId).trim().toUpperCase(),
    vehicle_number: vehicleNumber,
  };

  // Asked as "is there a pass covering *this instant*?" rather than "what is
  // this plate's newest pass?". The two differ for a plate booked in for
  // tomorrow as well as today: the newest pass by date is tomorrow's, which is
  // not yet valid, and answering with it would turn a visitor away at a gate
  // they are currently allowed through.
  const record = await Visitor.findOne({ ...identity, ...liveFilter(at) })
    .select('device_names')
    .lean();

  if (!record) {
    // No live pass. Distinguish "this plate visits here, but not now" from
    // "never heard of it" — the caller falls back to the registry on null, and
    // must not be handed an `unregistered` that overrides a real registration.
    const known = await Visitor.exists(identity);
    return known ? 'unregistered' : null;
  }

  const restrictedTo = record.device_names ?? [];

  if (restrictedTo.length && deviceName) {
    const allowed = restrictedTo.some(
      (name) => name.toLowerCase() === String(deviceName).trim().toLowerCase()
    );
    // Inside its window, but not at this gate — treated exactly as an
    // unregistered vehicle, which is what the barrier should do.
    if (!allowed) return 'unregistered';
  }

  return 'registered';
};

module.exports = {
  createVisitor,
  listVisitors,
  listVisitorFilters,
  getVisitor,
  updateVisitor,
  setVisitorStatus,
  deleteVisitor,
  resolveVisitorStatus,
  statusOf,
  inactiveReasonOf,
  liveFilter,
  notLiveFilter,
  toDashboardRecord,
};
