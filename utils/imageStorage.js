const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('./AppError');
const { IMAGE_DIRECTORIES, IMAGE_KIND } = require('./constants');

/**
 * Base64 image persistence.
 *
 * Responsibilities: decode, sanity-check and write incoming base64 payloads to
 * disk, and roll those writes back when a later step (e.g. the Mongo insert)
 * fails. It knows nothing about HTTP or the database.
 */

const DATA_URI_PREFIX = /^data:image\/(jpeg|jpg|png);base64,/i;
const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;

/** Magic-byte signatures, so a renamed .exe cannot be stored as a .jpg. */
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];

const detectImageType = (buffer) =>
  SIGNATURES.find((signature) => signature.bytes.every((byte, index) => buffer[index] === byte));

/** Creates the upload directories once at boot so writes never race on mkdir. */
const ensureStorageDirectories = async () => {
  const directories = Object.values(IMAGE_DIRECTORIES).map((dir) => path.join(config.UPLOAD_DIR, dir));

  await Promise.all(directories.map((dir) => fs.mkdir(dir, { recursive: true })));
  logger.info('Image storage ready', { uploadDir: config.UPLOAD_DIR, directories });
};

/**
 * Decodes a base64 (optionally data-URI prefixed) image.
 *
 * @param {string} raw       Base64 payload.
 * @param {string} fieldName Field name used in the error message.
 * @returns {{ buffer: Buffer, ext: string, mime: string }}
 * @throws {AppError} 400 when the payload is not a decodable JPG/PNG.
 */
const decodeBase64Image = (raw, fieldName) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw AppError.badRequest(`${fieldName} must be a non-empty base64 string.`);
  }

  // Strip an optional data-URI header and any whitespace/newlines the sender wrapped in.
  const payload = raw.replace(DATA_URI_PREFIX, '').replace(/\s/g, '');

  if (!payload || payload.length % 4 !== 0 || !BASE64_CHARS.test(payload)) {
    throw AppError.badRequest(`${fieldName} is not valid base64 data.`);
  }

  const buffer = Buffer.from(payload, 'base64');

  if (buffer.length === 0) {
    throw AppError.badRequest(`${fieldName} decoded to an empty image.`);
  }
  if (buffer.length > config.MAX_IMAGE_BYTES) {
    throw AppError.badRequest(
      `${fieldName} exceeds the maximum allowed size of ${Math.floor(config.MAX_IMAGE_BYTES / 1024)} KB.`
    );
  }

  const type = detectImageType(buffer);
  if (!type) {
    throw AppError.badRequest(`${fieldName} is not a valid JPG or PNG image.`);
  }

  return { buffer, ext: type.ext, mime: type.mime };
};

/**
 * Builds a collision-proof filename from the transaction id and a timestamp.
 * Example: event_108_20251222T123301844Z_9f3c1a20.jpg
 */
const buildFilename = ({ kind, transactionId, ext }) => {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, ''); // 2025-12-22T12:33:01.844Z -> 20251222T123301844Z
  const suffix = uuidv4().split('-')[0];
  const safeTransactionId = String(transactionId).replace(/[^A-Za-z0-9_-]/g, '');

  return `${kind}_${safeTransactionId}_${timestamp}_${suffix}.${ext}`;
};

/**
 * Decodes and writes a single image to its kind-specific directory.
 *
 * @returns {Promise<{absolutePath: string, relativePath: string, publicUrl: string, bytes: number, mime: string}>}
 */
const saveImage = async ({ base64, kind, transactionId, fieldName }) => {
  const directory = IMAGE_DIRECTORIES[kind];
  if (!directory) throw AppError.internal(`Unknown image kind: ${kind}`);

  const { buffer, ext, mime } = decodeBase64Image(base64, fieldName);
  const filename = buildFilename({ kind, transactionId, ext });
  const absolutePath = path.join(config.UPLOAD_DIR, directory, filename);

  try {
    await fs.writeFile(absolutePath, buffer, { flag: 'wx' }); // wx: never clobber an existing file
  } catch (error) {
    logger.error('Failed to write image to disk', { kind, transactionId, error: error.message });
    throw AppError.internal(`Failed to store ${fieldName}.`);
  }

  const relativePath = path.posix.join(path.basename(config.UPLOAD_DIR), directory, filename);

  return {
    absolutePath,
    relativePath,
    publicUrl: `${config.UPLOAD_PUBLIC_PATH}/${directory}/${filename}`,
    bytes: buffer.length,
    mime,
  };
};

/**
 * Stores whichever images the camera sent for one ANPR event.
 *
 * Both are optional: an absent payload yields `null` for that slot. If the
 * second write fails, the first file is removed — a half-written event must not
 * leave orphans on disk.
 *
 * @returns {Promise<{ event: object|null, plate: object|null }>}
 */
const saveEventImages = async ({ eventImage, plateImage, transactionId }) => {
  const stored = [];

  const store = async (base64, kind, fieldName) => {
    if (base64 === undefined || base64 === null || String(base64).trim() === '') return null;

    const result = await saveImage({ base64, kind, transactionId, fieldName });
    stored.push(result.absolutePath);
    return result;
  };

  try {
    const event = await store(eventImage, IMAGE_KIND.EVENT, 'event_image');
    const plate = await store(plateImage, IMAGE_KIND.PLATE, 'plate_image');

    return { event, plate };
  } catch (error) {
    await removeFiles(stored);
    throw error;
  }
};

/** Best-effort rollback. Never throws — the original error must survive. */
const removeFiles = async (absolutePaths = []) => {
  await Promise.all(
    absolutePaths.filter(Boolean).map(async (filePath) => {
      try {
        await fs.unlink(filePath);
        logger.warn('Rolled back stored image', { filePath });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error('Failed to roll back stored image', { filePath, error: error.message });
        }
      }
    })
  );
};

module.exports = {
  ensureStorageDirectories,
  decodeBase64Image,
  saveImage,
  saveEventImages,
  removeFiles,
};
