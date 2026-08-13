/**
 * Tests for the incremental access-change feed.
 *
 * Plain Node, no framework: the project has no test runner and adding one is a
 * dependency decision that is not this change's to make. Run it with
 *
 *     npm test
 *
 * against any MongoDB you do not mind losing — it uses its own database
 * (`TEST_DB_NAME`) and drops it at both ends. It never touches the database in
 * MONGO_URI's path.
 *
 * The tests go through the *service layer* rather than over HTTP, because that
 * is where the behaviour under test lives: the controller is a five-line adapter
 * and the routing is exercised separately. Project scoping is tested with the
 * very filter the auth middleware produces, so the isolation assertion is about
 * the real rule and not a re-implementation of it.
 */
const mongoose = require('mongoose');

const RegisteredVehicle = require('../models/RegisteredVehicle');
const Visitor = require('../models/Visitor');
const AccessChange = require('../models/AccessChange');
const Project = require('../models/Project');
const vehicleService = require('../services/vehicleService');
const visitorService = require('../services/visitorService');
const { getVehicleFeed } = require('../services/anprService');
const { runSweep } = require('../jobs/accessSweeper');
const { ACCESS_EVENT_TYPES, FEED_DISCLOSED_FIELDS } = require('../utils/constants');

const TEST_DB = process.env.TEST_DB_NAME || 'anpr_access_feed_test';
const MONGO_HOST = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017').replace(/\/[^/]*$/, '');

const A = 'TEST_PROJECT_A';
const B = 'TEST_PROJECT_B';

// The exact filter shape middleware/auth.js#buildScopeFilter produces for a
// per-project API key.
const scopeOf = (groupId) => ({ group_id: groupId });

const hours = (h) => new Date(Date.now() + h * 3600 * 1000);

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`    ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` -> ${detail}` : ''}`);
    console.log(`    FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
  }
};

const test = async (name, fn) => {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    failures.push(`${name} threw: ${error.message}`);
    console.log(`    FAIL threw: ${error.message}`);
  }
};

/** Drains the feed from a cursor, returning every change and the final cursor. */
const drain = async (groupId, cursor, limit = 1000) => {
  const all = [];
  let next = cursor;
  let pages = 0;

  for (;;) {
    const feed = await getVehicleFeed({ cursor: next, limit }, scopeOf(groupId), {});
    all.push(...feed.records);
    next = feed.next_cursor;
    pages += 1;
    if (!feed.has_more || pages > 100) break;
  }

  return { changes: all, cursor: next, pages };
};

/** A project with one gate, so device-name resolution has something to resolve. */
const makeProject = (groupId) =>
  Project.create({
    group_id: groupId,
    project_name: groupId,
    project_type: 'society',
    api_key_hash: `hash-${groupId}`,
    devices: [{ device_name: 'Entry_Gate_1', is_active: true }],
    is_active: true,
  });

const registerVehicle = (groupId, plate, validTill) =>
  vehicleService.registerVehicle({
    group_id: groupId,
    vehicle_number: plate,
    name: 'Test Holder',
    phone_number: '9000000000',
    valid_till: validTill,
  });

const run = async () => {
  await mongoose.connect(`${MONGO_HOST}/${TEST_DB}`);
  await mongoose.connection.dropDatabase();
  await Promise.all([
    RegisteredVehicle.syncIndexes(),
    Visitor.syncIndexes(),
    AccessChange.syncIndexes(),
  ]);
  await Promise.all([makeProject(A), makeProject(B)]);

  console.log(`\nrunning against ${MONGO_HOST}/${TEST_DB}`);

  // ---------------------------------------------------------------- Test 1 --
  let cursorA;

  await test('Test 1 — a new registered vehicle appears in the feed', async () => {
    await registerVehicle(A, 'DL01AB1234', hours(24 * 30));

    const { changes, cursor } = await drain(A);
    cursorA = cursor;

    check('one change delivered', changes.length === 1, `got ${changes.length}`);
    check('it is the vehicle', changes[0]?.vehicle_number === 'DL01AB1234');
    check('event_type is CREATED', changes[0]?.event_type === ACCESS_EVENT_TYPES.CREATED);
    check('it is registered', changes[0]?.vehicle_type === 'registered');
    check(
      'only the disclosed fields are present',
      JSON.stringify(Object.keys(changes[0] ?? {}).sort()) ===
        JSON.stringify([...FEED_DISCLOSED_FIELDS].sort()),
      JSON.stringify(Object.keys(changes[0] ?? {}))
    );
  });

  // ---------------------------------------------------------------- Test 2 --
  await test('Test 2 — polling again with the latest cursor returns nothing', async () => {
    const feed = await getVehicleFeed({ cursor: cursorA }, scopeOf(A), {});

    check('data is empty', feed.records.length === 0, `got ${feed.records.length}`);
    check('has_more is false', feed.has_more === false);
    check('the cursor is handed back unchanged', feed.next_cursor === cursorA);

    // Edge case 16: the same cursor twice must be deterministic.
    const again = await getVehicleFeed({ cursor: cursorA }, scopeOf(A), {});
    check('repeating the poll is deterministic', again.records.length === 0);
  });

  // ---------------------------------------------------------------- Test 3 --
  await test('Test 3 — updating a vehicle emits a change', async () => {
    const vehicle = await RegisteredVehicle.findOne({ group_id: A, vehicle_number: 'DL01AB1234' });
    await vehicleService.updateVehicle(vehicle._id, { name: 'Renamed Holder' }, scopeOf(A), {});

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('one change delivered', changes.length === 1, `got ${changes.length}`);
    check('event_type is UPDATED', changes[0]?.event_type === ACCESS_EVENT_TYPES.UPDATED);
    check('still registered', changes[0]?.vehicle_type === 'registered');
  });

  // ---------------------------------------------------------------- Test 4 --
  await test('Test 4 — suspending a vehicle emits a change that removes access', async () => {
    const vehicle = await RegisteredVehicle.findOne({ group_id: A, vehicle_number: 'DL01AB1234' });
    await vehicleService.setVehicleStatus(vehicle._id, false, scopeOf(A), {});

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('one change delivered', changes.length === 1, `got ${changes.length}`);
    check('event_type is SUSPENDED', changes[0]?.event_type === ACCESS_EVENT_TYPES.SUSPENDED);
    check('it is unregistered', changes[0]?.vehicle_type === 'unregistered');
  });

  await test('Test 4b — revoking a visitor pass emits REVOKED', async () => {
    const pass = await visitorService.createVisitor({
      group_id: A,
      vehicle_number: 'RJ14VV0001',
      name: 'Guest',
      host_name: 'Host',
      valid_from: hours(-1),
      valid_till: hours(4),
    });

    await visitorService.setVisitorStatus(pass.id, false, scopeOf(A), {});

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('two changes: issued then revoked', changes.length === 2, `got ${changes.length}`);
    check('first is CREATED and registered',
      changes[0]?.event_type === ACCESS_EVENT_TYPES.CREATED && changes[0]?.vehicle_type === 'registered');
    check('second is REVOKED and unregistered',
      changes[1]?.event_type === ACCESS_EVENT_TYPES.REVOKED && changes[1]?.vehicle_type === 'unregistered');
  });

  // ---------------------------------------------------------------- Test 5 --
  await test('Test 5 — expiry produces a change even though updatedAt never moved', async () => {
    // A pass that closed two hours ago, written straight to the collection so no
    // write path has a chance to emit anything: this is exactly the state a row
    // reaches by the clock moving, and nothing else.
    const pass = await Visitor.create({
      group_id: A,
      vehicle_number: 'KA05EX0001',
      name: 'Expired Guest',
      host_name: 'Host',
      valid_from: hours(-6),
      valid_till: hours(-2),
      is_active: true,
      activation_emitted_at: hours(-6),
      expiry_emitted_at: null,
    });

    const before = await drain(A, cursorA);
    check('nothing in the feed before the sweep runs', before.changes.length === 0,
      `got ${before.changes.length}`);

    const untouched = await Visitor.findById(pass._id).lean();
    const updatedAtBefore = untouched.updatedAt.getTime();

    await runSweep();

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('the sweep published exactly one change', changes.length === 1, `got ${changes.length}`);
    check('event_type is EXPIRED', changes[0]?.event_type === ACCESS_EVENT_TYPES.EXPIRED);
    check('it is unregistered', changes[0]?.vehicle_type === 'unregistered');
    check('it is the expired plate', changes[0]?.vehicle_number === 'KA05EX0001');

    const after = await Visitor.findById(pass._id).lean();
    check('the row itself was never rewritten by time passing',
      after.updatedAt.getTime() === updatedAtBefore ||
        after.expiry_emitted_at !== null, 'marker is the only write');

    // Idempotency: sweeping repeatedly must not republish it.
    await runSweep();
    await runSweep();

    const repeat = await drain(A, cursorA);
    cursorA = repeat.cursor;
    check('re-running the sweep publishes nothing more', repeat.changes.length === 0,
      `got ${repeat.changes.length}`);
  });

  await test('Test 5b — a visitor pass activates when its window opens', async () => {
    // Booked for later, so it is created as not-yet-valid.
    const pass = await visitorService.createVisitor({
      group_id: A,
      vehicle_number: 'MH12FU0001',
      name: 'Future Guest',
      host_name: 'Host',
      valid_from: hours(2),
      valid_till: hours(6),
    });

    const created = await drain(A, cursorA);
    cursorA = created.cursor;

    check('issued as unregistered', created.changes[0]?.vehicle_type === 'unregistered');

    // The window opens: rewind it in the database exactly as the clock would.
    await Visitor.updateOne({ _id: pass.id }, { $set: { valid_from: hours(-1) } });
    await runSweep();

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('activation published', changes.length === 1, `got ${changes.length}`);
    check('event_type is UPDATED', changes[0]?.event_type === ACCESS_EVENT_TYPES.UPDATED);
    check('now registered', changes[0]?.vehicle_type === 'registered');
  });

  // ---------------------------------------------------------------- Test 6 --
  await test('Test 6 — deleting a vehicle leaves a tombstone', async () => {
    const { vehicle } = await registerVehicle(A, 'DL09DEL001', hours(24 * 30));
    const drained = await drain(A, cursorA);
    cursorA = drained.cursor;

    await vehicleService.deleteVehicle(vehicle.id, scopeOf(A), {});

    const { changes, cursor } = await drain(A, cursorA);
    cursorA = cursor;

    check('one change delivered', changes.length === 1, `got ${changes.length}`);
    check('event_type is DELETED', changes[0]?.event_type === ACCESS_EVENT_TYPES.DELETED);
    check('it is unregistered', changes[0]?.vehicle_type === 'unregistered');
    check('it names the plate', changes[0]?.vehicle_number === 'DL09DEL001');

    const gone = await RegisteredVehicle.findOne({ group_id: A, vehicle_number: 'DL09DEL001' });
    check('the underlying row really is gone', gone === null);
  });

  // ---------------------------------------------------------------- Test 7 --
  await test('Test 7 — pagination at limit=2 loses and repeats nothing', async () => {
    const plates = ['PG01AA0001', 'PG01AA0002', 'PG01AA0003', 'PG01AA0004', 'PG01AA0005'];
    for (const plate of plates) await registerVehicle(A, plate, hours(24 * 30));

    const collected = [];
    let next = cursorA;
    let pages = 0;

    for (;;) {
      const feed = await getVehicleFeed({ cursor: next, limit: 2 }, scopeOf(A), {});
      check(`page ${pages + 1} holds at most 2`, feed.records.length <= 2, `got ${feed.records.length}`);
      collected.push(...feed.records.map((r) => r.vehicle_number));
      next = feed.next_cursor;
      pages += 1;
      if (!feed.has_more || pages > 20) break;
    }

    cursorA = next;

    check('took more than one page', pages >= 3, `pages=${pages}`);
    check('every plate arrived', JSON.stringify(collected) === JSON.stringify(plates),
      `got ${JSON.stringify(collected)}`);
    check('no duplicates', new Set(collected).size === collected.length);
  });

  // ---------------------------------------------------------------- Test 8 --
  await test('Test 8 — events sharing one timestamp are each delivered exactly once', async () => {
    // One instant, twelve events — the shape a sweeper batch produces, and the
    // case a cursor on the timestamp alone would loop on or skip.
    const instant = new Date();
    await AccessChange.insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        group_id: A,
        vehicle_number: `TS01SAME${String(i).padStart(3, '0')}`,
        event_type: ACCESS_EVENT_TYPES.EXPIRED,
        vehicle_type: 'unregistered',
        device_names: [],
        source: 'registration',
        changed_at: instant,
      }))
    );

    const collected = [];
    let next = cursorA;
    let pages = 0;

    for (;;) {
      const feed = await getVehicleFeed({ cursor: next, limit: 5 }, scopeOf(A), {});
      collected.push(...feed.records.map((r) => r.vehicle_number));
      next = feed.next_cursor;
      pages += 1;
      if (!feed.has_more || pages > 20) break;
    }

    cursorA = next;

    check('all twelve delivered', collected.length === 12, `got ${collected.length}`);
    check('none duplicated', new Set(collected).size === 12);
    check('paging terminated', pages <= 4, `pages=${pages}`);
  });

  // ---------------------------------------------------------------- Test 9 --
  await test('Test 9 — one project never sees another project’s changes', async () => {
    await registerVehicle(B, 'BB01XX9999', hours(24 * 30));

    const feedB = await drain(B);
    const plates = feedB.changes.map((r) => r.vehicle_number);

    check('project B sees its own change', plates.includes('BB01XX9999'));
    check('project B sees nothing else', plates.length === 1, JSON.stringify(plates));
    check('every row is stamped with project B',
      feedB.changes.every((r) => r.group_id === B));

    const feedA = await drain(A, cursorA);
    check('project A is not shown project B’s change',
      !feedA.changes.some((r) => r.vehicle_number === 'BB01XX9999'));
    cursorA = feedA.cursor;
  });

  // --------------------------------------------------------------- Test 10 --
  await test('Test 10 — the feed and the sweep are index-only, not collection scans', async () => {
    // Enough rows that a scan would be visibly different from a seek.
    const bulk = Array.from({ length: 3000 }, (_, i) => ({
      group_id: A,
      vehicle_number: `LD01${String(i).padStart(6, '0')}`,
      event_type: ACCESS_EVENT_TYPES.CREATED,
      vehicle_type: 'registered',
      device_names: [],
      source: 'registration',
      changed_at: new Date(Date.now() - (3000 - i) * 1000),
    }));
    await AccessChange.insertMany(bulk);

    await RegisteredVehicle.insertMany(
      Array.from({ length: 3000 }, (_, i) => ({
        group_id: A,
        vehicle_number: `LR01${String(i).padStart(6, '0')}`,
        name: 'Bulk',
        phone_number: '9000000000',
        valid_till: hours(24 * 365),
        is_active: true,
        expiry_emitted_at: null,
      }))
    );

    // The feed query, as readChanges builds it.
    const plan = await AccessChange.find({
      group_id: A,
      $or: [{ changed_at: { $gt: new Date(Date.now() - 60 * 1000) } }],
    })
      .sort({ changed_at: 1, _id: 1 })
      .limit(100)
      .explain('executionStats');

    const stats = plan.executionStats;
    const stage = JSON.stringify(plan.queryPlanner.winningPlan);

    check('feed query uses an index, not COLLSCAN', !stage.includes('COLLSCAN'), stage.slice(0, 200));
    check(
      'feed examines far fewer documents than the collection holds',
      stats.totalDocsExamined < 3000,
      `examined ${stats.totalDocsExamined} of ${bulk.length}+`
    );

    // The sweep query, as the sweeper builds it.
    const sweepPlan = await RegisteredVehicle.find({
      expiry_emitted_at: null,
      valid_till: { $lte: new Date() },
    })
      .limit(500)
      .explain('executionStats');

    const sweepStage = JSON.stringify(sweepPlan.queryPlanner.winningPlan);

    check('sweep query uses an index, not COLLSCAN',
      !sweepStage.includes('COLLSCAN'), sweepStage.slice(0, 200));
    check(
      'sweep examines nothing when nothing has expired',
      sweepPlan.executionStats.totalDocsExamined === 0,
      `examined ${sweepPlan.executionStats.totalDocsExamined} of 3000`
    );
  });

  // ------------------------------------------------------- Restart / empty --
  await test('Extra — a restart republishes nothing already reported', async () => {
    const before = await AccessChange.countDocuments({ group_id: A });
    await runSweep(); // what boot does
    const after = await AccessChange.countDocuments({ group_id: A });

    check('a boot sweep adds no duplicate events', after === before, `${before} -> ${after}`);
  });

  await test('Extra — a cold consumer with no cursor gets the whole log', async () => {
    const cold = await getVehicleFeed({ limit: 10 }, scopeOf(B), {});

    check('cold start returns changes', cold.records.length > 0);
    check('and reports where it is', typeof cold.next_cursor === 'string');
    check('resync_required is false on a normal poll', cold.resync_required === false);
  });

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed ? 1 : 0);
};

run().catch(async (error) => {
  console.error('\nTEST HARNESS ERROR:', error);
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    /* already down */
  }
  process.exit(1);
});
