const VehicleLog = require('../models/VehicleLog');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const Project = require('../models/Project');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { listScopedGates } = require('./projectService');
const {
  BUCKET_FORMATS,
  bucketKey,
  bucketStart,
  enumerateBuckets,
  endOfZonedDay,
  instantFromZoned,
  parseZonedBoundary,
  shiftZonedDays,
  startOfZonedDay,
  zonedParts,
} = require('../utils/timezone');
const {
  VEHICLE_TYPES,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_DEFAULT_GRANULARITY,
  ANALYTICS_DEFAULT_SPAN_DAYS,
  ANALYTICS_MAX_BUCKETS,
  DEFAULT_REPORT_TIMEZONE,
} = require('../utils/constants');

/**
 * Dashboard reporting: how many vehicles are on the register, and how many came
 * in and went out.
 *
 * Three reads, all scoped to the caller's projects exactly like the log table:
 *
 *   getSummary        — the number tiles. Registry totals (a standing count, not
 *                       a daily one), plus entries/exits over a window and for
 *                       today.
 *   getTrafficSeries  — the chart. One row per time bucket, zero-filled, with
 *                       entries and exits split out.
 *   getAnalyticsFilters — what the filter bar may offer, and the ready-made date
 *                       ranges behind the "Today / 7 days / This month" chips.
 *
 * Nothing here touches ingestion or the Intozi feed: these are read-only
 * aggregations over the events already stored.
 *
 * ## Where "entry" and "exit" come from
 *
 * A detection does not say which way the vehicle was going — it names the gate
 * that saw it (`device_name`), and the *gate* has the direction, configured on
 * the project (`PATCH /api/projects/{group_id}/devices/{device_name}` with
 * `{ "direction": "entry" }`). So every count here is a join from the event's
 * gate name to that project's device list.
 *
 * Gates whose direction was never configured are not guessed at silently. The
 * name is read for an obvious hint ("exit1", "IN_GATE"), and what that produced
 * is reported alongside every count as `direction_source`, so a number that
 * looks wrong can be traced to the gate that caused it. A gate that yields
 * nothing — or one deliberately marked `both`, which sees traffic in both
 * directions and cannot be attributed either way — has its detections counted
 * under `unattributed` rather than being folded into entries or exits. They are
 * still in `total`, which is why entries + exits does not always equal total.
 */

// ---------------------------------------------------------------------------
// Gate direction
// ---------------------------------------------------------------------------

/**
 * Name patterns that betray a gate's direction when nobody configured one.
 *
 * Written to be conservative: a name has to hit exactly one side to be
 * attributed, so "in_out_gate" stays unattributed rather than being counted as
 * an entry. The bare `in`/`out` forms are anchored to a non-letter on both sides
 * so "main1" is not read as an entry and "checkout" is not read as an exit.
 */
const ENTRY_NAME_HINTS = [/entr/, /ingress/, /inward/, /incoming/, /(^|[^a-z])in[\s_.-]?\d*([^a-z]|$)/];
const EXIT_NAME_HINTS = [/exit/, /egress/, /outward/, /outgoing/, /(^|[^a-z])out[\s_.-]?\d*([^a-z]|$)/];

/**
 * @param {string} deviceName
 * @returns {'entry'|'exit'|null} Null when the name says nothing, or says both.
 */
const inferDirection = (deviceName) => {
  const name = String(deviceName ?? '').toLowerCase();
  if (!name) return null;

  const looksEntry = ENTRY_NAME_HINTS.some((pattern) => pattern.test(name));
  const looksExit = EXIT_NAME_HINTS.some((pattern) => pattern.test(name));

  if (looksEntry && !looksExit) return 'entry';
  if (looksExit && !looksEntry) return 'exit';

  return null;
};

const deviceKey = (groupId, deviceName) =>
  `${String(groupId ?? '').toUpperCase()}::${String(deviceName ?? '').trim().toLowerCase()}`;

/**
 * Builds the gate → direction lookup for every project in scope.
 *
 * One read of the project registry, not one per event: the device list is a
 * small embedded array on a document that is already indexed by group_id, while
 * resolving direction per detection would be a lookup on every row of a
 * collection that grows forever.
 *
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @returns {Promise<{resolve: Function, devices: object[]}>}
 *          `resolve(group_id, device_name)` → `{ direction, direction_source }`,
 *          and `devices` is every configured gate with the direction the report
 *          will use for it.
 */
const buildDirectionIndex = async (scopeFilter = {}) => {
  const projects = await Project.find(scopeFilter).select('group_id devices').lean();

  const index = new Map();
  const devices = [];

  projects.forEach((project) => {
    (project.devices ?? []).forEach((device) => {
      const configured = device.direction ?? null;

      // A gate configured as `both` is not a gap in the data — it is a gate that
      // genuinely cannot attribute its detections, so the name is not consulted.
      const resolved =
        configured === 'entry' || configured === 'exit'
          ? { direction: configured, direction_source: 'configured' }
          : configured === 'both'
            ? { direction: 'both', direction_source: 'configured' }
            : (() => {
                const guessed = inferDirection(device.device_name);
                return guessed
                  ? { direction: guessed, direction_source: 'inferred_from_name' }
                  : { direction: null, direction_source: 'unknown' };
              })();

      index.set(deviceKey(project.group_id, device.device_name), resolved);

      devices.push({
        group_id: project.group_id,
        device_name: device.device_name,
        label: device.label ?? null,
        configured_direction: configured,
        is_active: device.is_active !== false,
        ...resolved,
      });
    });
  });

  /**
   * A gate that is not on its project's list at all — possible for events
   * ingested before the device list existed, or once a project hit the device
   * ceiling — still gets read for a hint rather than being dropped.
   */
  const resolve = (groupId, deviceName) => {
    const known = index.get(deviceKey(groupId, deviceName));
    if (known) return known;

    const guessed = inferDirection(deviceName);
    return guessed
      ? { direction: guessed, direction_source: 'inferred_from_name' }
      : { direction: null, direction_source: 'unknown' };
  };

  return { resolve, devices };
};

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

/**
 * Turns the caller's `from`/`to`/`granularity`/`timezone` into a concrete window.
 *
 * Bare dates mean whole local days (see parseZonedBoundary), and omitting them
 * means "the span this granularity is usually read at, ending today" — so
 * `GET /api/analytics/traffic` with no query at all is already the chart a
 * dashboard opens with.
 *
 * @param {object} params from?, to?, granularity?, timezone?
 * @returns {{from: Date, to: Date, granularity: string, timezone: string, buckets: object[]}}
 * @throws {AppError} 400 on an unparsable or inverted window, or one that would
 *         produce more points than ANALYTICS_MAX_BUCKETS.
 */
const resolveWindow = ({ from, to, granularity, timezone } = {}) => {
  const zone = timezone || DEFAULT_REPORT_TIMEZONE;
  const bucket = ANALYTICS_GRANULARITIES.includes(granularity)
    ? granularity
    : ANALYTICS_DEFAULT_GRANULARITY;

  const now = new Date();

  const end = to ? parseZonedBoundary(to, 'end', zone) : endOfZonedDay(now, zone);

  if (!end) {
    throw AppError.badRequest('to is not a parsable date.', [
      { field: 'to', message: 'Use YYYY-MM-DD, or an ISO 8601 datetime.' },
    ]);
  }

  // Counting back from the end of the window rather than from "now", so a caller
  // who names only `to` gets the span leading up to it.
  const spanDays = ANALYTICS_DEFAULT_SPAN_DAYS[bucket] ?? ANALYTICS_DEFAULT_SPAN_DAYS.day;
  const start = from
    ? parseZonedBoundary(from, 'start', zone)
    : bucketStart(shiftZonedDays(end, -(spanDays - 1), zone), bucket, zone);

  if (!start) {
    throw AppError.badRequest('from is not a parsable date.', [
      { field: 'from', message: 'Use YYYY-MM-DD, or an ISO 8601 datetime.' },
    ]);
  }

  if (start.getTime() > end.getTime()) {
    throw AppError.badRequest('to must be the same as or after from.', [
      { field: 'to', message: `from is ${start.toISOString()} and to is ${end.toISOString()}.` },
    ]);
  }

  // Enumerated one past the ceiling and stopped there, so an absurd window costs
  // 751 iterations rather than being counted out in full to be rejected.
  const buckets = enumerateBuckets(start, end, bucket, zone, ANALYTICS_MAX_BUCKETS + 1);

  if (buckets.length > ANALYTICS_MAX_BUCKETS) {
    throw AppError.badRequest(
      `That window is more than ${ANALYTICS_MAX_BUCKETS} points at granularity=${bucket}.`,
      [
        {
          field: 'granularity',
          message: `Shorten the window, or use a coarser granularity (${ANALYTICS_GRANULARITIES.join(' → ')}).`,
        },
      ]
    );
  }

  return { from: start, to: end, granularity: bucket, timezone: zone, buckets };
};

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

const blankCounts = () => ({
  entries: 0,
  exits: 0,
  unattributed: 0,
  registered: 0,
  unregistered: 0,
  total: 0,
});

/** Adds one aggregation row into a counter block. */
const addTo = (counts, direction, vehicleType, count) => {
  if (direction === 'entry') counts.entries += count;
  else if (direction === 'exit') counts.exits += count;
  else counts.unattributed += count;

  if (vehicleType === 'registered') counts.registered += count;
  else counts.unregistered += count;

  counts.total += count;
};

/**
 * Groups detections by time bucket, project and gate, in one pass over the index.
 *
 * Grouped server-side and folded here rather than counted per direction in
 * Mongo: the direction lives on the project document, so a pipeline that knew it
 * would need a `$lookup` plus a `$switch` over every gate name. Grouping by gate
 * instead keeps the pipeline on the (group_id, created_datetime) index, and the
 * result set is buckets × gates × 2 rows — tens, not thousands.
 *
 * @param {object} filter Mongo filter, already scoped.
 * @param {string} granularity
 * @param {string} timezone
 * @returns {Promise<object[]>}
 */
const aggregateTraffic = (filter, granularity, timezone) =>
  VehicleLog.aggregate([
    { $match: filter },
    {
      $group: {
        _id: {
          bucket: {
            $dateToString: {
              date: '$created_datetime',
              format: (BUCKET_FORMATS[granularity] ?? BUCKET_FORMATS.day).mongo,
              timezone,
            },
          },
          group_id: '$group_id',
          device_name: '$device_name',
          vehicle_type: '$vehicle_type',
        },
        count: { $sum: 1 },
      },
    },
  ]);

/**
 * Folds aggregation rows into per-bucket, per-project and per-gate totals.
 *
 * @param {object[]} rows        Output of aggregateTraffic.
 * @param {Function} resolve     From buildDirectionIndex.
 * @param {string}  [direction]  'entry' | 'exit' — drop everything else.
 */
const foldTraffic = (rows, resolve, direction) => {
  const byBucket = new Map();
  const byProject = new Map();
  const byDevice = new Map();
  const totals = blankCounts();

  rows.forEach((row) => {
    const { bucket, group_id: groupId, device_name: deviceName, vehicle_type: vehicleType } = row._id;
    const resolved = resolve(groupId, deviceName);

    // The direction filter is applied here rather than in the pipeline: it is a
    // property of the gate, not of the event, so filtering in Mongo would mean
    // sending it the resolved gate list on every request.
    if (direction && resolved.direction !== direction) return;

    if (!byBucket.has(bucket)) byBucket.set(bucket, blankCounts());
    addTo(byBucket.get(bucket), resolved.direction, vehicleType, row.count);

    const projectKey = groupId ?? 'UNASSIGNED';
    if (!byProject.has(projectKey)) byProject.set(projectKey, blankCounts());
    addTo(byProject.get(projectKey), resolved.direction, vehicleType, row.count);

    const gateKey = `${projectKey}::${deviceName}`;
    if (!byDevice.has(gateKey)) {
      byDevice.set(gateKey, {
        group_id: groupId ?? null,
        device_name: deviceName ?? null,
        direction: resolved.direction,
        direction_source: resolved.direction_source,
        count: 0,
      });
    }
    byDevice.get(gateKey).count += row.count;

    addTo(totals, resolved.direction, vehicleType, row.count);
  });

  return { byBucket, byProject, byDevice, totals };
};

/**
 * The event-side filter shared by every report on this page.
 *
 * @param {object} scopeFilter The tenant boundary — always applied first.
 * @param {object} window      from/to, as resolved by resolveWindow.
 * @param {object} params      device_name?, vehicle_number?, vehicle_type?
 */
const buildEventFilter = (scopeFilter, { from, to }, { deviceName, vehicleNumber, vehicleType }) => {
  const filter = { ...scopeFilter, created_datetime: { $gte: from, $lte: to } };

  if (vehicleType) filter.vehicle_type = vehicleType;
  if (vehicleNumber) filter.vehicle_number = vehicleNumber;

  // Cameras are inconsistent about "Entry1" vs "entry1", so the gate filter is
  // anchored and case-insensitive — the same rule GET /api/logs uses.
  if (deviceName) {
    const escaped = String(deviceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.device_name = new RegExp(`^${escaped}$`, 'i');
  }

  return filter;
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Standing totals from the registered-vehicle registry, per project.
 *
 * Deliberately *not* filtered by the report window: "vehicles registered against
 * this project" is a count of what is on the register right now, not of what was
 * added between two dates. That is what the request asked for, and it is also
 * the only reading that makes sense on a tile next to a daily traffic chart.
 *
 * @param {object} scopeFilter
 * @param {Date} now
 * @returns {Promise<{total: object, byProject: Map<string, object>}>}
 */
const registryTotals = async (scopeFilter, now) => {
  const rows = await RegisteredVehicle.aggregate([
    { $match: scopeFilter },
    {
      $group: {
        _id: '$group_id',
        total: { $sum: 1 },
        // `$ne: false` rather than `$eq: true`, so rows written before is_active
        // existed count as active — which is what they are.
        active: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$is_active', false] }, { $gte: ['$valid_till', now] }] },
              1,
              0,
            ],
          },
        },
        expired: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$is_active', false] }, { $lt: ['$valid_till', now] }] },
              1,
              0,
            ],
          },
        },
        deactivated: { $sum: { $cond: [{ $eq: ['$is_active', false] }, 1, 0] } },
      },
    },
  ]);

  const byProject = new Map();
  const total = { total: 0, active: 0, expired: 0, deactivated: 0 };

  rows.forEach((row) => {
    const counts = {
      total: row.total,
      active: row.active,
      expired: row.expired,
      deactivated: row.deactivated,
    };

    byProject.set(row._id ?? 'UNASSIGNED', counts);

    total.total += counts.total;
    total.active += counts.active;
    total.expired += counts.expired;
    total.deactivated += counts.deactivated;
  });

  return { total, byProject };
};

/**
 * The chart: entries and exits per time bucket.
 *
 * Every bucket in the window is present even when nothing came through it —
 * `$group` only emits buckets that have documents, and a line chart with the
 * quiet days missing draws a straight line across them instead of a dip.
 *
 * @param {object} params group_id is *not* read here — the caller's scope is the
 *        boundary. from?, to?, granularity?, timezone?, direction?, device_name?,
 *        vehicle_type?, vehicle_number?
 * @param {object} scopeFilter group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<object>}
 */
const getTrafficSeries = async (params = {}, scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });

  const window = resolveWindow(params);
  const filter = buildEventFilter(scopeFilter, window, params);

  const [rows, { resolve, devices }] = await Promise.all([
    aggregateTraffic(filter, window.granularity, window.timezone),
    buildDirectionIndex(scopeFilter),
  ]);

  const { byBucket, byProject, byDevice, totals } = foldTraffic(rows, resolve, params.direction);

  const series = window.buckets.map(({ key, starts_at: startsAt }) => ({
    bucket: key,
    starts_at: startsAt,
    ...(byBucket.get(key) ?? blankCounts()),
  }));

  log.info('Traffic series built', {
    granularity: window.granularity,
    buckets: series.length,
    total: totals.total,
    scope: scopeFilter.group_id ?? 'all',
  });

  return {
    range: {
      from: window.from,
      to: window.to,
      timezone: window.timezone,
      granularity: window.granularity,
    },

    filters: {
      direction: params.direction ?? null,
      device_name: params.deviceName ?? null,
      vehicle_type: params.vehicleType ?? null,
      vehicle_number: params.vehicleNumber ?? null,
    },

    // One point per bucket, in order, zero-filled — plot `bucket` on the x-axis
    // and `entries`/`exits` as the two series.
    series,

    totals,

    by_project: [...byProject.entries()]
      .map(([groupId, counts]) => ({ group_id: groupId, ...counts }))
      .sort((a, b) => b.total - a.total),

    // Which gate produced what, and on what authority. This is where a wrong
    // number gets diagnosed: a gate showing `direction_source: "unknown"` is one
    // nobody has configured a direction for.
    by_device: [...byDevice.values()].sort((a, b) => b.count - a.count),

    // The gates that cost the report accuracy, listed so the UI can prompt for
    // the one-line fix instead of quietly under-reporting.
    unattributed_devices: devices
      .filter((device) => device.direction === null || device.direction === 'both')
      .map((device) => ({
        group_id: device.group_id,
        device_name: device.device_name,
        configured_direction: device.configured_direction,
      })),
  };
};

/**
 * The number tiles above the chart.
 *
 * Registry totals are standing counts over the whole register; traffic is over
 * the window, with today broken out separately because that is the number a
 * dashboard leads with and it is rarely the same as the window's.
 *
 * @param {object} params Same as getTrafficSeries, minus granularity.
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const getSummary = async (params = {}, scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });

  const now = new Date();
  const window = resolveWindow({ ...params, granularity: 'day' });
  const zone = window.timezone;

  const todayWindow = { from: startOfZonedDay(now, zone), to: endOfZonedDay(now, zone) };

  const [registry, rangeRows, todayRows, { resolve, devices }] = await Promise.all([
    registryTotals(scopeFilter, now),
    aggregateTraffic(buildEventFilter(scopeFilter, window, params), 'day', zone),
    aggregateTraffic(buildEventFilter(scopeFilter, todayWindow, params), 'day', zone),
    buildDirectionIndex(scopeFilter),
  ]);

  const range = foldTraffic(rangeRows, resolve, params.direction);
  const today = foldTraffic(todayRows, resolve, params.direction);

  // Every project the caller can see, including the quiet ones: a site with no
  // detections yet is a row of zeros, not a missing row.
  const groupIds = new Set([
    ...registry.byProject.keys(),
    ...range.byProject.keys(),
    ...devices.map((device) => device.group_id),
  ]);

  log.info('Analytics summary built', {
    projects: groupIds.size,
    registered_vehicles: registry.total.total,
    range_total: range.totals.total,
    scope: scopeFilter.group_id ?? 'all',
  });

  return {
    range: { from: window.from, to: window.to, timezone: zone },

    filters: {
      direction: params.direction ?? null,
      device_name: params.deviceName ?? null,
      vehicle_type: params.vehicleType ?? null,
      vehicle_number: params.vehicleNumber ?? null,
    },

    // A standing count of the register — not day-wise, and not affected by
    // `from`/`to`. `total` is every row; the three below it are what those rows
    // currently mean.
    registered_vehicles: registry.total,

    // Detections inside the window.
    traffic: range.totals,

    // The same numbers for the local day in progress, so the tiles can show
    // "today" without a second call and without assuming the window includes it.
    // `date` is the local calendar day these counts belong to, which is not
    // necessarily the UTC one.
    today: { date: bucketKey(now, 'day', zone), ...today.totals },

    by_project: [...groupIds]
      .map((groupId) => ({
        group_id: groupId,
        registered_vehicles: registry.byProject.get(groupId) ?? {
          total: 0,
          active: 0,
          expired: 0,
          deactivated: 0,
        },
        traffic: range.byProject.get(groupId) ?? blankCounts(),
        today: today.byProject.get(groupId) ?? blankCounts(),
      }))
      .sort((a, b) => b.traffic.total - a.traffic.total),

    by_device: [...range.byDevice.values()].sort((a, b) => b.count - a.count),

    unattributed_devices: devices
      .filter((device) => device.direction === null || device.direction === 'both')
      .map((device) => ({
        group_id: device.group_id,
        device_name: device.device_name,
        configured_direction: device.configured_direction,
      })),
  };
};

/**
 * What the reporting filter bar may offer, for the caller's scope.
 *
 * Same contract as `GET /api/logs/filters`: fetch it when the screen opens, send
 * the chosen values back to the two report endpoints. Scoped identically, so a
 * dropdown can never offer a project the caller would get a 403 for.
 *
 * `quick_ranges` is the part a chart page actually needs — the "Today / 7 days /
 * This month" chips, with the exact `from`, `to` and `granularity` to send for
 * each, resolved in the report timezone here rather than re-derived in the
 * browser against whatever clock the operator's laptop is set to.
 *
 * @param {object} params timezone?
 * @param {object} scopeFilter
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const getAnalyticsFilters = async (params = {}, scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });

  const zone = params.timezone || DEFAULT_REPORT_TIMEZONE;
  const now = new Date();

  const [gates, { devices }, registry, oldest, newest] = await Promise.all([
    listScopedGates(scopeFilter),
    buildDirectionIndex(scopeFilter),
    registryTotals(scopeFilter, now),
    VehicleLog.findOne(scopeFilter).select('created_datetime').sort({ created_datetime: 1 }).lean(),
    VehicleLog.findOne(scopeFilter).select('created_datetime').sort({ created_datetime: -1 }).lean(),
  ]);

  // The local calendar date, which is what the report endpoints take as a bare
  // `from`/`to`. Formatting the instant as UTC instead would hand an IST caller
  // yesterday's date every evening after 18:30.
  const asDate = (date) => bucketKey(date, 'day', zone);

  const monthStart = bucketStart(now, 'month', zone);

  const nowParts = zonedParts(now, zone);
  const twelveMonthsAgo = instantFromZoned(
    { year: nowParts.year, month: nowParts.month - 11, day: 1 },
    zone
  );

  log.info('Analytics filters listed', {
    projects: gates.projects.length,
    devices: devices.length,
  });

  return {
    projects: gates.projects,
    device_names: gates.device_names,

    // Every gate with the direction the reports will actually use for it, and
    // where that direction came from. A UI can show "3 gates have no direction
    // set" from this alone.
    devices: devices.map((device) => ({
      group_id: device.group_id,
      device_name: device.device_name,
      label: device.label,
      configured_direction: device.configured_direction,
      direction: device.direction,
      direction_source: device.direction_source,
      is_active: device.is_active,
    })),

    directions: ['entry', 'exit'],
    granularities: [...ANALYTICS_GRANULARITIES],
    vehicle_types: [...VEHICLE_TYPES],

    detected_between: {
      from: oldest?.created_datetime ?? null,
      to: newest?.created_datetime ?? null,
    },

    // The chips above a chart. Send these values back verbatim.
    quick_ranges: [
      {
        key: 'today',
        label: 'Today',
        from: asDate(now),
        to: asDate(now),
        granularity: 'hour',
      },
      {
        key: 'last_7_days',
        label: 'Last 7 days',
        from: asDate(shiftZonedDays(now, -6, zone)),
        to: asDate(now),
        granularity: 'day',
      },
      {
        key: 'last_30_days',
        label: 'Last 30 days',
        from: asDate(shiftZonedDays(now, -29, zone)),
        to: asDate(now),
        granularity: 'day',
      },
      {
        key: 'this_month',
        label: 'This month',
        from: asDate(monthStart),
        to: asDate(now),
        granularity: 'day',
      },
      {
        key: 'last_12_months',
        label: 'Last 12 months',
        from: asDate(twelveMonthsAgo),
        to: asDate(now),
        granularity: 'month',
      },
    ],

    // Standing registry counts, so the filter call alone is enough to paint the
    // registered-vehicles tile before the heavier reports come back.
    registered_vehicles: registry.total,

    defaults: {
      timezone: DEFAULT_REPORT_TIMEZONE,
      granularity: ANALYTICS_DEFAULT_GRANULARITY,
      span_days: ANALYTICS_DEFAULT_SPAN_DAYS,
    },

    // So a client does not have to hard-code the ceiling the API enforces.
    limits: { max_buckets: ANALYTICS_MAX_BUCKETS },

    // The timezone these ranges were resolved in — echo it back on the report
    // calls, or the buckets will not line up with the chips.
    timezone: zone,
  };
};

module.exports = {
  getSummary,
  getTrafficSeries,
  getAnalyticsFilters,
  buildDirectionIndex,
  inferDirection,
  resolveWindow,
};
