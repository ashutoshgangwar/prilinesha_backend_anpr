// Environment must be validated before any module reads process.env.
const config = require('./config/env');

const logger = require('./utils/logger');
const app = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { ensureStorageDirectories } = require('./utils/imageStorage');
const VehicleLog = require('./models/VehicleLog');

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

    // Guarantees the unique transaction_id index exists even when autoIndex is
    // disabled in production.
    await VehicleLog.syncIndexes();
    logger.info('Indexes synchronised', { model: VehicleLog.modelName });

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
