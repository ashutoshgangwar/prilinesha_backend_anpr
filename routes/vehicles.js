const express = require('express');

const vehicleController = require('../controllers/vehicleController');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const validate = require('../middleware/validate');
const { registerVehicleRules, listVehiclesRules } = require('../validators/vehicleValidator');

const router = express.Router();

/**
 * Registered-vehicle registry, driven by the internal dashboard.
 *
 * What is stored here decides what `GET /api/anpr/feed` reports to Intozi: a
 * plate registered and still inside its `valid_till` window is detected as
 * "registered", everything else as "unregistered".
 */

/**
 * POST /api/vehicles
 * Authorization: <API_KEY>
 *
 * Adds a vehicle (201) or renews an already-registered plate (200).
 *
 * 200 renewed · 201 created · 400 validation · 401 unauthorized
 */
router.post('/', apiKeyAuth, validate(registerVehicleRules), vehicleController.registerVehicle);

/**
 * GET /api/vehicles
 * Authorization: <API_KEY>
 *
 * Dashboard table: ?search= &status=registered|unregistered &page= &limit=
 *
 * 200 ok · 400 validation · 401 unauthorized
 */
router.get('/', apiKeyAuth, validate(listVehiclesRules), vehicleController.listVehicles);

module.exports = router;
