const anprService = require('../services/anprService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /api/anpr
 * Ingests one ANPR detection event. Kept deliberately thin: adapt HTTP in,
 * delegate to the service, adapt HTTP out.
 */
const createAnprEvent = asyncHandler(async (req, res) => {
  const result = await anprService.createAnprEvent(req.body, { requestId: req.id });

  res.status(200).json({
    success: true,
    message: 'ANPR event stored successfully.',
    data: result,
    requestId: req.id,
  });
});

module.exports = { createAnprEvent };
