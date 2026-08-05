const express = require('express');

const anprController = require('../controllers/anprController');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const validate = require('../middleware/validate');
const { anprEventRules } = require('../validators/anprValidator');

const router = express.Router();

/**
 * POST /api/anpr
 * Authorization: <API_KEY>
 *
 * 200 stored · 400 validation · 401 unauthorized · 409 duplicate transaction_id
 */
router.post('/', apiKeyAuth, validate(anprEventRules), anprController.createAnprEvent);

module.exports = router;
