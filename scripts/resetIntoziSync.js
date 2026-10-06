/**
 * Resets the Intozi watchlist sync state on the registry and visitor passes back
 * to `pending`.
 *
 * ## Why
 *
 * To clear stale sync state and force a clean re-sync — e.g. after testing, or
 * when pointing at a fresh Intozi instance. Every row goes back to `pending` so
 * the dashboard shows `pending` until a real push to Intozi actually succeeds.
 *
 * ## What it changes
 *
 * Only the `intozi` sub-object on each row — the plate, holder, window and
 * everything else are untouched. It sets:
 *   sync_status -> pending, anpr_wl_id/field ids -> null, synced_at/last_error -> null
 *
 * ## Safety
 *
 * Run this BEFORE real syncing starts (when every `synced` is a dry-run
 * artefact). After Intozi is live it would wipe genuine ids and force a re-add,
 * so do not run it then without meaning to.
 *
 *   node scripts/resetIntoziSync.js            # reset all non-pending rows
 *   node scripts/resetIntoziSync.js --dry-run  # count only, write nothing
 */
const logger = require('../utils/logger');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const Visitor = require('../models/Visitor');

const RESET = {
  $set: {
    'intozi.sync_status': 'pending',
    'intozi.anpr_wl_id': null,
    'intozi.device_field_data_id': null,
    'intozi.group_field_data_id': null,
    'intozi.synced_at': null,
    'intozi.last_error': null,
  },
};

// Everything that is not already pending — i.e. touched by a (simulated) sync.
const FILTER = { 'intozi.sync_status': { $in: ['synced', 'deleted', 'failed'] } };

const run = async () => {
  const dryRun = process.argv.includes('--dry-run');

  await connectDatabase();

  const [vehiclesToReset, visitorsToReset] = await Promise.all([
    RegisteredVehicle.countDocuments(FILTER),
    Visitor.countDocuments(FILTER),
  ]);

  logger.info('Intozi sync reset — rows that are not `pending`', {
    registered_vehicles: vehiclesToReset,
    visitors: visitorsToReset,
    mode: dryRun ? 'dry-run (no write)' : 'write',
  });

  if (!dryRun) {
    const [v, vis] = await Promise.all([
      RegisteredVehicle.updateMany(FILTER, RESET),
      Visitor.updateMany(FILTER, RESET),
    ]);

    logger.info('Intozi sync reset complete', {
      registered_vehicles_reset: v.modifiedCount,
      visitors_reset: vis.modifiedCount,
    });
  }

  await disconnectDatabase();
};

run().catch(async (error) => {
  logger.error('Intozi sync reset failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
