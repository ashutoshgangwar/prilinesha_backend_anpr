const RegisteredVehicle = require('../models/RegisteredVehicle');
const Visitor = require('../models/Visitor');
const logger = require('../utils/logger');
const config = require('../config/env');
const { recordChanges, buildChange } = require('../services/accessChangeService');
const {
  ACCESS_EVENT_TYPES,
  ACCESS_CHANGE_SOURCES,
  EXPIRY_SWEEP_BATCH_SIZE,
  EXPIRY_SWEEP_MAX_BATCHES,
} = require('../utils/constants');

/**
 * The time-driven half of the change feed.
 *
 * Every other change in this system is written by somebody doing something: a
 * registration is renewed, a pass is revoked, a row is deleted. Two are not.
 * When the clock passes `valid_from` a pass starts working, and when it passes
 * `valid_till` it stops — and in both cases *nothing writes to the document*.
 * `updatedAt` does not move, so no cursor over the vehicle collections could
 * ever carry the transition, and the feed discloses no dates for a consumer to
 * work it out from. Left alone, a pass that closed at 18:00 would sit in
 * Intozi's allow-list as valid until somebody noticed.
 *
 * This job is what closes that gap: it finds the rows whose moment has arrived
 * and writes the change nobody else would.
 *
 * ## Why it is not a scan
 *
 * Each sweep is one indexed query of the form
 *
 *     { <marker>: null, <date>: { $lte: now } }
 *
 * served by a compound index with the marker's equality first and the date's
 * range second (`idx_expiry_sweep`, `idx_visitor_expiry_sweep`,
 * `idx_visitor_activation_sweep`). It therefore walks only the rows that have
 * genuinely just transitioned — never the several lakh registrations behind
 * them — and once a row's marker is set it leaves the index range for good, so
 * the same row is never examined twice.
 *
 * Work per tick is bounded by BATCH_SIZE × MAX_BATCHES. Anything left over is
 * picked up on the next tick, at the same cost, so a first run after a long
 * outage cannot monopolise the event loop.
 *
 * ## Idempotency, and which way to fail
 *
 * The order is deliberately: write the change, then set the marker.
 *
 * The reverse — mark first — would be tidier, and would lose an event outright
 * if the process died between the two: the row would look reported and its
 * expiry would never be published, leaving a lapsed vehicle allowed in
 * indefinitely. This way a crash in the same window costs one duplicate event on
 * the next tick, and a duplicate is harmless: Intozi applies "remove this plate"
 * to a plate it has already removed and nothing happens.
 *
 * Between a silent hole in the fence and a repeated instruction, only one of
 * those is a security problem.
 */

let timer = null;
let running = false;

/**
 * Claims rows whose time has come and publishes their change.
 *
 * @param {object} spec
 * @param {import('mongoose').Model} spec.model
 * @param {object} spec.filter    Selects the rows that have just transitioned.
 * @param {string} spec.marker    Field to stamp so the row is never re-reported.
 * @param {string} spec.eventType
 * @param {string} spec.source
 * @param {Function} spec.vehicleTypeOf Access state to publish for a claimed row.
 * @param {Date} spec.now
 * @returns {Promise<number>} How many changes were published.
 */
const sweepTransition = async ({
  model,
  filter,
  marker,
  eventType,
  source,
  vehicleTypeOf,
  now,
}) => {
  let published = 0;

  for (let batch = 0; batch < EXPIRY_SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await model
      .find(filter)
      .select('_id group_id vehicle_number device_names valid_from valid_till is_active')
      .limit(EXPIRY_SWEEP_BATCH_SIZE)
      .lean();

    if (!rows.length) break;

    // Written first — see the note on ordering above.
    const written = await recordChanges(
      rows.map((row) =>
        buildChange({
          groupId: row.group_id,
          vehicleNumber: row.vehicle_number,
          eventType,
          vehicleType: vehicleTypeOf(row),
          deviceNames: row.device_names ?? [],
          source,
          sourceId: row._id,
          // One instant for the whole batch, so the cursor's tiebreak on _id
          // gives a stable order within it.
          changedAt: now,
        })
      )
    );

    published += written;

    // Only now is the row taken out of the sweep's range. The marker filter is
    // repeated in the update so two processes sweeping at once cannot both
    // claim it — the loser's update matches nothing.
    await model.updateMany(
      { _id: { $in: rows.map((row) => row._id) }, [marker]: null },
      { $set: { [marker]: now } }
    );

    // A short batch means the range is drained; no point asking again.
    if (rows.length < EXPIRY_SWEEP_BATCH_SIZE) break;
  }

  return published;
};

/**
 * Runs one full pass: registrations that lapsed, passes that closed, passes that
 * opened.
 *
 * Safe to call directly (the tests do, and so does boot) as well as on the
 * interval. Never throws: a sweep that fails must not take the process down,
 * and the rows it did not claim are still there for the next tick.
 *
 * @param {object} [options]
 * @param {Date} [options.now] Overridable so a test can sweep "as at" an instant.
 * @returns {Promise<{expired_registrations: number, expired_passes: number,
 *                    activated_passes: number}>}
 */
const runSweep = async ({ now = new Date() } = {}) => {
  const summary = { expired_registrations: 0, expired_passes: 0, activated_passes: 0 };

  try {
    // A registration whose valid_till has passed. Emitted whatever `is_active`
    // says: a suspended row has already sent SUSPENDED, and a second "stop
    // letting it in" costs nothing, while branching on it would leave the row
    // unmarked and re-examined by every future sweep.
    summary.expired_registrations = await sweepTransition({
      model: RegisteredVehicle,
      filter: { expiry_emitted_at: null, valid_till: { $lte: now } },
      marker: 'expiry_emitted_at',
      eventType: ACCESS_EVENT_TYPES.EXPIRED,
      source: ACCESS_CHANGE_SOURCES.REGISTRATION,
      vehicleTypeOf: () => 'unregistered',
      now,
    });

    // A visitor pass whose window has closed.
    summary.expired_passes = await sweepTransition({
      model: Visitor,
      filter: { expiry_emitted_at: null, valid_till: { $lte: now } },
      marker: 'expiry_emitted_at',
      eventType: ACCESS_EVENT_TYPES.EXPIRED,
      source: ACCESS_CHANGE_SOURCES.VISITOR,
      vehicleTypeOf: () => 'unregistered',
      now,
    });

    // A visitor pass whose window has just opened — the other side of the same
    // coin, and the reason a pass can be booked in advance at all. Revoked
    // passes are skipped: a pass switched off before it started must not
    // announce itself as valid when its start time arrives.
    //
    // Passes that opened *and* closed between two sweeps are excluded here by
    // the valid_till clause and reported as EXPIRED above, so a window entirely
    // inside one sweep interval never produces a spurious "now valid".
    summary.activated_passes = await sweepTransition({
      model: Visitor,
      filter: {
        activation_emitted_at: null,
        valid_from: { $lte: now },
        valid_till: { $gt: now },
        is_active: { $ne: false },
      },
      marker: 'activation_emitted_at',
      eventType: ACCESS_EVENT_TYPES.UPDATED,
      source: ACCESS_CHANGE_SOURCES.VISITOR,
      vehicleTypeOf: () => 'registered',
      now,
    });

    const total =
      summary.expired_registrations + summary.expired_passes + summary.activated_passes;

    // Only worth a line when it actually did something: this runs every minute
    // forever, and a log full of "swept 0" hides the sweeps that mattered.
    if (total > 0) logger.info('Access sweep published changes', summary);

    return summary;
  } catch (error) {
    logger.error('Access sweep failed — expiry changes may be delayed until the next run', {
      error: error.message,
      stack: error.stack,
    });
    return summary;
  }
};

/**
 * Starts the periodic sweep, and runs one immediately.
 *
 * The immediate run is what makes a restart safe: everything that expired while
 * the process was down is published as soon as it comes back, rather than
 * waiting for the first interval to elapse.
 *
 * @returns {Function} A stop function, for shutdown and for tests.
 */
const startSweeper = () => {
  if (!config.ACCESS_SWEEP_ENABLED) {
    logger.warn('Access sweeper is disabled — expiry will not reach the Intozi feed', {
      hint: 'Set ACCESS_SWEEP_ENABLED=true in the process that should own this job.',
    });
    return () => {};
  }

  if (timer) return stopSweeper;

  // Catches up on anything that lapsed while the process was down.
  runSweep().catch(() => {});

  timer = setInterval(() => {
    // Skips a tick rather than overlapping. A sweep that is still going is
    // already working through the backlog, and a second one would only contend
    // with it for the same rows.
    if (running) return;

    running = true;
    runSweep()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, config.ACCESS_SWEEP_INTERVAL_MS);

  // Must not hold the event loop open on shutdown.
  timer.unref();

  logger.info('Access sweeper started', { interval_ms: config.ACCESS_SWEEP_INTERVAL_MS });

  return stopSweeper;
};

/** Stops the periodic sweep. Idempotent. */
const stopSweeper = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('Access sweeper stopped');
};

module.exports = { runSweep, startSweeper, stopSweeper };
