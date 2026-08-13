const AccessChange = require('../models/AccessChange');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const config = require('../config/env');
const { encodeCursor, decodeCursor } = require('../utils/feedCursor');
const {
  ACCESS_EVENT_TYPES,
  ACCESS_CHANGE_SOURCES,
  DEFAULT_VEHICLE_TYPE,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
} = require('../utils/constants');

/**
 * The access-change log: writing changes, and serving them to Intozi.
 *
 * Every write path that can alter whether a plate may pass a barrier records
 * one row here, and `GET /api/feed` reads an indexed range of them. Nothing else
 * in the system reads this collection — it exists solely so a consumer can keep
 * a local allow-list in step without being handed the whole registry each poll.
 */

/**
 * Records one change.
 *
 * Deliberately never throws. It is called from inside write paths that have
 * *already* committed their change to the registry or the visitor list, and
 * there are no transactions here (a standalone mongod has none to offer), so the
 * choice on failure is between:
 *
 *   reporting the write as failed — when it demonstrably succeeded, leaving the
 *   caller to retry an operation that will now conflict with itself, or
 *
 *   logging loudly and carrying on — leaving the change log momentarily behind
 *   the truth, which `scripts/seedAccessChanges.js` can repair by re-deriving
 *   the current state.
 *
 * The second is the lesser failure, but it is a real one: a dropped row here is
 * a change Intozi never hears about. It is logged at `error` precisely so it is
 * alertable rather than invisible.
 *
 * @param {object} change
 * @param {string} change.groupId
 * @param {string} change.vehicleNumber
 * @param {string} change.eventType     One of ACCESS_EVENT_TYPES.
 * @param {string} [change.vehicleType] Access state after the change. Defaults to
 *                                      unregistered — the safe direction, since
 *                                      guessing "still allowed in" is the one
 *                                      mistake with a barrier on the other end.
 * @param {string[]} [change.deviceNames]
 * @param {string} change.source        One of ACCESS_CHANGE_SOURCES.
 * @param {any} [change.sourceId]
 * @param {Date} [change.changedAt]
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<object|null>} The stored row, or null if it could not be written.
 */
const recordChange = async (
  { groupId, vehicleNumber, eventType, vehicleType, deviceNames, source, sourceId, changedAt },
  { requestId } = {}
) => {
  // A change with no project or no plate cannot be delivered to anyone: the feed
  // is filtered by group_id and keyed by plate. Dropping it here keeps an
  // unusable row out of the log rather than failing a legitimate write.
  if (!groupId || !vehicleNumber) {
    logger.error('Access change not recorded: missing group_id or vehicle_number', {
      requestId,
      group_id: groupId ?? null,
      vehicle_number: vehicleNumber ?? null,
      event_type: eventType,
    });
    return null;
  }

  try {
    const change = await AccessChange.create({
      group_id: groupId,
      vehicle_number: vehicleNumber,
      event_type: eventType,
      vehicle_type: vehicleType ?? DEFAULT_VEHICLE_TYPE,
      device_names: deviceNames ?? [],
      source,
      source_id: sourceId ?? null,
      changed_at: changedAt ?? new Date(),
    });

    logger.child({ requestId }).info('Access change recorded', {
      group_id: groupId,
      vehicle_number: vehicleNumber,
      event_type: eventType,
      vehicle_type: change.vehicle_type,
    });

    return change;
  } catch (error) {
    logger.error('Failed to record access change — Intozi will not learn about this change', {
      requestId,
      group_id: groupId,
      vehicle_number: vehicleNumber,
      event_type: eventType,
      error: error.message,
    });
    return null;
  }
};

/**
 * Records many changes in one round trip — used by the sweeper and the seed
 * script, where a batch shares one instant.
 *
 * `ordered: false` so one bad document cannot discard the rest of the batch.
 *
 * @param {object[]} changes Documents already in storage shape.
 * @param {object} [context]
 * @returns {Promise<number>} How many were written.
 */
const recordChanges = async (changes, { requestId } = {}) => {
  if (!changes.length) return 0;

  try {
    const inserted = await AccessChange.insertMany(changes, { ordered: false });
    return inserted.length;
  } catch (error) {
    // insertMany reports partial success on the error itself; count what landed
    // rather than assuming the whole batch failed.
    const written = error.insertedDocs ? error.insertedDocs.length : 0;

    logger.error('Failed to record some access changes', {
      requestId,
      attempted: changes.length,
      written,
      error: error.message,
    });

    return written;
  }
};

/** Builds a change document without writing it — for batch callers. */
const buildChange = ({
  groupId,
  vehicleNumber,
  eventType,
  vehicleType,
  deviceNames,
  source,
  sourceId,
  changedAt,
}) => ({
  group_id: groupId,
  vehicle_number: vehicleNumber,
  event_type: eventType,
  vehicle_type: vehicleType ?? DEFAULT_VEHICLE_TYPE,
  device_names: deviceNames ?? [],
  source,
  source_id: sourceId ?? null,
  changed_at: changedAt ?? new Date(),
});

/**
 * Shapes one stored change into the record Intozi receives.
 *
 * Built as a literal, exactly as the previous feed was, so a column added to the
 * log later cannot leak by default. The fields are precisely
 * FEED_DISCLOSED_FIELDS: the plate, the project, the resulting access state, the
 * gates it holds at, and what happened. `source`, `source_id` and `changed_at`
 * stay internal — none of them changes a barrier decision, and the internal id
 * of a registration is nobody's business outside this system.
 */
const toFeedRecord = (change) => ({
  vehicle_number: change.vehicle_number ?? null,
  group_id: change.group_id ?? null,
  vehicle_type: change.vehicle_type ?? DEFAULT_VEHICLE_TYPE,
  device_names: [...(change.device_names ?? [])],
  event_type: change.event_type,
});

/**
 * Reads a page of changes for a consumer holding `cursor`.
 *
 * The query is a keyset range over (changed_at, _id) within the caller's
 * projects, served by `idx_change_feed_cursor`. It reads only rows the consumer
 * has not seen — never the vehicle collections, whose size therefore has no
 * bearing on how long a poll takes.
 *
 * Cursor semantics are strictly "everything after this point":
 *
 *     changed_at > cursor.changed_at
 *     OR (changed_at == cursor.changed_at AND _id > cursor._id)
 *
 * so re-sending the same cursor returns the same page, and a consumer that
 * crashes mid-page simply asks again. The cursor is only ever advanced by the
 * consumer, after it has applied the page.
 *
 * @param {object} [params]
 * @param {string} [params.cursor]      Opaque cursor from a previous response.
 * @param {Date}   [params.since]       Cold start from an instant. Ignored when cursor is sent.
 * @param {number} [params.limit]       Page size (default 100, max 1000).
 * @param {string} [params.vehicleType] Restrict to changes resulting in this state.
 * @param {object} [scopeFilter]        group_id fragment from buildScopeFilter().
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @returns {Promise<{records: object[], count: number, next_cursor: string|null,
 *                    has_more: boolean, resync_required: boolean}>}
 * @throws {AppError} 400 when the cursor is malformed.
 */
const readChanges = async (
  { cursor, since, limit, vehicleType } = {},
  scopeFilter = {},
  { requestId } = {}
) => {
  const log = logger.child({ requestId });
  const pageSize = Math.min(Number(limit) || FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);

  const filter = { ...scopeFilter };

  // Filtering a *change* feed by resulting state is a footgun — it hides the
  // very events that take access away — so it is supported for backward
  // compatibility with the existing query contract and warned about in the API
  // docs, rather than removed.
  if (vehicleType) filter.vehicle_type = vehicleType;

  let resyncRequired = false;

  if (cursor) {
    const position = decodeCursor(cursor);

    if (!position) {
      throw AppError.badRequest('cursor is not a valid feed cursor.', [
        { field: 'cursor', message: 'Send the next_cursor value returned by a previous response.' },
      ]);
    }

    // Strictly after the cursor; the same millisecond is disambiguated by _id.
    filter.$or = [
      { changed_at: { $gt: position.receivedAt } },
      { changed_at: position.receivedAt, _id: { $gt: position.id } },
    ];

    // A cursor older than the retention window may be pointing into changes
    // that have already been pruned, so the page that follows it could have a
    // hole where a revocation used to be. Say so rather than serving it
    // silently: a consumer that has fallen this far behind needs to rebuild
    // from the current state, not to resume.
    if (config.ACCESS_CHANGE_RETENTION_DAYS > 0) {
      const horizon = new Date(
        Date.now() - config.ACCESS_CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );

      if (position.receivedAt < horizon) {
        resyncRequired = true;
        log.warn('Feed cursor is older than the retention window; changes may have been pruned', {
          cursor_at: position.receivedAt,
          horizon,
          scope: scopeFilter.group_id ?? 'all',
        });
      }
    }
  } else if (since) {
    filter.changed_at = { $gt: since };
  }

  // One extra row answers has_more without a second query.
  const documents = await AccessChange.find(filter)
    .sort({ changed_at: 1, _id: 1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = documents.length > pageSize;
  const page = hasMore ? documents.slice(0, pageSize) : documents;
  const last = page[page.length - 1];

  log.info('Intozi change feed served', {
    count: page.length,
    has_more: hasMore,
    cursor: cursor || null,
    scope: scopeFilter.group_id ?? 'all',
  });

  return {
    records: page.map(toFeedRecord),
    count: page.length,
    // An empty poll hands the caller's own cursor back, so it never has to
    // remember it and never accidentally rewinds to the start of the log.
    next_cursor: last
      ? encodeCursor({ received_at: last.changed_at, _id: last._id })
      : cursor || null,
    has_more: hasMore,
    resync_required: resyncRequired,
  };
};

module.exports = {
  recordChange,
  recordChanges,
  buildChange,
  readChanges,
  toFeedRecord,
  ACCESS_EVENT_TYPES,
  ACCESS_CHANGE_SOURCES,
};
