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
const FEED_DISCLOSED_FIELDS = ['vehicle_number', 'group_id', 'vehicle_type', 'device_names'];

/** Paging limits for the Intozi polling feed. */
const FEED_DEFAULT_LIMIT = 100;
const FEED_MAX_LIMIT = 1000;

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
