const express = require('express');

const visitorController = require('../controllers/visitorController');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireProjectAccess } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/constants');
const {
  createVisitorRules,
  listVisitorsRules,
  visitorFilterOptionsRules,
  updateVisitorRules,
  setVisitorStatusRules,
  visitorIdParamRules,
} = require('../validators/visitorValidator');

const router = express.Router();

/**
 * Visitor passes — the temporary half of a project's access list.
 *
 * A pass grants one plate entry for a stated window, on a named resident's or
 * tenant's behalf. Inside that window `GET /api/anpr/feed` reports the plate as
 * "registered", exactly as it does for the permanent registry; once it closes,
 * or once the pass is revoked, the same plate reads as "unregistered" again with
 * nothing to run and nothing to switch off.
 *
 * Kept apart from `/api/vehicles` because they are different records with
 * different lifetimes: a registration says a vehicle belongs here and is renewed
 * for years, a pass says one is expected this afternoon and by whose invitation.
 * Both site types have visitors — a society's guests, a parking project's — so
 * nothing here branches on `project_type` except the word used for the host.
 */

router.use(authenticate);

/**
 * POST /api/visitors
 * Authorization: Bearer <token>
 *
 * Issues a pass. `group_id` may be omitted by a user assigned to exactly one
 * project. Always 201: a plate visiting again is a new visit, not a renewal.
 *
 * 201 issued · 400 validation · 401 unauthorized · 403 not your project ·
 * 404 no such host in this project · 409 plate already registered, or already
 * holds an overlapping pass here
 */
router.post(
  '/',
  authorize(PERMISSIONS.VISITOR_WRITE),
  validate(createVisitorRules),
  // After validation, so it works on the normalised group_id — and before the
  // controller, so no handler ever runs on an unauthorised project.
  requireProjectAccess,
  visitorController.createVisitor
);

/**
 * GET /api/visitors
 * Authorization: Bearer <token>
 *
 * Query: ?group_id= &search= &status=registered|unregistered &is_active=
 *        &on_site= &host_vehicle_id= &issued_by= &device_name= &from= &to=
 *        &page= &limit=
 * Without `group_id`, returns every project the caller can see.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/',
  authorize(PERMISSIONS.VISITOR_READ),
  validate(listVisitorsRules),
  visitorController.listVisitors
);

/**
 * GET /api/visitors/filters
 * Authorization: Bearer <token>
 *
 * What the filter bar above the visitor table can offer, and the row count
 * behind each chip. Registered before `/:id` deliberately — that route validates
 * a Mongo id, so a filters request arriving after it would be a 400 about a
 * malformed id rather than this endpoint.
 *
 * 200 ok · 400 validation · 401 unauthorized · 403 not your project
 */
router.get(
  '/filters',
  authorize(PERMISSIONS.VISITOR_READ),
  validate(visitorFilterOptionsRules),
  visitorController.getVisitorFilters
);

/**
 * The single-record routes below scope by folding the caller's projects into the
 * query, so a pass in another customer's project is a **404**, not a 403 — an
 * object id is opaque and guessable in bulk, and "that exists, but it is not
 * yours" would confirm which ids are real, and for whom.
 *
 * `requireProjectAccess` is deliberately absent here: it resolves a project from
 * the *body*, which is right when issuing a pass and wrong when acting on one
 * that already names its own project.
 */

/**
 * GET /api/visitors/:id
 * Authorization: Bearer <token>
 *
 * 200 ok · 400 bad id · 401 unauthorized · 404 not in your projects
 */
router.get(
  '/:id',
  authorize(PERMISSIONS.VISITOR_READ),
  validate(visitorIdParamRules),
  visitorController.getVisitor
);

/**
 * PATCH /api/visitors/:id
 * Authorization: Bearer <token>
 *
 * Extends the window, corrects the host, restricts the gates. Only the fields
 * sent change. `group_id` and `vehicle_number` are immutable — a different plate
 * is a different visit. A widened window is re-checked against the plate's other
 * passes, because an edit can create the very overlap a create would have been
 * refused for.
 *
 * 200 ok · 400 validation / empty body · 401 unauthorized · 404 not in your
 * projects · 409 overlaps another pass
 */
router.patch(
  '/:id',
  authorize(PERMISSIONS.VISITOR_WRITE),
  validate(updateVisitorRules),
  visitorController.updateVisitor
);

/**
 * PATCH /api/visitors/:id/status
 * Authorization: Bearer <token>
 *
 * `{ "is_active": false }` revokes the pass: the plate reads as unregistered at
 * every gate immediately, whatever its window says. `true` reinstates it for
 * whatever remains. Live on Intozi's next poll.
 *
 * 200 ok · 400 validation · 401 unauthorized · 404 not in your projects
 */
router.patch(
  '/:id/status',
  authorize(PERMISSIONS.VISITOR_WRITE),
  validate(setVisitorStatusRules),
  visitorController.setVisitorStatus
);

/**
 * DELETE /api/visitors/:id
 * Authorization: Bearer <token>
 *
 * Prefer revoking: a deleted pass takes with it who was admitted, by whom and on
 * whose invitation — which is most of what the record is for once the visit is
 * over. Detections already logged are untouched.
 *
 * 200 ok · 400 bad id · 401 unauthorized · 404 not in your projects
 */
router.delete(
  '/:id',
  authorize(PERMISSIONS.VISITOR_WRITE),
  validate(visitorIdParamRules),
  visitorController.deleteVisitor
);

module.exports = router;
