const Project = require('../models/Project');
const User = require('../models/User');
const VehicleLog = require('../models/VehicleLog');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { generateProjectApiKey, hashApiKey, keyLast4 } = require('../utils/apiKeys');
const { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } = require('../utils/constants');

/**
 * Projects — the tenant registry.
 *
 * A project is created by a super admin, who tells the customer two things: the
 * `group_id` to put on every Intozi event, and the API key to authenticate with.
 * Everything downstream (devices, registered vehicles, the polling feed, which
 * dashboard user sees what) hangs off that one identifier.
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turns a project name into a candidate group_id: "Acme Mall, Phase 2" becomes
 * "ACME_MALL_PHASE_2". Anything outside the identifier's character set collapses
 * to a single underscore, because the result has to be typed by hand into an
 * Intozi configuration.
 *
 * @param {string} projectName
 * @returns {string} Possibly empty, if the name was all punctuation.
 */
const slugifyGroupId = (projectName) =>
  String(projectName ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/, '');

/**
 * Picks a free group_id derived from the project name.
 *
 * The super admin's form asks for a name, an address and a type — not for an
 * identifier — so one is derived here. A collision appends _2, _3, … rather than
 * failing, since two customers may legitimately both be called "City Parking".
 *
 * @param {string} projectName
 * @returns {Promise<string>}
 * @throws {AppError} 400 when the name yields no usable identifier.
 */
const deriveGroupId = async (projectName) => {
  const base = slugifyGroupId(projectName);

  if (base.length < 2) {
    throw AppError.badRequest(
      'Could not derive a group_id from that project_name. Send an explicit group_id.',
      [{ field: 'group_id', message: 'group_id is required for this project_name.' }]
    );
  }

  // One query rather than a probe per attempt: everything already taken that
  // starts with this base, so the suffix can be chosen in memory.
  const taken = new Set(
    (
      await Project.find({ group_id: new RegExp(`^${escapeRegex(base)}(_\\d+)?$`) })
        .select('group_id')
        .lean()
    ).map((project) => project.group_id)
  );

  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    // Keep room for the suffix inside the 50-character limit.
    const candidate = `${base.slice(0, 50 - String(suffix).length - 1)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw AppError.conflict(
    `Too many projects derive the group_id "${base}". Send an explicit group_id.`
  );
};

/** Shapes a project for the dashboard. Never includes the key hash. */
const toProjectRecord = (project) => ({
  id: String(project._id),
  group_id: project.group_id,
  project_name: project.project_name,
  address: project.address ?? null,
  project_type: project.project_type ?? null,
  description: project.description ?? null,
  customer_name: project.customer_name ?? null,
  contact_email: project.contact_email ?? null,
  contact_phone: project.contact_phone ?? null,
  devices: (project.devices ?? []).map((device) => ({
    id: String(device._id),
    device_name: device.device_name,
    label: device.label ?? null,
    direction: device.direction ?? null,
    auto_registered: Boolean(device.auto_registered),
    last_seen_at: device.last_seen_at ?? null,
    is_active: device.is_active !== false,
  })),
  device_count: (project.devices ?? []).length,
  // Enough to identify the installed key, not enough to reproduce it.
  api_key_last4: project.api_key_last4 ?? null,
  api_key_rotated_at: project.api_key_rotated_at ?? null,
  is_active: project.is_active,
  created_at: project.createdAt,
  updated_at: project.updatedAt,
});

/**
 * Loads a project by group_id or fails with a 404.
 *
 * @param {string} groupId
 * @returns {Promise<object>} Mongoose document.
 * @throws {AppError} 404
 */
const findProjectOrFail = async (groupId) => {
  const normalised = String(groupId || '').trim().toUpperCase();
  const project = await Project.findOne({ group_id: normalised });

  if (!project) throw AppError.notFound(`No project found with group_id "${normalised}".`);

  return project;
};

/**
 * Creates a project and issues its Intozi API key.
 *
 * The plaintext key is returned once, here, and never again — only its SHA-256
 * is stored. Losing it means rotating, not recovering.
 *
 * @param {object} payload Validated: group_id, project_name, devices?, …
 * @param {object} [context]
 * @param {object} [context.actor]     The super admin performing the action.
 * @param {string} [context.requestId]
 * @returns {Promise<{ project: object, api_key: string }>}
 * @throws {AppError} 409 when group_id is taken.
 */
const createProject = async (payload, { actor, requestId } = {}) => {
  // Derived when the caller did not name one — see deriveGroupId.
  const groupId = payload.group_id
    ? String(payload.group_id).trim().toUpperCase()
    : await deriveGroupId(payload.project_name);

  const log = logger.child({ requestId, group_id: groupId });

  const existing = await Project.findOne({ group_id: groupId }).select('_id').lean();
  if (existing) {
    throw AppError.conflict(
      `group_id "${groupId}" is already in use. Pick another identifier for this project.`
    );
  }

  const apiKey = generateProjectApiKey(groupId);

  try {
    const project = await Project.create({
      group_id: groupId,
      project_name: payload.project_name,
      address: payload.address ?? null,
      project_type: payload.project_type ?? null,
      description: payload.description ?? null,
      customer_name: payload.customer_name ?? null,
      contact_email: payload.contact_email ?? null,
      contact_phone: payload.contact_phone ?? null,
      devices: (payload.devices ?? []).map((device) => ({
        device_name: device.device_name,
        label: device.label ?? null,
        direction: device.direction ?? null,
        auto_registered: false,
        is_active: true,
      })),
      api_key_hash: hashApiKey(apiKey),
      api_key_last4: keyLast4(apiKey),
      api_key_rotated_at: new Date(),
      is_active: true,
      created_by: actor ? actor._id : null,
    });

    log.info('Project created', {
      projectId: String(project._id),
      devices: project.devices.length,
      by: actor ? String(actor._id) : 'system',
    });

    return { project: toProjectRecord(project), api_key: apiKey };
  } catch (error) {
    if (error.code === 11000) {
      throw AppError.conflict(`group_id "${groupId}" is already in use.`);
    }
    throw error;
  }
};

/**
 * Lists projects visible to the caller.
 *
 * A super admin sees every project; a customer admin sees only the ones
 * assigned to them, which is `scopeFilter`'s job (see middleware/auth.js).
 *
 * @param {object} params  search?, is_active?, page?, limit?
 * @param {object} scopeFilter Mongo fragment from buildScopeFilter().
 * @param {object} [context]
 * @returns {Promise<{ records: object[], pagination: object }>}
 */
const listProjects = async ({ search, is_active: isActive, page, limit } = {}, scopeFilter = {}, { requestId } = {}) => {
  const log = logger.child({ requestId });

  const pageSize = Math.min(Number(limit) || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const currentPage = Math.max(Number(page) || 1, 1);

  const filter = { ...scopeFilter };

  if (search) {
    const term = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ group_id: term }, { project_name: term }, { customer_name: term }];
  }

  if (isActive !== undefined && isActive !== null) filter.is_active = isActive;

  const [documents, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Project.countDocuments(filter),
  ]);

  log.info('Projects listed', { count: documents.length, total });

  return {
    records: documents.map(toProjectRecord),
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
 * One project, with live counts for its dashboard header.
 *
 * @param {string} groupId
 * @returns {Promise<object>}
 */
const getProject = async (groupId) => {
  const project = await findProjectOrFail(groupId);

  const [registeredVehicles, totalEvents, assignedUsers] = await Promise.all([
    RegisteredVehicle.countDocuments({ group_id: project.group_id }),
    VehicleLog.countDocuments({ group_id: project.group_id }),
    User.countDocuments({ projects: project.group_id }),
  ]);

  return {
    ...toProjectRecord(project),
    stats: {
      registered_vehicles: registeredVehicles,
      total_events: totalEvents,
      assigned_users: assignedUsers,
    },
  };
};

/**
 * Updates a project's descriptive fields.
 *
 * `group_id` is deliberately not updatable: it is the key stamped on every
 * event already ingested and configured on the cameras themselves. Changing it
 * would orphan that history. Create a new project instead.
 *
 * @param {string} groupId
 * @param {object} payload
 * @param {object} [context]
 * @returns {Promise<object>}
 */
const updateProject = async (groupId, payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId });
  const project = await findProjectOrFail(groupId);

  const updatable = [
    'project_name',
    'address',
    'project_type',
    'description',
    'customer_name',
    'contact_email',
    'contact_phone',
    'is_active',
  ];

  updatable.forEach((field) => {
    if (payload[field] !== undefined) project[field] = payload[field];
  });

  await project.save();

  log.info('Project updated', { by: actor ? String(actor._id) : 'system' });

  return toProjectRecord(project);
};

/**
 * Issues a new API key, invalidating the old one immediately.
 *
 * Cameras still holding the previous key start getting 401s the moment this
 * returns — that is the point of rotating, but it does mean the new key has to
 * reach the site before ingestion resumes.
 *
 * @param {string} groupId
 * @param {object} [context]
 * @returns {Promise<{ project: object, api_key: string }>}
 */
const rotateApiKey = async (groupId, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId });
  const project = await findProjectOrFail(groupId);

  const apiKey = generateProjectApiKey(project.group_id);

  project.api_key_hash = hashApiKey(apiKey);
  project.api_key_last4 = keyLast4(apiKey);
  project.api_key_rotated_at = new Date();

  await project.save();

  log.warn('Project API key rotated — the previous key is now invalid', {
    by: actor ? String(actor._id) : 'system',
  });

  return { project: toProjectRecord(project), api_key: apiKey };
};

/**
 * Adds a gate/camera to a project.
 *
 * Device names are unique within a project, case-insensitively, so "Entry1" and
 * "entry1" cannot become two gates that split one gate's traffic between them.
 *
 * @param {string} groupId
 * @param {object} payload Validated: device_name, label?, direction?
 * @returns {Promise<object>} The updated project.
 * @throws {AppError} 409 when the device name is taken.
 */
const addDevice = async (groupId, payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId, device: payload.device_name });
  const project = await findProjectOrFail(groupId);

  const existing = project.findDevice(payload.device_name);

  if (existing) {
    // A device the ingestion path auto-created is really a placeholder; naming
    // it properly from the dashboard should complete it, not be refused.
    if (existing.auto_registered) {
      existing.label = payload.label ?? existing.label;
      existing.direction = payload.direction ?? existing.direction;
      existing.auto_registered = false;
      await project.save();

      log.info('Auto-registered device confirmed from the dashboard');
      return toProjectRecord(project);
    }

    throw AppError.conflict(
      `Device "${payload.device_name}" already exists in project ${project.group_id}.`
    );
  }

  project.devices.push({
    device_name: String(payload.device_name).trim(),
    label: payload.label ?? null,
    direction: payload.direction ?? null,
    auto_registered: false,
    is_active: true,
  });

  await project.save();

  log.info('Device added', { by: actor ? String(actor._id) : 'system' });

  return toProjectRecord(project);
};

/**
 * Updates or deactivates one device.
 *
 * @param {string} groupId
 * @param {string} deviceName
 * @param {object} payload label?, direction?, is_active?
 * @returns {Promise<object>} The updated project.
 * @throws {AppError} 404 when the device is unknown.
 */
const updateDevice = async (groupId, deviceName, payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId, device: deviceName });
  const project = await findProjectOrFail(groupId);

  const device = project.findDevice(deviceName);

  if (!device) {
    throw AppError.notFound(`No device named "${deviceName}" in project ${project.group_id}.`);
  }

  if (payload.label !== undefined) device.label = payload.label;
  if (payload.direction !== undefined) device.direction = payload.direction;
  if (payload.is_active !== undefined) device.is_active = payload.is_active;
  if (payload.label !== undefined || payload.direction !== undefined) {
    device.auto_registered = false;
  }

  await project.save();

  log.info('Device updated', { by: actor ? String(actor._id) : 'system' });

  return toProjectRecord(project);
};

/**
 * Removes a device from the project's list.
 *
 * Events already ingested from it are untouched — they record the device name
 * as sent, not a reference to this list, so history survives the removal.
 *
 * @param {string} groupId
 * @param {string} deviceName
 * @returns {Promise<object>} The updated project.
 */
const removeDevice = async (groupId, deviceName, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId, device: deviceName });
  const project = await findProjectOrFail(groupId);

  const device = project.findDevice(deviceName);

  if (!device) {
    throw AppError.notFound(`No device named "${deviceName}" in project ${project.group_id}.`);
  }

  device.deleteOne();
  await project.save();

  log.info('Device removed', { by: actor ? String(actor._id) : 'system' });

  return toProjectRecord(project);
};

/**
 * Records that a device just sent an event, adding it to the project if it is
 * not on the list yet.
 *
 * Auto-registering rather than rejecting is deliberate: a camera commissioned
 * on site before anyone updated the dashboard would otherwise have its events
 * dropped, which is a far worse failure than an unexpected row appearing in the
 * device table. The `auto_registered` flag is what surfaces it for review.
 *
 * Failures here are swallowed — losing a `last_seen_at` update must never fail
 * an ingestion that has already been accepted.
 *
 * @param {object} project Mongoose Project document.
 * @param {string} deviceName
 * @param {object} [context]
 */
const touchDevice = async (project, deviceName, { requestId } = {}) => {
  if (!project || !deviceName) return;

  try {
    const device = project.findDevice(deviceName);

    if (device) {
      device.last_seen_at = new Date();
    } else {
      project.devices.push({
        device_name: String(deviceName).trim(),
        auto_registered: true,
        last_seen_at: new Date(),
        is_active: true,
      });

      logger.warn('Unknown device auto-registered from an incoming event', {
        requestId,
        group_id: project.group_id,
        device_name: deviceName,
      });
    }

    await project.save();
  } catch (error) {
    logger.error('Failed to record device activity', {
      requestId,
      group_id: project.group_id,
      device_name: deviceName,
      error: error.message,
    });
  }
};

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  rotateApiKey,
  addDevice,
  updateDevice,
  removeDevice,
  touchDevice,
  findProjectOrFail,
  toProjectRecord,
};
