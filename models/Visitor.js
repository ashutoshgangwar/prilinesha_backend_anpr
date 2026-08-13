const mongoose = require('mongoose');

const { RESIDENT_OCCUPANT_TYPES } = require('../utils/constants');

/**
 * A visitor pass — one plate allowed in, for a stated window, on somebody's
 * behalf.
 *
 * Its own collection rather than a flag on RegisteredVehicle, because it is a
 * different thing with a different lifetime. A registration answers "does this
 * vehicle belong here?" and is renewed for years; a pass answers "is this
 * vehicle expected between 14:00 and 18:00 today, and who let it in?" and is
 * dead by the evening. Folding the two together would mean one row that is
 * sometimes a resident and sometimes a stranger, one `valid_till` doing two
 * jobs, and a registry an operator can no longer read as a list of who lives
 * here.
 *
 * Status is derived on every read, exactly as on the registry — three things
 * decide it, and all three must hold for the plate to open a barrier:
 *
 *   valid_from — already reached. A pass issued this morning for tomorrow
 *                afternoon reads as unregistered until tomorrow afternoon, so
 *                pre-booking a visitor does not let them in early.
 *   valid_till — not yet passed. This is the "allow this vehicle for a specific
 *                period, then treat it as unregistered again" rule, and it is
 *                time that enforces it, not a job that has to run.
 *   is_active  — not switched off from the dashboard, for the visitor who left
 *                early or the pass issued by mistake.
 *
 * Scoped to a `group_id` like everything else: a pass at one site says nothing
 * about the same plate at another.
 */
const visitorSchema = new mongoose.Schema(
  {
    // The tenant boundary. Same normalisation as Project.group_id and
    // RegisteredVehicle.group_id, so a lookup can never miss on casing alone.
    group_id: { type: String, required: true, trim: true, uppercase: true },

    // Joined against VehicleLog.vehicle_number and the Intozi feed, so it is
    // normalised identically to the registry's copy.
    vehicle_number: { type: String, required: true, trim: true, uppercase: true },

    // The visitor themselves.
    name: { type: String, required: true, trim: true },
    phone_number: { type: String, trim: true, default: null },

    // Free text, same reasoning as on the registry: a note that helps the guard
    // recognise the vehicle, not something anything branches on.
    vehicle_model: { type: String, trim: true, default: null },

    // Why they are here — "delivery", "guest of 4B", "AC service". Optional,
    // and purely for the gate log a human reads.
    purpose: { type: String, trim: true, default: null },

    // ---- Who they are visiting ----
    //
    // A visitor is always somebody's visitor: the point of the record is that
    // the resident in 4B, or the tenant of bay 12, is accountable for the
    // vehicle being on site. That is why `host_name` is required even when no
    // registry row is linked.

    // 'resident' in a society, 'tenant' in a parking project — stamped from the
    // project's own type when the pass is created, so the word on the record is
    // the word that customer uses. Null on a project whose type was never set.
    host_type: { type: String, enum: [...RESIDENT_OCCUPANT_TYPES, null], default: null },

    // The host's own registration, when they have one. Optional because plenty
    // of hosts are known by flat number and have no vehicle on the registry at
    // all — and a pass that could not be issued to them would simply be issued
    // with the field left blank anyway.
    host_vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'RegisteredVehicle', default: null },

    // Copied from the host's registration when one is linked, typed by the
    // operator otherwise. Stored rather than only referenced, so the pass still
    // says who admitted this vehicle after the host's registration is deleted.
    host_name: { type: String, required: true, trim: true },
    host_phone: { type: String, trim: true, default: null },

    // Flat, shop, bay or office number — how a guard actually identifies a host.
    host_unit: { type: String, trim: true, default: null },

    // ---- The window ----
    // Both ends are stored instants. A date sent without a time is expanded by
    // the validator: `valid_from` to 00:00:00.000 of that day and `valid_till`
    // to 23:59:59.999, so "valid on the 14th" means the whole 14th, while
    // "14:00 to 18:00" is stored as sent.
    valid_from: { type: Date, required: true },
    valid_till: { type: Date, required: true },

    // Which gates the pass is good for. Empty means every device in the
    // project, matching the registry's wildcard exactly.
    device_names: { type: [{ type: String, trim: true }], default: [] },

    // The manual switch: false reads as unregistered at every gate whatever the
    // window says. Revoking a pass beats deleting it — the record of who was
    // admitted, by whom, and when it was withdrawn survives.
    is_active: { type: Boolean, default: true },

    // ---- Change-feed bookkeeping (see jobs/accessSweeper.js) ----
    //
    // A pass has two time-driven transitions, and neither writes to the row:
    // its window opens at valid_from and closes at valid_till. Both must reach
    // Intozi as changes, so both get a marker the sweeper can query on as an
    // indexed equality — "has this one been reported yet?".
    //
    // A pass issued for a window already in progress has its activation marker
    // set at creation, since the CREATED change already told Intozi it is valid;
    // the sweeper must not announce it a second time.
    //
    // Both reset to null when the window is edited, which re-arms whichever
    // transition now lies in the future.
    activation_emitted_at: { type: Date, default: null },
    expiry_emitted_at: { type: Date, default: null },

    // Audit: which dashboard user issued the pass, and who last touched it.
    issued_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Deliberately NOT unique on (group_id, vehicle_number): the same courier visits
// the same society every week, and each visit is its own record with its own
// window and its own host. This is the ingestion-time lookup — "is there a live
// pass for this plate here?" — so valid_till leads, newest window first.
visitorSchema.index(
  { group_id: 1, vehicle_number: 1, valid_till: -1 },
  { name: 'idx_visitor_group_vehicle' }
);

// Dashboard status filtering: who is on site now, whose pass has run out.
visitorSchema.index(
  { group_id: 1, is_active: 1, valid_till: 1 },
  { name: 'idx_visitor_group_active_valid_till' }
);

// Default dashboard listing: newest pass first, within a project.
visitorSchema.index({ group_id: 1, createdAt: -1 }, { name: 'idx_visitor_group_created_at' });

// "Who has this resident been letting in?" — a question the dashboard asks from
// the host's own row, and one this collection would otherwise scan to answer.
visitorSchema.index({ host_vehicle: 1, createdAt: -1 }, { name: 'idx_visitor_host_vehicle' });

// Kept for the same reason as the registry's: the feed now reads the change log,
// but the seed script walks passes in this order to build it.
visitorSchema.index(
  { group_id: 1, updatedAt: 1, _id: 1 },
  { name: 'idx_visitor_feed_cursor' }
);

// The two time-driven sweeps. Same shape and same reasoning as the registry's
// expiry index: equality on the marker, range on the date, so each sweep walks
// only the passes that have actually just opened or just closed.
visitorSchema.index(
  { expiry_emitted_at: 1, valid_till: 1 },
  { name: 'idx_visitor_expiry_sweep' }
);

visitorSchema.index(
  { activation_emitted_at: 1, valid_from: 1 },
  { name: 'idx_visitor_activation_sweep' }
);

module.exports = mongoose.model('Visitor', visitorSchema);
