// Environment must be validated before any module reads process.env.
const config = require('./config/env');

const logger = require('./utils/logger');
const app = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { ensureStorageDirectories } = require('./utils/imageStorage');
const { ensureSuperAdmin } = require('./config/bootstrap');
const VehicleLog = require('./models/VehicleLog');
const RegisteredVehicle = require('./models/RegisteredVehicle');
const Visitor = require('./models/Visitor');
const AccessChange = require('./models/AccessChange');
const User = require('./models/User');
const Project = require('./models/Project');
const { startSweeper, stopSweeper } = require('./jobs/accessSweeper');

let server;
let shuttingDown = false;

/**
 * Boots the process: storage directories → MongoDB (with retry) → indexes →
 * HTTP listener. Any failure here aborts with a non-zero exit code so a process
 * manager (pm2, systemd, Kubernetes) restarts or reports it.
 */
const start = async () => {
  try {
    await ensureStorageDirectories();
    await connectDatabase();

    // Guarantees the unique indexes (transaction_id, group_id + plate, email,
    // group_id) exist even when autoIndex is disabled in production. syncIndexes
    // also DROPS indexes no longer declared on a schema, which is what retires
    // the old globally-unique plate index once registrations became per-project.
    // AccessChange and the two sweep indexes matter most here: the feed's
    // cursor and the expiry sweep are both index-only by design, and running
    // either without its index turns a bounded lookup into a collection scan on
    // a loop.
    await Promise.all([
      VehicleLog.syncIndexes(),
      RegisteredVehicle.syncIndexes(),
      Visitor.syncIndexes(),
      AccessChange.syncIndexes(),
      User.syncIndexes(),
      Project.syncIndexes(),
    ]);
    logger.info('Indexes synchronised', {
      models: [
        VehicleLog.modelName,
        RegisteredVehicle.modelName,
        Visitor.modelName,
        AccessChange.modelName,
        User.modelName,
        Project.modelName,
      ],
    });

    // Must run after the indexes exist, so the first super admin cannot be
    // written without the unique email constraint in place.
    await ensureSuperAdmin();

    // Publishes the expiries and activations nothing else writes — see
    // jobs/accessSweeper.js. Started after the indexes, since its whole claim to
    // being cheap rests on them, and it runs once immediately so anything that
    // lapsed while this process was down reaches Intozi at boot rather than
    // after the first interval.
    startSweeper();

    server = app.listen(config.PORT, () => {
      logger.info('HTTP server listening', {
        port: config.PORT,
        env: config.NODE_ENV,
        docs: config.SWAGGER_ENABLED ? `http://localhost:${config.PORT}/api-docs` : null,
      });
    });

    server.setTimeout(config.REQUEST_TIMEOUT_MS);
    server.keepAliveTimeout = 65000; // above a typical 60s ALB idle timeout
    server.headersTimeout = 70000;
  } catch (error) {
    logger.error('Startup failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
};

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close the database. Force-exits if the deadline passes.
 */
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutdown initiated', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit', { timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Before the database closes, so a sweep in flight cannot be cut off
    // mid-write and leave rows claimed but unpublished.
    stopSweeper();

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info('HTTP server closed');
    }

    await disconnectDatabase();
    logger.info('Shutdown complete');
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException', 1);
});

start();
