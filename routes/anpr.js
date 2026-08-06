const express = require('express');

const anprController = require('../controllers/anprController');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const validate = require('../middleware/validate');
const { anprEventRules, anprFeedQueryRules } = require('../validators/anprValidator');

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
 * 200 stored · 400 validation · 401 unauthorized · 403 project deactivated ·
 * 409 duplicate transaction_id
 */
router.post('/', apiKeyAuth, validate(anprEventRules), anprController.createAnprEvent);

/**
 * GET /api/anpr/feed
 * Authorization: Bearer <project API key>
 *
 * Polled by the Intozi server every 5-10 seconds. Reads the registered-vehicle
 * registry, not the detection log: each row is exactly vehicle_number, group_id
 * and vehicle_type (registered/unregistered, derived from valid_till at read
 * time). Pass the previous response's `next_cursor` to receive only new or
 * renewed registrations.
 *
 * Scoped to the key's project — a key issued for one site cannot read another
 * customer's plates, with or without a `group_id` parameter.
 *
 * 200 ok · 400 bad cursor/query · 401 unauthorized · 403 out-of-scope group_id
 */
router.get('/feed', apiKeyAuth, validate(anprFeedQueryRules), anprController.getVehicleFeed);

module.exports = router;
