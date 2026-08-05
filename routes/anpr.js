const express = require('express');

const anprController = require('../controllers/anprController');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const validate = require('../middleware/validate');
const { anprEventRules, anprFeedQueryRules } = require('../validators/anprValidator');

const router = express.Router();

/**
 * POST /api/anpr
 * Authorization: <API_KEY>
 *
 * 200 stored · 400 validation · 401 unauthorized · 409 duplicate transaction_id
 */
router.post('/', apiKeyAuth, validate(anprEventRules), anprController.createAnprEvent);

/**
 * GET /api/anpr/feed
 * Authorization: <API_KEY>
 *
 * Polled by the Intozi server every 5-10 seconds. Returns vehicle_number and
 * vehicle_type (registered/unregistered); every other field is null by contract.
 * Pass the previous response's `next_cursor` to receive only new events.
 *
 * 200 ok · 400 bad cursor/query · 401 unauthorized
 */
router.get('/feed', apiKeyAuth, validate(anprFeedQueryRules), anprController.getVehicleFeed);

module.exports = router;
