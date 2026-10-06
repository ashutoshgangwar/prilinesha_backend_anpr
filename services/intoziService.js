const RegisteredVehicle = require('../models/RegisteredVehicle');
const Visitor = require('../models/Visitor');
const logger = require('../utils/logger');
const config = require('../config/env');

/**
 * Outbound sync to Intozi's Ikshana Watchlist Registry.
 *
 * The integration direction reversed. Previously Intozi polled `GET /api/feed`
 * to pull our registry; now Prilinesha pushes every registration change to
 * Intozi's `manage_watchlist_anpr_app_db_data` API as it happens — add on
 * create, update on edit/renew, delete on suspend/expire/remove. The watchlist
 * on Intozi's side therefore holds exactly the vehicles that are currently
 * registered here.
 *
 * ## Two layers
 *
 * 1. Transport — addVehicle / updateVehicle / deleteVehicles / getWatchlist.
 *    Thin wrappers over the HTTP calls the PDF documents, each sending the
 *    required `x-api-key` header. These throw on a non-2xx so a caller that
 *    wants to know can.
 *
 * 2. Orchestration — syncRegistration / handleExpiredRegistrations. These map a
 *    Prilinesha registration onto the transport, decide add vs update vs delete,
 *    persist the ids Intozi returns, and **never throw**: a push runs inside a
 *    dashboard request (or the expiry sweep), and Intozi being down must not
 *    fail the operator's action or the sweep. A failed push is logged and marked
 *    on the row (`intozi.sync_status = 'failed'`) so it can be reconciled later.
 *
 * Nothing here runs unless INTOZI_SYNC_ENABLED is on and a base URL + key are
 * configured — otherwise every entry point is a no-op, which is what keeps a
 * deployment with no Intozi endpoint working unchanged.
 */

/** The two watchlist endpoints, relative to INTOZI_BASE_URL. */
const MANAGE_PATH = '/manage_watchlist_anpr_app_db_data';
const GET_PATH = '/get_watchlist_anpr_app_db_data';

/**
 * @returns {boolean} Whether outbound sync should run. Every orchestration entry
 *          point checks this first, so a deployment that has not set up Intozi
 *          (switch off, or no base URL / key) simply pushes nothing.
 */
const isEnabled = () =>
  Boolean(config.INTOZI_SYNC_ENABLED && config.INTOZI_BASE_URL && config.INTOZI_API_KEY);

/**
 * One HTTP round trip to Intozi, with the api-key header and a hard timeout.
 *
 * @param {string} method  GET | POST | PUT | DELETE
 * @param {string} path    One of MANAGE_PATH / GET_PATH.
 * @param {object} [bodyObj]
 * @param {object} [context]
 * @returns {Promise<object>} Parsed JSON body.
 * @throws {Error} On timeout, network failure, or a non-2xx status.
 */
const request = async (method, path, bodyObj, { requestId } = {}) => {
  const url = `${config.INTOZI_BASE_URL}${path}`;
  const log = logger.child({ requestId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.INTOZI_TIMEOUT_MS);

  const startedAt = Date.now();
  
  log.info('Intozi request →', {
    method,
    url,
    body: bodyObj ?? null,
  });

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.INTOZI_API_KEY,
      },
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
      signal: controller.signal,
    });

    // Intozi answers JSON; tolerate an empty or non-JSON body rather than
    // throwing a parse error over a perfectly good 200.
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    // The exact response Intozi returned — status and full body — logged whether
    // it succeeded or not, so "what came back when I added the vehicle" is always
    // answerable from the log.
    log[response.ok ? 'info' : 'error']('Intozi response ←', {
      method,
      path,
      status: response.status,
      ok: response.ok,
      duration_ms: Date.now() - startedAt,
      body: parsed,
    });

    if (!response.ok) {
      const err = new Error(`Intozi ${method} ${path} failed with HTTP ${response.status}`);
      err.status = response.status;
      err.body = parsed;
      throw err;
    }

    return parsed ?? {};
  } catch (error) {
    if (error.name === 'AbortError') {
      log.error('Intozi request timed out', {
        method,
        url,
        timeout_ms: config.INTOZI_TIMEOUT_MS,
      });
      const timeout = new Error(`Intozi ${method} ${path} timed out after ${config.INTOZI_TIMEOUT_MS}ms`);
      timeout.status = 'timeout';
      throw timeout;
    }

    // An HTTP-status error was already logged above with its body; only a genuine
    // transport/parse failure needs a line here.
    if (error.status === undefined) {
      log.error('Intozi request failed', { method, url, error: error.message });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Transport — one function per documented API call
// ---------------------------------------------------------------------------

/** POST manage_watchlist_anpr_app_db_data — add a vehicle to the watchlist. */
const addVehicle = (payload, context) => request('POST', MANAGE_PATH, payload, context);

/** PUT manage_watchlist_anpr_app_db_data — update an existing vehicle. */
const updateVehicle = (payload, context) => request('PUT', MANAGE_PATH, payload, context);

/**
 * DELETE manage_watchlist_anpr_app_db_data — remove vehicle records.
 * @param {number[]} dataIds Intozi record ids (`anpr_wl_id`s).
 */
const deleteVehicles = (dataIds, context) =>
  request('DELETE', MANAGE_PATH, { data_id: dataIds }, context);

/** POST get_watchlist_anpr_app_db_data — read the current watchlist (reconcile/debug). */
const getWatchlist = ({ page = 1, pageSize = 100, group } = {}, context) =>
  request(
    'POST',
    GET_PATH,
    { page: String(page), page_size: String(pageSize), ...(group !== undefined ? { group } : {}) },
    context
  );

// ---------------------------------------------------------------------------
// Mapping — Prilinesha registration -> Intozi payload
// ---------------------------------------------------------------------------

/**
 * Serialises the gate list the way Intozi stores the device_name custom field —
 * a stringified array, e.g. `["entry1","exit1"]`. Empty list ("every gate" on
 * our side) becomes `"[]"`.
 */
const encodeDeviceNames = (deviceNames) => JSON.stringify(deviceNames ?? []);

/** The custom_field_data block common to add and update (minus field_data_id). */
const customFieldData = (record) => [
  {
    field_id: config.INTOZI_FIELD_ID_DEVICE_NAME,
    custom_field_value: encodeDeviceNames(record.device_names),
  },
  {
    field_id: config.INTOZI_FIELD_ID_GROUP_ID,
    custom_field_value: record.group_id,
  },
];

/**
 * The add (POST) body for a registration.
 *
 * Deliberately minimal: Intozi is sent only the plate, the category, and the two
 * custom fields (camera = field_id 1, project/group = field_id 2). The holder's
 * name, phone, vehicle model and unit are **not** disclosed to Intozi — they stay
 * on the Prilinesha side.
 */
const toAddPayload = (record, vehicleCategory = config.INTOZI_DEFAULT_VEHICLE_CATEGORY) => ({
  vehicle_number: record.vehicle_number,
  vehicle_category_name: vehicleCategory,
  custom_field_data: customFieldData(record),
});

/**
 * The update (PUT) body. Same minimal field set as the add, plus `anpr_wl_id` to
 * identify the record and `field_data_id` on each custom field so Intozi edits
 * the existing entry in place rather than appending a new one. A field whose id
 * we never captured is sent without one — Intozi then treats it as a fresh field.
 */
const toUpdatePayload = (record, vehicleCategory = config.INTOZI_DEFAULT_VEHICLE_CATEGORY) => {
  const intozi = record.intozi ?? {};
  const fields = customFieldData(record);

  // Attach the stored field_data_ids by field_id.
  const withDataIds = fields.map((field) => {
    if (field.field_id === config.INTOZI_FIELD_ID_DEVICE_NAME && intozi.device_field_data_id != null) {
      return { ...field, field_data_id: intozi.device_field_data_id };
    }
    if (field.field_id === config.INTOZI_FIELD_ID_GROUP_ID && intozi.group_field_data_id != null) {
      return { ...field, field_data_id: intozi.group_field_data_id };
    }
    return field;
  });

  return {
    anpr_wl_id: intozi.anpr_wl_id,
    vehicle_category_name: vehicleCategory,
    image_updated: 0,
    custom_field_data: withDataIds,
  };
};

/**
 * Pulls the ids we need for later updates out of an add/update response.
 *
 * The record id is `data[0].id` (list response) or `id` (bare object), and each
 * custom field's `id` is the `field_data_id` to send back on an update, keyed by
 * its `field_id`.
 */
const extractIds = (response) => {
  const record = Array.isArray(response?.data) ? response.data[0] : response;
  if (!record) return null;

  const ids = { anpr_wl_id: record.id ?? null, device_field_data_id: null, group_field_data_id: null };

  for (const field of record.custom_fields ?? []) {
    if (field.field_id === config.INTOZI_FIELD_ID_DEVICE_NAME) ids.device_field_data_id = field.id ?? null;
    if (field.field_id === config.INTOZI_FIELD_ID_GROUP_ID) ids.group_field_data_id = field.id ?? null;
  }

  return ids;
};

// ---------------------------------------------------------------------------
// Persistence of sync state — written straight to the row, never via the
// service layer, so recording the push does not itself trigger another push.
// ---------------------------------------------------------------------------

// The `model` is RegisteredVehicle or Visitor — the two collections whose rows
// carry an `intozi` sub-object. The sync is identical for both; only where the
// ids are written back differs. `synced` is written only after a real call to
// Intozi succeeds.
const markSynced = (model, id, ids) =>
  model
    .updateOne(
      { _id: id },
      {
        $set: {
          'intozi.anpr_wl_id': ids.anpr_wl_id,
          'intozi.device_field_data_id': ids.device_field_data_id,
          'intozi.group_field_data_id': ids.group_field_data_id,
          'intozi.sync_status': 'synced',
          'intozi.synced_at': new Date(),
          'intozi.last_error': null,
        },
      }
    )
    .catch(() => {});

const markDeleted = (model, ids) =>
  model
    .updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          'intozi.anpr_wl_id': null,
          'intozi.device_field_data_id': null,
          'intozi.group_field_data_id': null,
          'intozi.sync_status': 'deleted',
          'intozi.synced_at': new Date(),
          'intozi.last_error': null,
        },
      }
    )
    .catch(() => {});

const markFailed = (model, id, error) =>
  model
    .updateOne(
      { _id: id },
      { $set: { 'intozi.sync_status': 'failed', 'intozi.last_error': String(error.message || error) } }
    )
    .catch(() => {});

// ---------------------------------------------------------------------------
// Orchestration — the entry points the service layer and sweeper call
// ---------------------------------------------------------------------------

/**
 * Pushes one registration's current state to Intozi. Never throws.
 *
 * The decision is driven by the resulting access state, not the event name, so
 * there is one rule for every path: a vehicle that should be allowed in is
 * present on the watchlist (added, or updated if already there); a vehicle that
 * should not is absent (deleted, if we ever put it there).
 *
 *   present  — CREATED / UPDATED while still registered
 *   absent   — SUSPENDED / EXPIRED / DELETED, or any change that leaves it
 *              unregistered
 *
 * @param {object} args
 * @param {object} args.record       The saved registration (document or lean) —
 *                                   needs _id, group_id, vehicle_number, name,
 *                                   phone_number, device_names, vehicle_model,
 *                                   unit_number and the `intozi` sub-object.
 * @param {string} args.eventType    One of ACCESS_EVENT_TYPES.
 * @param {string} args.vehicleType  'registered' | 'unregistered' — the state
 *                                   after the change, as the caller computed it.
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{action: string, ok: boolean}>}
 */
const syncRegistration = async (
  { record, eventType, vehicleType },
  { requestId, model = RegisteredVehicle, vehicleCategory = config.INTOZI_DEFAULT_VEHICLE_CATEGORY } = {}
) => {
  // Why a push did nothing is logged here rather than being silent, so "I changed
  // a vehicle but saw no Intozi line" always has an answer in the log.
  if (!record) return { action: 'skipped', ok: true, sync_status: null };

  const log = logger.child({
    requestId,
    group_id: record.group_id,
    vehicle_number: record.vehicle_number,
    source: model === RegisteredVehicle ? 'registration' : 'visitor',
  });

  if (!isEnabled()) {
    log.info('Intozi sync skipped (disabled)', {
      eventType,
      reason: !config.INTOZI_SYNC_ENABLED
        ? 'INTOZI_SYNC_ENABLED is not true'
        : 'INTOZI_BASE_URL or INTOZI_API_KEY is not set',
    });
    return { action: 'skipped', ok: true, sync_status: null };
  }

  const intozi = record.intozi ?? {};
  const shouldBePresent = eventType !== 'DELETED' && vehicleType === 'registered';

  log.info('Intozi sync starting', {
    eventType,
    vehicle_type: vehicleType,
    already_on_watchlist: intozi.anpr_wl_id != null,
    decision: !shouldBePresent
      ? intozi.anpr_wl_id == null
        ? 'noop (not registered, nothing on watchlist to remove)'
        : 'delete'
      : intozi.anpr_wl_id != null
        ? 'update'
        : 'add',
  });

  try {
    // ---- Should NOT be on the watchlist: delete the remote copy if we have one.
    if (!shouldBePresent) {
      if (intozi.anpr_wl_id == null) {
        log.info('Intozi sync: nothing to do', {
          reason: `vehicle is ${vehicleType} and has never been on the watchlist`,
        });
        return { action: 'noop', ok: true, sync_status: null };
      }

      await deleteVehicles([intozi.anpr_wl_id], { requestId });
      await markDeleted(model, [record._id]);
      log.info('Vehicle removed from Intozi watchlist', { anpr_wl_id: intozi.anpr_wl_id, eventType });
      return { action: 'delete', ok: true, sync_status: 'deleted', anpr_wl_id: null };
    }

    // ---- Should be on the watchlist, and already is: update in place.
    if (intozi.anpr_wl_id != null) {
      const response = await updateVehicle(toUpdatePayload(record, vehicleCategory), { requestId });
      const ids = extractIds(response) ?? { anpr_wl_id: intozi.anpr_wl_id };
      await markSynced(model, record._id, {
        anpr_wl_id: ids.anpr_wl_id ?? intozi.anpr_wl_id,
        device_field_data_id: ids.device_field_data_id ?? intozi.device_field_data_id,
        group_field_data_id: ids.group_field_data_id ?? intozi.group_field_data_id,
      });
      log.info('Vehicle updated on Intozi watchlist', { anpr_wl_id: intozi.anpr_wl_id });
      return { action: 'update', ok: true, sync_status: 'synced', anpr_wl_id: intozi.anpr_wl_id };
    }

    // ---- Should be on the watchlist, and is not yet: add it and store the ids.
    const response = await addVehicle(toAddPayload(record, vehicleCategory), { requestId });
    const ids = extractIds(response);
    if (ids && ids.anpr_wl_id != null) {
      await markSynced(model, record._id, ids);
      log.info('Vehicle added to Intozi watchlist', { anpr_wl_id: ids.anpr_wl_id });
    } else {
      // A 2xx with no id back means we cannot address the record for a later
      // update — treat it as a failed sync so a reconcile re-adds it.
      await markFailed(model, record._id, new Error('Intozi add returned no record id'));
      log.warn('Intozi add returned no record id; marked for reconcile');
      return { action: 'add', ok: false, sync_status: 'failed' };
    }
    return { action: 'add', ok: true, sync_status: 'synced', anpr_wl_id: ids.anpr_wl_id };
  } catch (error) {
    await markFailed(model, record._id, error);
    log.error('Intozi watchlist sync failed', {
      eventType,
      status: error.status ?? null,
      body: error.body ?? null,
      error: error.message,
    });
    return { action: 'error', ok: false, sync_status: 'failed' };
  }
};

/**
 * Removes a batch of just-expired registrations from the Intozi watchlist in one
 * DELETE call. Never throws. Called by the expiry sweeper, which already works
 * in bounded batches — the DELETE API takes an array of ids, so a whole batch is
 * one round trip.
 *
 * @param {object[]} rows Lean rows from the sweep — each needs _id and its
 *                        `intozi` sub-object.
 * @param {object} [context]
 * @param {import('mongoose').Model} [context.model] RegisteredVehicle (default) or Visitor.
 * @returns {Promise<number>} How many remote records were deleted.
 */
const handleExpiredRegistrations = async (rows, { requestId, model = RegisteredVehicle } = {}) => {
  if (!isEnabled() || !rows?.length) return 0;

  // Only rows we actually pushed have something to remove.
  const synced = rows.filter((row) => row.intozi?.anpr_wl_id != null);
  if (!synced.length) return 0;

  const log = logger.child({ requestId });

  try {
    await deleteVehicles(synced.map((row) => row.intozi.anpr_wl_id), { requestId });
    await markDeleted(model, synced.map((row) => row._id));
    log.info('Expired vehicles removed from Intozi watchlist', { count: synced.length });
    return synced.length;
  } catch (error) {
    // Leave the stored ids in place so a reconcile can retry the delete — a
    // vehicle still on Intozi's list is the failure mode to flag, not to hide.
    await model.updateMany(
      { _id: { $in: synced.map((row) => row._id) } },
      { $set: { 'intozi.sync_status': 'failed', 'intozi.last_error': String(error.message || error) } }
    ).catch(() => {});

    log.error('Failed to remove expired vehicles from Intozi watchlist', {
      count: synced.length,
      status: error.status ?? null,
      error: error.message,
    });
    return 0;
  }
};

/**
 * Adds a batch of visitor passes whose window has just opened to the Intozi
 * watchlist. Never throws. Called by the sweeper's activation pass — each pass
 * needs its own add (and its own `anpr_wl_id`), so this is one call per row, but
 * the batches are bounded by the sweeper.
 *
 * @param {object[]} rows Lean Visitor rows from the sweep — each needs _id,
 *                        group_id, vehicle_number, device_names and `intozi`.
 * @param {object} [context]
 * @returns {Promise<number>} How many passes were added/updated on the watchlist.
 */
const handleActivatedVisitors = async (rows, { requestId } = {}) => {
  if (!isEnabled() || !rows?.length) return 0;

  let synced = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await syncRegistration(
      { record: row, eventType: 'UPDATED', vehicleType: 'registered' },
      { requestId, model: Visitor, vehicleCategory: config.INTOZI_VISITOR_VEHICLE_CATEGORY }
    );
    if (result.ok && (result.action === 'add' || result.action === 'update')) synced += 1;
  }
  return synced;
};

module.exports = {
  isEnabled,
  // transport
  addVehicle,
  updateVehicle,
  deleteVehicles,
  getWatchlist,
  // orchestration
  syncRegistration,
  handleExpiredRegistrations,
  handleActivatedVisitors,
  // exposed for tests
  toAddPayload,
  toUpdatePayload,
  extractIds,
};
