const anprService = require('../services/anprService');
const asyncHandler = require('../utils/asyncHandler');
const { toSenderVocabulary } = require('../middleware/anprPayloadAliases');

/**
 * POST /api/anpr
 * Ingests one ANPR detection event. Kept deliberately thin: adapt HTTP in,
 * delegate to the service, adapt HTTP out.
 *
 * `req.project` is set by the API-key middleware when the caller used a
 * per-project key; the service binds the event to that project regardless of
 * what the body claims.
 *
 * The response is written in whichever vocabulary the request used: a sender
 * that posted `plate` and `frame` reads back `plate` and `frame_path`, one that
 * posted `vehicle_number` and `event_image` reads back exactly what it always
 * did. `req.anprAliases` records which names arrived (see
 * middleware/anprPayloadAliases.js).
 */
const createAnprEvent = asyncHandler(async (req, res) => {
  const result = await anprService.createAnprEvent(req.body, {
    project: req.project,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    message: 'ANPR event stored successfully.',
    data: toSenderVocabulary(result, req.anprAliases),
    requestId: req.id,
  });
});

// `GET /api/feed` has been retired. The registry is pushed to Intozi's Ikshana
// watchlist as it changes (services/intoziService.js) instead of being polled
// from here. The change-log machinery it read from (services/accessChangeService
// and jobs/accessSweeper) is kept for audit and for driving the push.

module.exports = { createAnprEvent };
