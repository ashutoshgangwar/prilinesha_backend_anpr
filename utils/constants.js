/**
 * Domain constants shared by validators, the Mongoose model and Swagger docs.
 * Single source of truth — never re-declare these lists elsewhere.
 */

const VEHICLE_CLASSES = ['bus', 'car', 'bike', 'truck', 'auto'];

const VEHICLE_COLORS = ['White', 'Gray', 'Yellow', 'Red', 'Green', 'Blue', 'Black'];

/** Registration status of the detected vehicle, as exposed on the Intozi feed. */
const VEHICLE_TYPES = ['registered', 'unregistered'];

/** A vehicle is treated as unregistered until it is positively known otherwise. */
const DEFAULT_VEHICLE_TYPE = 'unregistered';

/**
 * The complete set of fields the Intozi feed (GET /api/feed) discloses. It reads
 * the registered-vehicle registry, and returns only these keys — the owner's
 * name and their phone number stay internal.
 *
 * `device_names` is on the list because a registration can be limited to
 * specific gates, and a feed that omits them tells Intozi a plate is
 * "registered" without saying where. The barrier decision needs both. It is the
 * gate names only — no labels, no directions, nothing else off the project.
 *
 * The list is disclosed as stored, with no derived "valid at every gate" flag
 * alongside it: the dashboard resolves the operator's selection into an explicit
 * list when the vehicle is registered, so the feed states gates rather than
 * asking a consumer to interpret a wildcard.
 *
 * Kept as a list so a test can assert the response shape exactly, rather than
 * trusting that nothing was added to the projection by accident.
 */
const FEED_DISCLOSED_FIELDS = [
  'vehicle_number',
  'group_id',
  'vehicle_type',
  'device_names',
  // Added with the change feed. The other four say what the vehicle's access
  // *is*; this says what just happened to it, which is the one thing a consumer
  // applying changes to a local list cannot infer — specifically, DELETED, where
  // the underlying row no longer exists to be described at all.
  //
  // Deliberately not accompanied by `changed_at`, `source`, or the source row's
  // id: none of them changes a barrier decision, and the internal id of a
  // registration is nobody's business outside this system. The cursor carries
  // the ordering, opaquely.
  'event_type',
];

/** Paging limits for the Intozi polling feed. */
const FEED_DEFAULT_LIMIT = 100;
const FEED_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Access-change log (the Intozi feed's source)
// ---------------------------------------------------------------------------

/**
 * What happened to a vehicle's access, as recorded in the change log.
 *
 * The feed is a stream of these, not a list of vehicles: Intozi keeps its own
 * allow-list and applies each event to it. `vehicle_type` on the row still says
 * whether the vehicle ends up allowed in, so a consumer that only understands
 * registered/unregistered keeps working; `event_type` says *why*, which is what
 * distinguishes "this row is gone" from "this row is currently out of date".
 *
 *   CREATED   — first time this vehicle became known to the project.
 *   UPDATED   — its access details changed and it is still on the list. Also how
 *               a future-dated visitor pass reports that its window just opened.
 *   SUSPENDED — a registration was switched off from the dashboard.
 *   REVOKED   — a visitor pass was withdrawn before its window closed.
 *   EXPIRED   — the clock passed valid_till. Emitted by the sweeper, because
 *               time passing writes nothing to the row (see jobs/accessSweeper).
 *   DELETED   — the row was removed outright. A tombstone: the record no longer
 *               exists, so this event is the only thing that can ever tell
 *               Intozi to drop the plate.
 *
 * SUSPENDED and REVOKED are the same instruction to a barrier ("stop letting it
 * in") and are kept apart because the two collections mean different things by
 * it, and an operator reading the log needs to see which one happened.
 */
const ACCESS_EVENT_TYPES = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  REVOKED: 'REVOKED',
  SUSPENDED: 'SUSPENDED',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
};

const ACCESS_EVENT_VALUES = Object.values(ACCESS_EVENT_TYPES);

/** Which access list a change came from. Internal — never disclosed on the feed. */
const ACCESS_CHANGE_SOURCES = {
  REGISTRATION: 'registration',
  VISITOR: 'visitor',
};

const ACCESS_CHANGE_SOURCE_VALUES = Object.values(ACCESS_CHANGE_SOURCES);

/**
 * How many rows one sweeper pass claims at a time, and how many passes it will
 * make in a single tick.
 *
 * The product is the ceiling on work per tick: with several lakh vehicles, the
 * first sweep after a long outage could otherwise try to expire tens of
 * thousands of rows in one go and hold the event loop. Whatever is left is
 * picked up on the next tick, and nothing is lost — the query is driven by an
 * index on (marker, valid_till), so the remaining rows are exactly as cheap to
 * find next time.
 */
const EXPIRY_SWEEP_BATCH_SIZE = 500;
const EXPIRY_SWEEP_MAX_BATCHES = 20;

/** Page sizes for the dashboard's registered-vehicle table. */
const REGISTRY_DEFAULT_LIMIT = 25;
const REGISTRY_MAX_LIMIT = 200;

/** Page sizes for the project and user tables. */
const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;

/**
 * Page sizes for the dashboard's detection-log table. Higher ceiling than the
 * other lists because a log is the one table an operator genuinely scrolls, and
 * the rows are narrow.
 */
const LOG_DEFAULT_LIMIT = 25;
const LOG_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reporting (dashboard charts and totals)
// ---------------------------------------------------------------------------

/**
 * Which way traffic flows through a gate, as stored on Project.devices[].direction.
 *
 * This is what turns a detection into an entry or an exit: the reports read the
 * direction configured on the gate the event names. `both` is a real answer for a
 * single-lane gate, and an honest one — it says the event cannot be attributed to
 * either side, so those detections are counted separately rather than guessed at.
 */
const GATE_DIRECTIONS = ['entry', 'exit', 'both'];

/** Time buckets the traffic report can group by. */
const ANALYTICS_GRANULARITIES = ['hour', 'day', 'week', 'month'];

/** Per day, because that is the question a site operator actually asks. */
const ANALYTICS_DEFAULT_GRANULARITY = 'day';

/**
 * How far back a report looks when the caller names no window, per granularity.
 * Each lands on a chart that is readable without scrolling: two days of hours,
 * a month of days, a quarter of weeks, a year of months.
 */
const ANALYTICS_DEFAULT_SPAN_DAYS = { hour: 2, day: 30, week: 84, month: 365 };

/**
 * Ceiling on points in one response. A chart with more than this is unreadable
 * anyway, and the limit is what stops `granularity=hour&from=2020-01-01` from
 * building a 50,000-point array. Exceeding it is a 400 that says how to narrow.
 */
const ANALYTICS_MAX_BUCKETS = 750;

/**
 * The timezone the reports bucket by unless the caller names another.
 *
 * Deliberately not UTC: every site running this is in IST, and a vehicle
 * entering at 04:00 local belongs to that morning's count, not to the previous
 * day's. Callers elsewhere send `?timezone=` with any IANA name.
 */
const DEFAULT_REPORT_TIMEZONE = 'Asia/Kolkata';

/**
 * What kind of site a project is. Chosen by the super admin when the project is
 * created, and fixed thereafter in practice — a parking lot does not become a
 * society. Nothing branches on it yet; it exists so the dashboard can group and
 * filter sites, and so reporting can tell the two kinds apart later.
 */
const PROJECT_TYPES = ['parking', 'society'];

/**
 * Who a vehicle belongs to at a site — the answer to "why is this plate allowed
 * in?", which the two site types phrase differently:
 *
 *   resident — lives in the society. The permanent occupant of a `society`.
 *   tenant   — rents a bay or a unit in the parking project. Same idea, the word
 *              the customer actually uses.
 *   visitor  — here today for somebody else, at both kinds of site. Stored in
 *              its own collection (models/Visitor.js), never on the registry:
 *              a visitor pass is a window with a host attached, and folding it
 *              into a permanent registration would mean a row that is sometimes
 *              a person who lives here and sometimes one who does not.
 */
const OCCUPANT_TYPES = ['resident', 'tenant', 'visitor'];

/** The visitor kind, kept as a constant so nothing has to spell it. */
const VISITOR_OCCUPANT_TYPE = 'visitor';

/**
 * The permanent occupant kind each site type has. This is the whole rule: a
 * society has residents, a parking project has tenants, and neither has the
 * other's. `POST /api/vehicles` fills the field in from the project when the
 * caller omits it, and rejects the wrong one outright.
 */
const PROJECT_TYPE_OCCUPANTS = {
  society: 'resident',
  parking: 'tenant',
};

/** Occupant kinds a registration (not a visitor pass) may hold. */
const RESIDENT_OCCUPANT_TYPES = Object.values(PROJECT_TYPE_OCCUPANTS);

/**
 * @param {string|null} projectType One of PROJECT_TYPES.
 * @returns {string|null} 'resident' | 'tenant', or null for a project whose type
 *          was never set — those predate the field and must keep saving.
 */
const occupantTypeForProjectType = (projectType) =>
  PROJECT_TYPE_OCCUPANTS[String(projectType ?? '').trim().toLowerCase()] ?? null;

/**
 * How long a visitor pass may run for.
 *
 * A visitor is somebody here for an afternoon, an evening, a week of work at a
 * flat — the window is the point of the record, and it is what makes the plate
 * read as unregistered again once it closes. The ceiling stops "visitor" being
 * used to grant a year of access without going through the registry, where a
 * permanent occupant belongs and where renewals are actually reviewed.
 */
const MAX_VISITOR_PASS_DAYS = 30;

/** Page sizes for the dashboard's visitor table — same shape as the registry. */
const VISITOR_DEFAULT_LIMIT = 25;
const VISITOR_MAX_LIMIT = 200;

/**
 * How many gates a single project may have.
 *
 * A project with no devices cannot receive anything, so one is the floor and it
 * is enforced on create and on removal — the last gate cannot be deleted.
 *
 * The ceiling is what keeps the project document small: it is loaded and
 * re-saved on every ingested event, so the device list is on the hot path, not
 * just in storage. Fifty is far above any real site and low enough that a
 * misconfigured camera auto-registering junk names stops early. Raising it is
 * safe; it is a policy number, not a structural one.
 */
const MIN_DEVICES_PER_PROJECT = 1;
const MAX_DEVICES_PER_PROJECT = 50;

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/**
 * Who a logged-in dashboard user is.
 *
 * `super_admin` is internal (Prilinesha) and sees every project.
 * `admin` is the customer's own operator and sees only the projects assigned
 * to them. There is deliberately no third role: everything else is expressed as
 * a permission below, so a new capability never needs a new role.
 */
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
};

const ROLE_VALUES = Object.values(ROLES);

/** Role given to anyone who signs up: a customer admin with no projects yet. */
const DEFAULT_ROLE = ROLES.ADMIN;

/**
 * The unit of authorisation. Routes ask for a permission, never for a role, so
 * adding an API later means adding one entry here and listing it under whichever
 * roles should have it — no route or middleware has to change.
 */
const PERMISSIONS = {
  // Projects (group_id) and their devices
  PROJECT_CREATE: 'project:create',
  PROJECT_READ: 'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_ROTATE_KEY: 'project:rotate_key',
  PROJECT_DEVICE_MANAGE: 'project:device_manage',

  // Dashboard users
  USER_READ: 'user:read',
  USER_MANAGE: 'user:manage', // create, activate/deactivate, change role
  USER_ASSIGN_PROJECT: 'user:assign_project',

  // Registered-vehicle registry
  VEHICLE_READ: 'vehicle:read',
  VEHICLE_WRITE: 'vehicle:write',

  // Visitor passes. Separate from the registry permissions on purpose: letting
  // the gate desk issue an afternoon's pass is a much smaller grant than letting
  // them add a permanent resident, and a role that should only do the first is
  // now expressible without a code change.
  VISITOR_READ: 'visitor:read',
  VISITOR_WRITE: 'visitor:write',

  // ANPR detection events
  EVENT_READ: 'event:read',
};

/**
 * Role → permissions. `super_admin` intentionally holds every permission by
 * construction, so a new permission is never accidentally withheld from
 * internal staff; `admin` is an explicit allow-list.
 */
const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),
  [ROLES.ADMIN]: [
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_DEVICE_MANAGE,
    PERMISSIONS.VEHICLE_READ,
    PERMISSIONS.VEHICLE_WRITE,
    PERMISSIONS.VISITOR_READ,
    PERMISSIONS.VISITOR_WRITE,
    PERMISSIONS.EVENT_READ,
  ],
};

/**
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
const roleHasPermission = (role, permission) =>
  Boolean(ROLE_PERMISSIONS[role]?.includes(permission));

/**
 * What role a customer's login gets, by the kind of site they run.
 *
 * Both site types land on `admin` today, so this map changes no behaviour. It
 * exists because the rule is "a customer contact is an operator of their own
 * site", not "everyone is an admin" — and stating it as a lookup means adding a
 * third PROJECT_TYPE later forces a decision here instead of silently inheriting
 * whatever the default happened to be.
 *
 * A `super_admin` is never produced by this path: that role is internal, and a
 * public-ish field like project_type must not be able to reach it.
 */
const PROJECT_TYPE_ROLES = {
  parking: ROLES.ADMIN,
  society: ROLES.ADMIN,
};

/**
 * @param {string} projectType One of PROJECT_TYPES.
 * @returns {string} The role to store on the customer's user record.
 */
const roleForProjectType = (projectType) => {
  const role = PROJECT_TYPE_ROLES[String(projectType ?? '').trim().toLowerCase()];
  // An unrecognised type still yields a customer-level account, never more.
  return role && role !== ROLES.SUPER_ADMIN ? role : ROLES.ADMIN;
};

/** How a request proved who it is — set by the auth middleware for logging. */
const AUTH_SUBJECT = {
  USER: 'user', // dashboard user holding a JWT
  PROJECT: 'project', // camera/Intozi holding a per-project API key
  ROOT: 'root', // legacy global API_KEY, unscoped
};

/** Prefix of every project API key, so a leaked key is recognisable on sight. */
const PROJECT_API_KEY_PREFIX = 'pk_';

const IMAGE_KIND = {
  EVENT: 'event',
  PLATE: 'plate',
};

/** Sub-directory (relative to UPLOAD_DIR) each image kind is written to. */
const IMAGE_DIRECTORIES = {
  [IMAGE_KIND.EVENT]: 'event-images',
  [IMAGE_KIND.PLATE]: 'plate-images',
};

module.exports = {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  DEFAULT_VEHICLE_TYPE,
  FEED_DISCLOSED_FIELDS,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  ACCESS_EVENT_TYPES,
  ACCESS_EVENT_VALUES,
  ACCESS_CHANGE_SOURCES,
  ACCESS_CHANGE_SOURCE_VALUES,
  EXPIRY_SWEEP_BATCH_SIZE,
  EXPIRY_SWEEP_MAX_BATCHES,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_MAX_LIMIT,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LOG_DEFAULT_LIMIT,
  LOG_MAX_LIMIT,
  GATE_DIRECTIONS,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_DEFAULT_GRANULARITY,
  ANALYTICS_DEFAULT_SPAN_DAYS,
  ANALYTICS_MAX_BUCKETS,
  DEFAULT_REPORT_TIMEZONE,
  PROJECT_TYPES,
  OCCUPANT_TYPES,
  VISITOR_OCCUPANT_TYPE,
  PROJECT_TYPE_OCCUPANTS,
  RESIDENT_OCCUPANT_TYPES,
  occupantTypeForProjectType,
  MAX_VISITOR_PASS_DAYS,
  VISITOR_DEFAULT_LIMIT,
  VISITOR_MAX_LIMIT,
  MIN_DEVICES_PER_PROJECT,
  MAX_DEVICES_PER_PROJECT,
  ROLES,
  ROLE_VALUES,
  DEFAULT_ROLE,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
  PROJECT_TYPE_ROLES,
  roleForProjectType,
  AUTH_SUBJECT,
  PROJECT_API_KEY_PREFIX,
  IMAGE_KIND,
  IMAGE_DIRECTORIES,
};
