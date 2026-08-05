const express = require('express');

const { getConnectionState, isConnected } = require('../config/database');

const router = express.Router();

/**
 * GET /health
 * Liveness probe — intentionally unauthenticated and cheap.
 */
router.get('/', (_req, res) => {
  res.status(200).json({ status: 'UP' });
});

/**
 * GET /health/ready
 * Readiness probe — reports 503 while MongoDB is unavailable so a load balancer
 * stops routing traffic to this instance.
 */
router.get('/ready', (_req, res) => {
  const ready = isConnected();

  res.status(ready ? 200 : 503).json({
    status: ready ? 'UP' : 'DOWN',
    database: getConnectionState(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
