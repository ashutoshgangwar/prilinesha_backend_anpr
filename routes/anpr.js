const express = require('express');

const anprController = require('../controllers/anprController');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const normalizeAnprPayloadAliases = require('../middleware/anprPayloadAliases');
const validate = require('../middleware/validate');
const { anprEventRules } = require('../validators/anprValidator');

const router = express.Router();

/**
 * The camera-facing endpoints. Authenticated with an API key, not a dashboard
 * token: a per-project key (`pk_…`) binds the request to one project, and the
 * legacy global API_KEY still works unscoped for cameras deployed before
 * projects existed.
 */

/**
 * POST /api/anpr
 * Authorization: Bearer <project API key>
 *
 * The event is stored against the key's project; a `group_id` in the body
 * cannot override it.
 *
 * The vendor key names are accepted as aliases (`plate`, `frame`, `plate_roi`,
 * `vehicle_category`) and translated before validation — see
 * middleware/anprPayloadAliases.js.
 *
 * 200 stored · 400 validation · 401 unauthorized · 403 project deactivated ·
 * 409 duplicate transaction_id
 */
router.post(
  '/',
  apiKeyAuth,
  normalizeAnprPayloadAliases,
  validate(anprEventRules),
  anprController.createAnprEvent
);

/**
 * The old `GET /api/feed` registry-pull endpoint has been removed. The registry
 * is now pushed to Intozi's Ikshana watchlist as it changes, rather than polled
 * from here — see services/intoziService.js and docs/INTOZI-INTEGRATION.md.
 */

module.exports = router;
