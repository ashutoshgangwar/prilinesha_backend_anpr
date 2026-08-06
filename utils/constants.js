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
 * the registered-vehicle registry, and returns only these three keys — the
 * owner's name, their phone number and the gate list stay internal.
 *
 * Kept as a list so a test can assert the response shape exactly, rather than
 * trusting that nothing was added to the projection by accident.
 */
const FEED_DISCLOSED_FIELDS = ['vehicle_number', 'group_id', 'vehicle_type'];

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
 * What kind of site a project is. Chosen by the super admin when the project is
 * created, and fixed thereafter in practice — a parking lot does not become a
 * society. Nothing branches on it yet; it exists so the dashboard can group and
 * filter sites, and so reporting can tell the two kinds apart later.
 */
const PROJECT_TYPES = ['parking', 'society'];

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
  PROJECT_TYPES,
  ROLES,
  ROLE_VALUES,
  DEFAULT_ROLE,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
  AUTH_SUBJECT,
  PROJECT_API_KEY_PREFIX,
  IMAGE_KIND,
  IMAGE_DIRECTORIES,
};
