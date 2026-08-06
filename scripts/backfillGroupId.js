// Environment must be validated before any module reads process.env.
const config = require('../config/env');

const logger = require('../utils/logger');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const RegisteredVehicle = require('../models/RegisteredVehicle');
const VehicleLog = require('../models/VehicleLog');
const Project = require('../models/Project');

/**
 * One-off migration for databases that predate projects.
 *
 * Registered vehicles and detection events written before multi-tenancy have no
 * `group_id`. `group_id` is now required on RegisteredVehicle, so those rows
 * would fail validation on the next write and are invisible to every scoped
 * query. This assigns them to one project.
 *
 * Usage:
 *   node scripts/backfillGroupId.js ACME_MALL           # dry run — reports only
 *   node scripts/backfillGroupId.js ACME_MALL --apply   # writes
 *
 * Safe to re-run: it only touches documents that have no group_id.
 */

const run = async () => {
  const [groupIdArg, ...flags] = process.argv.slice(2);
  const apply = flags.includes('--apply');

  if (!groupIdArg) {
    /* eslint-disable-next-line no-console */
    console.error(
      '\nUsage: node scripts/backfillGroupId.js <GROUP_ID> [--apply]\n\n' +
        '  <GROUP_ID>  an existing project to assign pre-existing records to\n' +
        '  --apply     actually write the change (omit for a dry run)\n'
    );
    process.exit(1);
  }

  const groupId = groupIdArg.trim().toUpperCase();

  await connectDatabase();

  // Assigning records to a project that does not exist would hide them just as
  // effectively as leaving them null.
  const project = await Project.findOne({ group_id: groupId }).select('group_id project_name').lean();

  if (!project) {
    logger.error('No such project — create it first with POST /api/projects', { group_id: groupId });
    await disconnectDatabase();
    process.exit(1);
  }

  const orphanFilter = { $or: [{ group_id: null }, { group_id: { $exists: false } }] };

  const [vehicles, events] = await Promise.all([
    RegisteredVehicle.countDocuments(orphanFilter),
    VehicleLog.countDocuments(orphanFilter),
  ]);

  logger.info('Records without a group_id', {
    registered_vehicles: vehicles,
    vehicle_logs: events,
    target: `${project.group_id} (${project.project_name})`,
    mode: apply ? 'APPLY' : 'DRY RUN',
  });

  if (!apply) {
    logger.info('Dry run complete — re-run with --apply to write these changes.');
    await disconnectDatabase();
    return;
  }

  const [vehicleResult, eventResult] = await Promise.all([
    RegisteredVehicle.updateMany(orphanFilter, { $set: { group_id: groupId } }),
    VehicleLog.updateMany(orphanFilter, { $set: { group_id: groupId } }),
  ]);

  logger.info('Backfill complete', {
    registered_vehicles_updated: vehicleResult.modifiedCount,
    vehicle_logs_updated: eventResult.modifiedCount,
    group_id: groupId,
  });

  await disconnectDatabase();
};

run().catch(async (error) => {
  logger.error('Backfill failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
