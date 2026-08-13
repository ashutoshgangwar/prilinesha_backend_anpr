const mongoose = require('mongoose');

const config = require('../config/env');
const {
  ACCESS_EVENT_VALUES,
  ACCESS_CHANGE_SOURCE_VALUES,
  VEHICLE_TYPES,
} = require('../utils/constants');

/**
 * The access-change log — an append-only stream of "what happened to which
 * plate", and the only thing `GET /api/feed` reads.
 *
 * ## Why this collection exists
 *
 * Intozi keeps its own allow-list and polls for *changes*. Two properties of the
 * access lists themselves make them unusable as a change feed:
 *
 *   Expiry writes nothing. When the clock passes `valid_till`, `updatedAt` does
 *   not move, so no cursor over the vehicle collections could ever re-send the
 *   row — a lapsed pass would sit in Intozi's cache as valid indefinitely. Here,
 *   expiry is a row like any other, written by the sweeper (jobs/accessSweeper).
 *
 *   Deletion removes the evidence. A hard-deleted registration leaves nothing
 *   behind to describe, so nothing could tell Intozi to drop the plate. A
 *   DELETED row here is a tombstone that outlives the record it refers to.
 *
 * It also answers the scale requirement: a poll reads an indexed range of this
 * log, never the several lakh vehicle rows behind it.
 *
 * ## Event-level, not state-level
 *
 * Every change is stored and delivered in order — nothing is collapsed, and a
 * plate that changed three times produces three rows. The alternative, keeping
 * one row per plate and overwriting it, is smaller and is a trap: any
 * "keep the newest per plate" step has to be applied *within a page*, and the
 * moment a plate's newest state falls on the far side of a page boundary the
 * consumer sees the older one last and ends up with the wrong answer. The
 * sequence
 *
 *     10:00 registered → 10:05 updated → 10:10 revoked
 *
 * must end with the barrier refusing the vehicle, and delivering all three in
 * order guarantees that whatever the page size is. Duplicate work at the
 * consumer is cheap; a hidden revocation is a hole in the fence.
 *
 * Retention is bounded by a TTL index rather than by pruning logic — see below.
 */
const accessChangeSchema = new mongoose.Schema(
  {
    // The tenant boundary, uppercased exactly like Project.group_id so the same
    // scope filter the rest of the system builds applies here unchanged. Every
    // feed query is filtered on it; this is what keeps one customer's changes
    // out of another's feed.
    group_id: { type: String, required: true, trim: true, uppercase: true },

    // The plate, normalised identically to both access lists.
    vehicle_number: { type: String, required: true, trim: true, uppercase: true },

    event_type: { type: String, enum: ACCESS_EVENT_VALUES, required: true },

    // The access state *after* this change, so a consumer that only understands
    // registered/unregistered still behaves correctly without interpreting
    // event_type at all. Every event that takes access away — SUSPENDED,
    // REVOKED, EXPIRED, DELETED — carries `unregistered`.
    vehicle_type: { type: String, enum: VEHICLE_TYPES, required: true },

    // The gates this grant is good for at the moment of the change. Empty means
    // every gate in the project, the same wildcard both access lists use.
    // Meaningless on DELETED, where it is stored empty.
    device_names: { type: [{ type: String, trim: true }], default: [] },

    // Which list the change came from, and the row it came from. Internal only:
    // neither is disclosed on the feed (see FEED_DISCLOSED_FIELDS). They exist
    // so a support question — "why did this plate get revoked?" — can be traced
    // back, and so the seed script can tell what it has already written.
    source: { type: String, enum: ACCESS_CHANGE_SOURCE_VALUES, required: true },
    source_id: { type: mongoose.Schema.Types.ObjectId, default: null },

    // The ordering key. Set explicitly rather than relying on `createdAt`,
    // because the sweeper stamps a batch of expiries with one instant and the
    // cursor's tiebreak (_id) then orders within it deterministically.
    changed_at: { type: Date, required: true, default: Date.now },
  },
  {
    // `changed_at` is the timestamp that matters and it is explicit above. An
    // updatedAt would be actively misleading on an append-only log: nothing here
    // is ever updated.
    timestamps: false,
    versionKey: false,
  }
);

/**
 * The feed's keyset cursor, and the reason this collection scales.
 *
 * Ordered (group_id, changed_at, _id) so a poll is an indexed range scan from
 * the caller's cursor forward, within their project — never a collection scan,
 * whatever the vehicle count behind it. `_id` is in the index because a batch of
 * expiries can share one `changed_at` to the millisecond, and the cursor
 * disambiguates on it.
 */
accessChangeSchema.index(
  { group_id: 1, changed_at: 1, _id: 1 },
  { name: 'idx_change_feed_cursor' }
);

/**
 * The same walk for the legacy unscoped API key, which reads across every
 * project and so cannot use the index above (its leading field is not bound).
 */
accessChangeSchema.index({ changed_at: 1, _id: 1 }, { name: 'idx_change_feed_cursor_global' });

/**
 * "What has happened to this plate?" — support and debugging, not the feed.
 */
accessChangeSchema.index(
  { group_id: 1, vehicle_number: 1, changed_at: -1 },
  { name: 'idx_change_vehicle_history' }
);

/**
 * Retention.
 *
 * An append-only log grows without bound, so old changes are pruned by TTL.
 * This is the one mechanism here that can lose an event, so it is deliberately
 * generous and deliberately visible: a consumer whose cursor is older than the
 * window may have missed a pruned change, and `getVehicleFeed` tells it so
 * (`resync_required`) rather than serving a page with a hole in it and letting a
 * revoked plate stay in its allow-list.
 *
 * Set ACCESS_CHANGE_RETENTION_DAYS=0 to keep everything forever.
 */
if (config.ACCESS_CHANGE_RETENTION_DAYS > 0) {
  accessChangeSchema.index(
    { changed_at: 1 },
    {
      name: 'ttl_change_retention',
      expireAfterSeconds: config.ACCESS_CHANGE_RETENTION_DAYS * 24 * 60 * 60,
    }
  );
}

module.exports = mongoose.model('AccessChange', accessChangeSchema);
