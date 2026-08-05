const mongoose = require('mongoose');

const config = require('./env');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Human-readable mongoose connection states, indexed by readyState. */
const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

let listenersBound = false;

const bindConnectionListeners = () => {
  if (listenersBound) return;
  listenersBound = true;

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (error) => logger.error('MongoDB connection error', { error: error.message }));
};

/**
 * Connects to MongoDB, retrying with exponential backoff (capped at 30s).
 * Throws once every attempt has been exhausted so the caller can abort boot.
 */
const connectDatabase = async () => {
  bindConnectionListeners();
  mongoose.set('strictQuery', true);

  for (let attempt = 1; attempt <= config.MONGO_MAX_RETRIES; attempt += 1) {
    try {
      await mongoose.connect(config.MONGO_URI, {
        serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        maxPoolSize: 20,
        minPoolSize: 2,
        autoIndex: !config.IS_PRODUCTION, // build indexes explicitly in production
      });

      logger.info('MongoDB connected', {
        host: mongoose.connection.host,
        database: mongoose.connection.name,
        attempt,
      });
      return mongoose.connection;
    } catch (error) {
      const isLastAttempt = attempt === config.MONGO_MAX_RETRIES;
      const delay = Math.min(config.MONGO_RETRY_DELAY_MS * 2 ** (attempt - 1), 30000);

      logger.error('MongoDB connection attempt failed', {
        attempt,
        maxRetries: config.MONGO_MAX_RETRIES,
        retryInMs: isLastAttempt ? null : delay,
        error: error.message,
      });

      if (isLastAttempt) throw error;
      await sleep(delay);
    }
  }

  return undefined; // unreachable — the loop either returns or throws
};

const disconnectDatabase = async () => {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
};

const getConnectionState = () => READY_STATES[mongoose.connection.readyState] || 'unknown';

const isConnected = () => mongoose.connection.readyState === 1;

module.exports = { connectDatabase, disconnectDatabase, getConnectionState, isConnected };
