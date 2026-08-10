const Project = require('../models/Project');
const User = require('../models/User');
const VehicleLog = require('../models/VehicleLog');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { generateProjectApiKey, hashApiKey, keyLast4 } = require('../utils/apiKeys');
const { generateInitialPassword } = require('../utils/passwords');
const {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MIN_DEVICES_PER_PROJECT,
  MAX_DEVICES_PER_PROJECT,
  ROLES,
  roleForProjectType,
} = require('../utils/constants');

/**
 * Projects — the tenant registry.
 *
 * A project is created by a super admin, who tells the customer two things: the
 * `group_id` to put on every Intozi event, and the API key to authenticate with.
 * Everything downstream (devices, registered vehicles, the polling feed, which
 * dashboard user sees what) hangs off that one identifier.
 *
 * A project has no name separate from its `group_id`. There used to be one, and
 * it only ever created the question of which of the two a screen should show;
 * the identifier the cameras are configured with is the answer in every case.
 * `project_name` is still written to the document, mirroring `group_id`, so the
 * field stays populated for rows and readers that predate this.
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shapes one gate for the dashboard and for the gate picker. */
const toDeviceRecord = (device) => ({
  id: String(device._id),
  device_name: device.device_name,
  label: device.label ?? null,
  direction: device.direction ?? null,
  auto_registered: Boolean(device.auto_registered),
  last_seen_at: device.last_seen_at ?? null,
  is_active: device.is_active !== false,
});

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
  devices: (project.devices ?? []).map(toDeviceRecord),
  device_count: (project.devices ?? []).length,
  // Enough to identify the installed key, not enough to reproduce it.
  api_key_last4: project.api_key_last4 ?? null,
  api_key_rotated_at: project.api_key_rotated_at ?? null,
  is_active: project.is_active,
  created_at: project.createdAt,
  updated_at: project.updatedAt,
});

/**
 * Throws unless this user still has somewhere to log in to.
 *
 * Deactivating a project takes its customer's admins offline with it. Without
 * this they would still authenticate and land on a dashboard scoped to a
 * project that rejects every read — an empty screen with no explanation, which
 * reads as a broken product rather than as a suspended account.
 *
 * Three cases, and the middle one is the deliberate exception:
 *
 *   super admin        — never blocked. Internal staff are unscoped, and they
 *                        are the ones who have to log in to switch it back on.
 *   no projects at all  — allowed. This is a fresh signup, not a suspension;
 *                        nothing was deactivated underneath them. They see an
 *                        empty dashboard until a super admin assigns them one.
 *   projects, none live — blocked. Every project they hold is switched off.
 *
 * Called from login, from refresh, and from the authenticate middleware, so a
 * deactivation lands on the customer's very next request rather than whenever
 * their access token happens to expire.
 *
 * @param {object} user Mongoose User document (or lean equivalent).
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<void>}
 * @throws {AppError} 403 when every assigned project is inactive.
 */
const assertDashboardAccess = async (user, { requestId } = {}) => {
  if (!user) throw AppError.unauthorized('Authentication required.');
  if (user.role === ROLES.SUPER_ADMIN) return;

  const assigned = user.projects ?? [];
  if (!assigned.length) return;

  const active = await Project.countDocuments({
    group_id: { $in: [...assigned] },
    is_active: true,
  });

  if (active > 0) return;

  logger.warn('Dashboard access refused: every assigned project is deactivated', {
    requestId,
    userId: String(user._id),
    projects: [...assigned],
  });

  throw AppError.forbidden(
    assigned.length === 1
      ? `Project "${assigned[0]}" has been deactivated, so this account cannot sign in. Contact your administrator.`
      : 'Every project on this account has been deactivated, so it cannot sign in. Contact your administrator.'
  );
};

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
 * Gives the customer contact a dashboard login for the project just created.
 *
 * This is signup, performed on the customer's behalf: it writes the same User
 * row `POST /api/auth/signup` would, from the contact fields the super admin has
 * already typed. `contact_email` becomes the username, `contact_phone` the
 * phone number, `customer_name` the display name, and the password is either
 * the one supplied or one generated here. The role comes from the project's
 * type — see roleForProjectType.
 *
 * Two outcomes, and telling them apart is the whole point of this function:
 *
 *   the address is new       — an `admin` account is created holding this one
 *                              project. A password is used if one was sent, and
 *                              generated if not; either way the plaintext is
 *                              returned once, here.
 *   the address already has  — the account is left completely alone and the
 *   an account                 project is *added* to what it already holds.
 *                              Their password is not touched and not returned.
 *                              Someone administering two sites is one person
 *                              with one login, and silently resetting their
 *                              password to set up a third would lock them out
 *                              of the first two.
 *
 * A super admin's account is never converted into a customer login: they are
 * unscoped by role, and putting a project list on one would read as a
 * restriction it is not.
 *
 * @param {object} project Freshly created Project document.
 * @param {object} payload The create-project payload.
 * @param {object} [context]
 * @returns {Promise<object>} The `login` block for the response.
 * @throws {AppError} 400 when contact_email is missing.
 */
const provisionCustomerLogin = async (project, payload, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: project.group_id });

  const email = String(payload.contact_email ?? '').trim().toLowerCase();

  if (!email) {
    throw AppError.badRequest('contact_email is required to create a login.', [
      {
        field: 'contact_email',
        message: 'This address becomes the customer’s username, so it cannot be blank.',
      },
    ]);
  }

  const existing = await User.findOne({ email });

  if (existing) {
    if (existing.role === ROLES.SUPER_ADMIN) {
      log.info('Contact address belongs to a super admin; no assignment needed');
      return {
        created: false,
        already_existed: true,
        user_id: String(existing._id),
        email,
        password_set: 'unchanged',
        note: 'This address belongs to a super admin, who already sees every project. Nothing was changed.',
      };
    }

    const assigned = new Set(existing.projects ?? []);
    const alreadyHad = assigned.has(project.group_id);

    if (!alreadyHad) {
      assigned.add(project.group_id);
      existing.projects = [...assigned];
      await existing.save();
    }

    log.info('Existing account assigned to the new project', {
      userId: String(existing._id),
      by: actor ? String(actor._id) : 'system',
    });

    return {
      created: false,
      already_existed: true,
      user_id: String(existing._id),
      email,
      name: existing.name,
      phone_number: existing.phone_number ?? null,
      role: existing.role,
      password_set: 'unchanged',
      note: 'This address already had an account, so the project was added to it. Their existing password still works and was not changed.',
    };
  }

  const generated = !payload.password;
  const password = payload.password || generateInitialPassword();

  // Whoever runs a parking lot or a society is that site's operator, so the
  // account is an `admin` — see roleForProjectType, which is where a new site
  // type would state its own answer.
  const role = roleForProjectType(project.project_type);

  // Everything a signup would have written, with the contact fields the super
  // admin already typed standing in for the form: contact_email is the
  // username, contact_phone the phone number, customer_name the display name.
  const user = await User.create({
    name: payload.customer_name || project.group_id,
    email,
    phone_number: payload.contact_phone ?? null,
    password_hash: password, // hashed by the model's pre-save hook
    role,
    projects: [project.group_id],
    is_active: true,
    created_by: actor ? actor._id : null,
  });

  log.info('Customer login created with the project', {
    userId: String(user._id),
    role,
    project_type: project.project_type ?? null,
    password: generated ? 'generated' : 'provided',
    by: actor ? String(actor._id) : 'system',
  });

  return {
    created: true,
    already_existed: false,
    user_id: String(user._id),
    email,
    name: user.name,
    phone_number: user.phone_number,
    role,
    // Echoed only when this system chose it — a password the caller already
    // knows does not need to be sent back, and returning it would put it in a
    // response log for no reason.
    password: generated ? password : undefined,
    password_set: generated ? 'generated' : 'provided',
    note: generated
      ? 'Store this password now — it is shown once and only its hash is kept. The customer should change it after signing in.'
      : 'The password you supplied is set on this account.',
  };
};

/**
 * Creates a project and issues its Intozi API key.
 *
 * The plaintext key is returned once, here, and never again — only its SHA-256
 * is stored. Losing it means rotating, not recovering.
 *
 * With `create_login: true` the customer's dashboard account is provisioned in
 * the same call, using `contact_email` as the username — see
 * provisionCustomerLogin. Without it the project is created alone, and access
 * is granted later through the user routes.
 *
 * @param {object} payload Validated: group_id, address, project_type, devices?,
 *                 create_login?, password?, contact_email?, …
 * @param {object} [context]
 * @param {object} [context.actor]     The super admin performing the action.
 * @param {string} [context.requestId]
 * @returns {Promise<{ project: object, api_key: string, login: object|null }>}
 * @throws {AppError} 409 when group_id is taken, 400 when a login was asked for
 *         without a contact_email, 409 when that address is taken mid-flight.
 */
const createProject = async (payload, { actor, requestId } = {}) => {
  const groupId = String(payload.group_id).trim().toUpperCase();
  const wantsLogin = payload.create_login === true;

  const log = logger.child({ requestId, group_id: groupId });

  const existing = await Project.findOne({ group_id: groupId }).select('_id').lean();
  if (existing) {
    throw AppError.conflict(
      `group_id "${groupId}" is already in use. Pick another identifier for this project.`
    );
  }

  // Checked before anything is written, so the common mistake — asking for a
  // login with no address to put it on — fails without leaving a project behind.
  if (wantsLogin && !String(payload.contact_email ?? '').trim()) {
    throw AppError.badRequest('contact_email is required to create a login.', [
      {
        field: 'contact_email',
        message: 'This address becomes the customer’s username, so it cannot be blank.',
      },
    ]);
  }

  const apiKey = generateProjectApiKey(groupId);

  try {
    const project = await Project.create({
      group_id: groupId,
      // The project has one name, and this is it — see the note at the top.
      project_name: groupId,
      address: payload.address ?? null,
      project_type: payload.project_type ?? null,
      description: payload.description ?? null,
      customer_name: payload.customer_name ?? null,
      contact_email: payload.contact_email ?? null,
      contact_phone: payload.contact_phone ?? null,
      devices: (payload.devices ?? []).map((device) => ({
        device_name: device.device_name,
        label: device.label ?? null,
        // Not settable on create — hard-coded rather than read from the payload,
        // because nothing strips unknown keys before this point and a stray
        // `direction` in the body would otherwise reach the document unvalidated.
        // The per-device routes are where a gate's direction gets set.
        direction: null,
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

    let login = null;

    if (wantsLogin) {
      try {
        login = await provisionCustomerLogin(project, payload, { actor, requestId });
      } catch (error) {
        // The project is already written at this point. There are no
        // transactions here, so the alternative to undoing it is returning a
        // half-built project the caller believes failed — and a group_id they
        // cannot reuse because it is silently taken. Remove it and report the
        // real error.
        await Project.deleteOne({ _id: project._id }).catch((cleanupError) => {
          log.error('Could not roll back the project after login provisioning failed', {
            projectId: String(project._id),
            error: cleanupError.message,
          });
        });

        log.warn('Project creation rolled back: the login could not be provisioned', {
          error: error.message,
        });

        if (error.code === 11000) {
          throw AppError.conflict(
            'An account with that contact_email was created moments ago. Retry, and the project will be assigned to it.'
          );
        }

        throw error;
      }
    }

    return { project: toProjectRecord(project), api_key: apiKey, login };
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
 * would orphan that history. Create a new project instead. Since the project's
 * name is that same identifier, it is not updatable either.
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
 * Deactivates a project. This is what DELETE means here — nothing is removed.
 *
 * A project is the key its whole history hangs off: every ingested event, every
 * registered vehicle and every user assignment is stored against `group_id`, not
 * against this document's id. Removing the row would orphan all of it, and
 * because `group_id` could be handed out again afterwards, the orphans would
 * reappear under whichever project claimed the identifier next. So the document
 * stays and the switch flips: the cameras stop being able to post, the feed
 * stops being readable, and the customer's admins can no longer sign in — see
 * assertDashboardAccess. That is what "delete this customer" actually means
 * operationally. `PATCH { "is_active": true }` puts all of it back.
 *
 * Idempotent — deleting an already-inactive project is a success, not a 409.
 *
 * @param {string} groupId
 * @param {object} [context]
 * @param {object} [context.actor]
 * @param {string} [context.requestId]
 * @returns {Promise<{ project: object, was_active: boolean, retained: object }>}
 * @throws {AppError} 404 when the project does not exist.
 */
const deactivateProject = async (groupId, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId });
  const project = await findProjectOrFail(groupId);

  const wasActive = project.is_active !== false;

  if (wasActive) {
    project.is_active = false;
    await project.save();
  }

  // Reported back so the caller can see what deactivating just took offline,
  // and what is still there to be restored.
  const [registeredVehicles, totalEvents, assignedUsers] = await Promise.all([
    RegisteredVehicle.countDocuments({ group_id: project.group_id }),
    VehicleLog.countDocuments({ group_id: project.group_id }),
    User.countDocuments({ projects: project.group_id }),
  ]);

  log.warn('Project deactivated — cameras blocked, feed closed, assigned admins locked out', {
    by: actor ? String(actor._id) : 'system',
    was_active: wasActive,
    retained_events: totalEvents,
    users_locked_out: assignedUsers,
  });

  return {
    project: toProjectRecord(project),
    was_active: wasActive,
    retained: {
      registered_vehicles: registeredVehicles,
      total_events: totalEvents,
      assigned_users: assignedUsers,
    },
  };
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
 * @throws {AppError} 409 when the device name is taken or the project is full.
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

  // Checked here rather than only in the validator, because the validator sees
  // one request while the ceiling is on the project as a whole.
  if (project.devices.length >= MAX_DEVICES_PER_PROJECT) {
    throw AppError.conflict(
      `Project ${project.group_id} already has the maximum of ${MAX_DEVICES_PER_PROJECT} devices. ` +
        'Remove one before adding another.'
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
 * The last gate cannot be removed: a project with an empty device list receives
 * nothing, and one that got there by deletion looks identical to one that was
 * set up correctly. Deactivate the project instead, which says so explicitly.
 *
 * @param {string} groupId
 * @param {string} deviceName
 * @returns {Promise<object>} The updated project.
 * @throws {AppError} 404 unknown device · 409 it is the only one left.
 */
const removeDevice = async (groupId, deviceName, { actor, requestId } = {}) => {
  const log = logger.child({ requestId, group_id: groupId, device: deviceName });
  const project = await findProjectOrFail(groupId);

  const device = project.findDevice(deviceName);

  if (!device) {
    throw AppError.notFound(`No device named "${deviceName}" in project ${project.group_id}.`);
  }

  if (project.devices.length <= MIN_DEVICES_PER_PROJECT) {
    throw AppError.conflict(
      `Project ${project.group_id} must keep at least ${MIN_DEVICES_PER_PROJECT} device. ` +
        'Add the replacement first, or deactivate the project.'
    );
  }

  device.deleteOne();
  await project.save();

  log.info('Device removed', { by: actor ? String(actor._id) : 'system' });

  return toProjectRecord(project);
};

/**
 * The gate list of a single project — nothing else.
 *
 * `GET /api/projects/{group_id}` already returns the devices, but it is super
 * admin only and it counts vehicles, events and users to build its header. The
 * one screen that needs this list is the vehicle-registration form, opened by a
 * customer admin who must not be able to read the project registry, and it needs
 * the gates and nothing more. So this is its own read: scoped by
 * `assertProjectAccess` rather than by role, and one indexed lookup with no
 * counts attached.
 *
 * Inactive gates are left out by default. A decommissioned camera should not be
 * offered as a choice on a form — but it stays visible with
 * `include_inactive=true`, so an admin screen can still show what a project has.
 *
 * @param {string} groupId
 * @param {object} [options]
 * @param {boolean} [options.includeInactive] Include gates switched off.
 * @returns {Promise<object>} The gates, plus the bare `device_names` array a
 *          picker can bind to directly.
 * @throws {AppError} 404 when the project does not exist.
 */
const listDevices = async (groupId, { includeInactive = false } = {}) => {
  const normalised = String(groupId || '').trim().toUpperCase();

  const project = await Project.findOne({ group_id: normalised })
    .select('group_id project_name is_active devices')
    .lean();

  if (!project) throw AppError.notFound(`No project found with group_id "${normalised}".`);

  const all = project.devices ?? [];
  const visible = includeInactive ? all : all.filter((device) => device.is_active !== false);

  return {
    group_id: project.group_id,
    project_name: project.project_name,
    project_is_active: project.is_active !== false,
    devices: visible.map(toDeviceRecord),
    // The same thing flattened, because that is the shape a form posts back in
    // `device_names` — a picker binds to this and returns a subset of it
    // verbatim, with no client-side mapping to get wrong.
    device_names: visible.map((device) => device.device_name),
    count: visible.length,
    // How many the project actually holds, so a UI can say "2 of 5 gates are
    // switched off" without a second call.
    total_count: all.length,
  };
};

/**
 * Turns a gate selection from the vehicle form into the list to store.
 *
 * Three inputs, and they mean different things:
 *
 *   allDevices: true — the operator ticked "all gates". Every active gate in the
 *                      project is written out **by name**, so the record states
 *                      which gates it was granted at rather than implying it.
 *   a list of names  — restricted to those gates. Matched case-insensitively
 *                      against the project and rewritten to the stored casing,
 *                      so "ENTRY1" and "entry1" cannot both end up on record for
 *                      one gate. An unknown name is a 400 listing the real ones,
 *                      never a silently-stored gate that no camera will ever
 *                      report.
 *   an empty list    — every gate, expressed as the legacy wildcard. Kept
 *                      working because it is what existing records hold and what
 *                      the feed already understands: `[]` means "no restriction".
 *
 * Note the difference between the first and the last: ticking "all gates" pins
 * the registration to the gates that exist *today*, so a gate added next month
 * is not automatically included, while `[]` follows the project. Expanding is
 * what the dashboard asked for — the stored record then says exactly what was
 * granted — but it does mean a new gate needs the vehicle re-saved.
 *
 * @param {string} groupId
 * @param {object} [selection]
 * @param {string[]} [selection.deviceNames]
 * @param {boolean} [selection.allDevices]
 * @returns {Promise<string[]|undefined>} The names to store, or `undefined` when
 *          the caller said nothing at all — which a PATCH must read as "leave
 *          the gate list alone".
 * @throws {AppError} 404 unknown project · 400 unknown gate name.
 */
const resolveDeviceNames = async (groupId, { deviceNames, allDevices } = {}) => {
  const wantsAll = allDevices === true;

  if (!wantsAll && deviceNames === undefined) return undefined;

  const normalised = String(groupId || '').trim().toUpperCase();

  const project = await Project.findOne({ group_id: normalised })
    .select('group_id devices')
    .lean();

  if (!project) throw AppError.notFound(`No project found with group_id "${normalised}".`);

  const active = (project.devices ?? []).filter((device) => device.is_active !== false);

  if (wantsAll) {
    if (!active.length) {
      throw AppError.badRequest(
        `Project ${project.group_id} has no active gates, so "all gates" selects nothing.`,
        [
          {
            field: 'all_devices',
            message: 'Add or re-enable a gate on the project first.',
          },
        ]
      );
    }

    return active.map((device) => device.device_name);
  }

  if (!deviceNames || !deviceNames.length) return [];

  // Stored casing wins, so the list on the record always matches the project.
  const byLowerName = new Map(
    active.map((device) => [device.device_name.toLowerCase(), device.device_name])
  );

  const unknown = [];
  const resolved = [];

  deviceNames.forEach((name) => {
    const match = byLowerName.get(String(name).trim().toLowerCase());
    if (!match) {
      unknown.push(name);
    } else if (!resolved.includes(match)) {
      resolved.push(match);
    }
  });

  if (unknown.length) {
    // A gate that exists but is switched off gets its own message. "No such
    // gate" would send someone looking for a typo in a name that is spelled
    // correctly and sitting right there in the project.
    const deactivated = new Set(
      (project.devices ?? [])
        .filter((device) => device.is_active === false)
        .map((device) => device.device_name.toLowerCase())
    );

    const switchedOff = unknown.filter((name) => deactivated.has(String(name).trim().toLowerCase()));
    const missing = unknown.filter((name) => !deactivated.has(String(name).trim().toLowerCase()));

    const quote = (names) => names.map((name) => `"${name}"`).join(', ');

    throw AppError.badRequest(
      missing.length
        ? `Project ${project.group_id} has no gate named ${quote(missing)}.`
        : `Gate ${quote(switchedOff)} is switched off in project ${project.group_id}.`,
      [
        {
          field: 'device_names',
          message: active.length
            ? `Valid gates for this project: ${active.map((device) => device.device_name).join(', ')}.`
            : 'This project has no active gates.',
        },
      ]
    );
  }

  return resolved;
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
    } else if (project.devices.length >= MAX_DEVICES_PER_PROJECT) {
      // At the ceiling, stop growing the list but keep the event. A project that
      // has hit 50 gates this way is almost always one camera posting a
      // malformed name on every event, and the alternative — an unbounded array
      // on the document re-saved by every ingest — is the worse outcome.
      logger.error('Device list is full; not auto-registering this gate', {
        requestId,
        group_id: project.group_id,
        device_name: deviceName,
        limit: MAX_DEVICES_PER_PROJECT,
      });
      return;
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
  deactivateProject,
  rotateApiKey,
  addDevice,
  updateDevice,
  removeDevice,
  listDevices,
  resolveDeviceNames,
  touchDevice,
  findProjectOrFail,
  toProjectRecord,
  toDeviceRecord,
  assertDashboardAccess,
};
