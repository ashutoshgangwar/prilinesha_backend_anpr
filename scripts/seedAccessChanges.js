/**
 * Seeds the access-change log from the access lists as they stand.
 *
 * ## When to run this
 *
 * Once, when deploying the change feed onto a database that already holds
 * registrations and visitor passes. The feed serves changes, and those vehicles
 * predate the log — without a seed they have never "changed" and would never
 * reach Intozi at all.
 *
 * Also useful as a repair: if the change log is ever suspected of having missed
 * a write (recordChange logs an error rather than failing the request that
 * caused it), running this again re-publishes the current state of everything.
 *
 * ## What it writes
 *
 * One CREATED row per registration and per visitor pass, carrying the access
 * state each one has *now* — so an expired registration is seeded as
 * `unregistered` rather than being replayed as if it were still valid, and a
 * consumer applying the seed ends up with exactly the plates that should be
 * allowed in.
 *
 * The expiry markers are set to match: anything already lapsed is marked as
 * reported, so the sweeper does not immediately publish a second EXPIRED row for
 * a vehicle this seed already described as unregistered.
 *
 * ## Safety
 *
 * Idempotent in effect, not by suppression: running it twice writes a second set
 * of CREATED rows, which a consumer applies to the same result. It never deletes
 * or edits anything in either access list beyond those markers.
 *
 *   node scripts/seedAccessChanges.js              # every project
 *   node scripts/seedAccessChanges.js ACME_MALL    # one project
 *   node scripts/seedAccessChanges.js --dry-run    # count only, write nothing
 */
const config = require('../config/env');
const logger = require('../utils/logger');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const Visitor = require('../models/Visitor');
const AccessChange = require('../models/AccessChange');
const { recordChanges, buildChange } = require('../services/accessChangeService');
const { statusOf: registrationStatusOf } = require('../services/vehicleService');
const { statusOf: visitorStatusOf } = require('../services/visitorService');
const { ACCESS_EVENT_TYPES, ACCESS_CHANGE_SOURCES } = require('../utils/constants');

const BATCH = 500;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const groupId = args.find((arg) => !arg.startsWith('--'));

/**
 * Streams one collection into the log in batches, so a registry of several lakh
 * rows is seeded with bounded memory rather than loaded at once.
 */
const seed = async ({ model, source, statusOf, now, scope }) => {
  let seeded = 0;
  let lastId = null;

  for (;;) {
    const rows = await model
      .find({ ...scope, ...(lastId ? { _id: { $gt: lastId } } : {}) })
      .select('_id group_id vehicle_number device_names valid_from valid_till is_active')
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();

    if (!rows.length) break;

    lastId = rows[rows.length - 1]._id;

    if (!dryRun) {
      await recordChanges(
        rows.map((row) =>
          buildChange({
            groupId: row.group_id,
            vehicleNumber: row.vehicle_number,
            eventType: ACCESS_EVENT_TYPES.CREATED,
            vehicleType: statusOf(row, now),
            deviceNames: row.device_names ?? [],
            source,
            sourceId: row._id,
            changedAt: now,
          })
        )
      );

      // Anything already lapsed has just been described as unregistered by the
      // row above, so mark it reported — otherwise the sweeper's first pass
      // would publish a duplicate EXPIRED for every historic record at once.
      const lapsed = rows.filter((row) => new Date(row.valid_till) <= now).map((row) => row._id);

      if (lapsed.length) {
        await model.updateMany(
          { _id: { $in: lapsed }, expiry_emitted_at: null },
          { $set: { expiry_emitted_at: now } }
        );
      }

      // Likewise for passes already inside their window: the seed row says they
      // are valid, so their activation needs no second announcement.
      if (source === ACCESS_CHANGE_SOURCES.VISITOR) {
        const open = rows
          .filter((row) => new Date(row.valid_from) <= now && new Date(row.valid_till) > now)
          .map((row) => row._id);

        if (open.length) {
          await model.updateMany(
            { _id: { $in: open }, activation_emitted_at: null },
            { $set: { activation_emitted_at: now } }
          );
        }
      }
    }

    seeded += rows.length;
    if (rows.length < BATCH) break;
  }

  return seeded;
};

const run = async () => {
  await connectDatabase();

  const now = new Date();
  const scope = groupId ? { group_id: String(groupId).trim().toUpperCase() } : {};

  const existing = await AccessChange.countDocuments(scope);

  logger.info('Seeding the access-change log', {
    scope: groupId ?? 'all projects',
    dry_run: dryRun,
    existing_changes: existing,
  });

  const registrations = await seed({
    model: RegisteredVehicle,
    source: ACCESS_CHANGE_SOURCES.REGISTRATION,
    statusOf: registrationStatusOf,
    now,
    scope,
  });

  const passes = await seed({
    model: Visitor,
    source: ACCESS_CHANGE_SOURCES.VISITOR,
    statusOf: visitorStatusOf,
    now,
    scope,
  });

  logger.info(dryRun ? 'Seed dry run complete — nothing written' : 'Seed complete', {
    registrations,
    visitor_passes: passes,
    total: registrations + passes,
  });

  await disconnectDatabase();
};

run().catch(async (error) => {
  logger.error('Seed failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
