const crypto = require('crypto');

const config = require('../config/env');
const Project = require('../models/Project');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { hashApiKey, looksLikeProjectKey } = require('../utils/apiKeys');
const { AUTH_SUBJECT } = require('../utils/constants');

/**
 * Machine authentication for the camera-facing endpoints (Intozi).
 *
 * Two kinds of credential are accepted:
 *
 *   pk_… project key — issued per project. The request is bound to that one
 *                      project: its events are written with that group_id and
 *                      its feed returns that project's events only, so a key
 *                      leaked from one site cannot read another customer's
 *                      plates even by guessing a group_id.
 *
 *   global API_KEY   — the original shared secret. Unscoped: it may post for
 *                      any project and read the whole feed. Kept so cameras
 *                      deployed before projects existed keep working; issue
 *                      project keys for anything new.
 */

/**
 * Constant-time string comparison — prevents an attacker from recovering the
 * key one character at a time by measuring response latency.
 */
const safeCompare = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));

  // timingSafeEqual throws on length mismatch, so hash first to equalise lengths.
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();

  return crypto.timingSafeEqual(hashA, hashB);
};

/**
 * Extracts the key from `Authorization: <key>`, `Authorization: Bearer <key>`
 * or the `x-api-key` header.
 */
const extractApiKey = (req) => {
  const authorization = req.get('authorization');

  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return (match ? match[1] : authorization).trim();
  }

  const headerKey = req.get('x-api-key');
  return headerKey ? headerKey.trim() : null;
};

/**
 * Rejects any request that does not carry a valid API key.
 *
 * On success sets, for the handlers downstream:
 *   req.project     — the Project document, or null for the global key
 *   req.groupId     — the project's group_id, or null
 *   req.authSubject — 'project' | 'root'
 *   req.scope       — the same shape the dashboard middleware produces, so the
 *                     services can apply one scoping rule regardless of caller
 *
 * Responds 401 without echoing the supplied value back to the client or logs.
 */
module.exports = async function apiKeyAuth(req, _res, next) {
  try {
    const provided = extractApiKey(req);

    if (!provided) {
      logger.warn('Rejected request: missing API key', {
        requestId: req.id,
        ip: req.ip,
        path: req.originalUrl,
      });
      return next(AppError.unauthorized('Missing API key. Send it in the Authorization header.'));
    }

    // ---- Per-project key ----
    // The key is 192 bits of randomness, so an indexed lookup on its digest is
    // safe: there is nothing to guess a character at a time.
    if (looksLikeProjectKey(provided)) {
      const project = await Project.findOne({ api_key_hash: hashApiKey(provided) }).select(
        '+api_key_hash'
      );

      if (!project) {
        logger.warn('Rejected request: unknown project API key', {
          requestId: req.id,
          ip: req.ip,
          path: req.originalUrl,
        });
        return next(AppError.unauthorized('Invalid API key.'));
      }

      if (!project.is_active) {
        logger.warn('Rejected request: project is deactivated', {
          requestId: req.id,
          group_id: project.group_id,
        });
        return next(
          AppError.forbidden(`Project "${project.group_id}" is deactivated. Contact Prilinesha.`)
        );
      }

      req.project = project;
      req.groupId = project.group_id;
      req.authSubject = AUTH_SUBJECT.PROJECT;
      req.scope = { groupIds: [project.group_id], isSuperAdmin: false };

      return next();
    }

    // ---- Legacy global key ----
    if (!safeCompare(provided, config.API_KEY)) {
      logger.warn('Rejected request: invalid API key', {
        requestId: req.id,
        ip: req.ip,
        path: req.originalUrl,
      });
      return next(AppError.unauthorized('Invalid API key.'));
    }

    req.project = null;
    req.groupId = null;
    req.authSubject = AUTH_SUBJECT.ROOT;
    req.scope = { groupIds: null, isSuperAdmin: true };

    return next();
  } catch (error) {
    return next(error);
  }
};
