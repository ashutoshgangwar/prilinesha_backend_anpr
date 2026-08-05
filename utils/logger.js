const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Never let a base64 image blob reach the log files. */
const REDACTED_KEYS = new Set(['event_image', 'plate_image', 'authorization', 'x-api-key', 'api_key']);

const RESERVED = new Set(['level', 'message', 'timestamp', 'stack', 'service']);

// Mutates `info` in place: returning a new object would drop the internal
// Symbol keys winston's transports rely on, silently discarding every log line.
const redact = winston.format((info) => {
  const walk = (value, depth) => {
    if (depth > 4 || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        value[index] = walk(item, depth + 1);
      });
      return value;
    }

    Object.keys(value).forEach((key) => {
      value[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : walk(value[key], depth + 1);
    });
    return value;
  };

  Object.keys(info).forEach((key) => {
    if (RESERVED.has(key)) return;
    info[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : walk(info[key], 1);
  });

  return info;
});

const consoleFormat = winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
  const context = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${stack || message}${context}`;
});

const transports = [
  new winston.transports.Console({
    format: IS_PRODUCTION
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), consoleFormat),
  }),
  new winston.transports.DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    zippedArchive: true,
  }),
  new winston.transports.DailyRotateFile({
    level: 'error',
    dirname: LOG_DIR,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    zippedArchive: true,
  }),
];

const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'anpr-api' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redact(),
    winston.format.json()
  ),
  transports,
  exitOnError: false,
});

/**
 * Returns a logger that stamps every entry with the current request id, so a
 * single event can be traced end to end across middleware, service and storage.
 */
logger.withRequest = (req) => logger.child({ requestId: req?.id });

module.exports = logger;
