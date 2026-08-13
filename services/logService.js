const VehicleLog = require('../models/VehicleLog');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const logger = require('../utils/logger');
const { listScopedGates } = require('./projectService');
const { VEHICLE_TYPES, LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT } = require('../utils/constants');

/**
 * The detection log, as the internal dashboard reads it.
 *
 * This is the one view of VehicleLog that a person looks at, and it is
 * dashboard-only: the Intozi feed reads the *registry* and discloses three
 * fields (see FEED_DISCLOSED_FIELDS), while this reads the events themselves
 * and names the owner. Nothing here is reachable with a camera API key.
 *
 * Every query is scoped by `scopeFilter`, built from the caller's assigned
 * projects — a customer admin sees their own sites' detections and nothing else.
 */

/**
 * Escapes a user-supplied search term so it is matched literally.
 * Without this, input like `.*` or `(a+)+` becomes an expensive regex.
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fills in the owner for a page of detections.
 *
 * `VehicleLog.owner_name` only holds what the camera sent, and Intozi normally
 * sends nothing — the name a dashboard user expects to see lives in the
 * registered-vehicle registry, keyed by (group_id, vehicle_number). So the
 * event's own value wins when present, and the registry answers otherwise.
 *
 * One query for the whole page, not one per row: the page is capped at
 * LOG_MAX_LIMIT, so this is a single bounded `$or` rather than an N+1.
 *
 * @param {object[]} records Lean VehicleLog documents.
 * @returns {Promise<Map<string, string>>} "GROUP_ID PLATE" → owner name.
 */
const loadRegistryDetails = async (records) => {
  const pairs = new Map();

  records.forEach((record) => {
    if (!record.vehicle_number || !record.group_id) return;
    pairs.set(`${record.group_id} ${record.vehicle_number}`, {
      group_id: record.group_id,
      vehicle_number: record.vehicle_number,
    });
  });

  if (!pairs.size) return new Map();

  const registrations = await RegisteredVehicle.find({ $or: [...pairs.values()] })
    .select('group_id vehicle_number name vehicle_model')
    .lean();

  return new Map(
    registrations.map((r) => [
      `${r.group_id} ${r.vehicle_number}`,
      { name: r.name ?? null, vehicle_model: r.vehicle_model ?? null },
    ])
  );
};

/**
 * Shapes one stored detection for the dashboard table.
 *
 * Built field by field rather than by deleting from the document, so a column
 * added to VehicleLog later — the driver's phone number, their email — cannot
 * appear in this response by default. That matters here: the event schema holds
 * contact details that this table has no reason to show.
 *
 * @param {object} record Lean VehicleLog document.
 * @param {Map<string, {name: string|null, vehicle_model: string|null}>} registry
 *        Registrations matching this page, from loadRegistryDetails.
 */
const toLogRecord = (record, registry) => {
  const registered = record.vehicle_number
    ? registry.get(`${record.group_id} ${record.vehicle_number}`) ?? null
    : null;

  // Same rule for both: what the camera reported wins, and what a person typed
  // into the registry fills the gap. Intozi usually sends neither, so in
  // practice the registry is what populates these columns.
  const ownerName = record.owner_name ?? registered?.name ?? null;
  const vehicleModel = record.vehicle_model ?? registered?.vehicle_model ?? null;

  return {
    id: String(record._id),
    group_id: record.group_id ?? null,
    device_name: record.device_name ?? null,

    vehicle_number: record.vehicle_number ?? null,
    // As judged when the vehicle was seen, not as it stands now: a registration
    // that expired yesterday must not rewrite last week's detections.
    vehicle_type: record.vehicle_type,
    vehicle_model: vehicleModel,
    owner_name: ownerName,

    // Which source answered, so the UI can distinguish "the camera told us"
    // from "we matched it to a registration" — and show nothing rather than a
    // blank column when neither did.
    owner_name_source: record.owner_name ? 'event' : registered?.name ? 'registry' : null,
    vehicle_model_source: record.vehicle_model
      ? 'event'
      : registered?.vehicle_model
        ? 'registry'
        : null,

    detected_at: record.created_datetime, // as reported by the camera
    received_at: record.received_at, // as recorded by this API
  };
};

/**
 * Lists detections for the dashboard's log table.
 *
 * Offset paging (page/limit + total) rather than the feed's cursor: an operator
 * needs page numbers and a row count, where Intozi needs exactly-once delivery.
 *
 * Sorted by `created_datetime` — when the camera saw the vehicle — because that
 * is the column an operator reasons about. `_id` breaks ties so a row can never
 * appear on two pages when several events share a timestamp.
 *
 * @param {object} [params]
 * @param {string} [params.search]        Partial, case-insensitive match on plate, owner or model.
 * @param {string} [params.vehicleNumber] One exact plate — every crossing by this vehicle.
 * @param {string} [params.vehicleType]  'registered' | 'unregistered'.
 * @param {string} [params.deviceName]   Exact gate, matched case-insensitively.
 * @param {Date}   [params.from]         Only detections at or after this instant.
 * @param {Date}   [params.to]           Only detections at or before this instant.
 * @param {number} [params.page]         1-based page number (default 1).
 * @param {number} [params.limit]        Rows per page (default 25, max 200).
 * @param {object} scopeFilter           group_id fragment from buildScopeFilter() — the
 *                                       tenant boundary. `{}` reads every project and is
 *                                       only ever produced for a super admin; a customer
 *                                       admin with no assignments gets `{ $in: [] }` and
 *                                       correctly sees nothing.
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listVehicleLogs = async (
  { search, vehicleNumber, vehicleType, deviceName, from, to, page, limit } = {},
  scopeFilter = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });

  const pageSize = Math.min(Number(limit) || LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = { ...scopeFilter };

  // The whole history of one vehicle, which is the question an operator asks
  // most often. Separate from `search` on purpose: this is an equality match on
  // an uppercased plate, so it walks idx_group_vehicle_number_created instead of
  // regex-scanning three columns.
  if (vehicleNumber) filter.vehicle_number = vehicleNumber;

  if (vehicleType) filter.vehicle_type = vehicleType;

  if (deviceName) {
    filter.device_name = new RegExp(`^${escapeRegex(deviceName)}$`, 'i');
  }

  if (from || to) {
    filter.created_datetime = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
  }

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    // Deliberately the columns this table shows. Searching fields the operator
    // cannot see — the driver's email, say — would return rows with no visible
    // reason for matching.
    //
    // Matches the event's own values only. A plate whose model is known solely
    // from the registry will not match on model here; searching that would mean
    // resolving the registry before filtering, which is a join on every query
    // to serve a rare case. Search the registry itself via GET /api/vehicles.
    filter.$or = [{ vehicle_number: term }, { owner_name: term }, { vehicle_model: term }];
  }

  const projection =
    '_id group_id device_name vehicle_number vehicle_type vehicle_model owner_name created_datetime received_at';

  const [documents, total] = await Promise.all([
    VehicleLog.find(filter)
      .select(projection)
      .sort({ created_datetime: -1, _id: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    VehicleLog.countDocuments(filter),
  ]);

  const registry = await loadRegistryDetails(documents);

  log.info('Vehicle logs listed', {
    count: documents.length,
    total,
    page: currentPage,
    scope: scopeFilter.group_id ?? 'all',
  });

  return {
    records: documents.map((record) => toLogRecord(record, registry)),
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
 * Everything the detection-log filter bar can offer, for the caller's scope.
 *
 * The list endpoint accepts filters; this says which values are worth sending.
 * Without it a dashboard has to either hard-code the gate names of every
 * customer or page through the log to discover them, and both go stale the day
 * a camera is added.
 *
 * Scoped exactly like the table it drives, so the dropdowns can never offer a
 * project the caller would get a 403 for. `detected_between` is the real extent
 * of the data, so a date picker can bound itself to it and an empty project can
 * say "no detections yet" instead of showing an empty table.
 *
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<object>}
 */
const listVehicleLogFilters = async (scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });

  // Two one-document reads rather than an aggregation: both walk the same
  // (group_id, created_datetime) index the table itself sorts on, in each
  // direction, so this stays cheap however large the log grows.
  const [{ projects, device_names: deviceNames }, oldest, newest] = await Promise.all([
    listScopedGates(scopeFilter),
    VehicleLog.findOne(scopeFilter).select('created_datetime').sort({ created_datetime: 1 }).lean(),
    VehicleLog.findOne(scopeFilter).select('created_datetime').sort({ created_datetime: -1 }).lean(),
  ]);

  log.info('Vehicle log filters listed', {
    projects: projects.length,
    devices: deviceNames.length,
  });

  return {
    projects,
    device_names: deviceNames,
    vehicle_types: [...VEHICLE_TYPES],

    // Null on both ends when the caller has no detections at all — which is a
    // different thing from a filter that matched nothing, and the UI should be
    // able to tell them apart.
    detected_between: {
      from: oldest?.created_datetime ?? null,
      to: newest?.created_datetime ?? null,
    },

    // So the client does not have to hard-code the numbers the API enforces.
    paging: { default_limit: LOG_DEFAULT_LIMIT, max_limit: LOG_MAX_LIMIT },
  };
};

module.exports = { listVehicleLogs, listVehicleLogFilters, toLogRecord };
