const mongoose = require('mongoose');

const { RESIDENT_OCCUPANT_TYPES } = require('../utils/constants');

/**
 * A vehicle registered from the internal dashboard, within one project.
 *
 * This collection is the authority on the registered/unregistered status that
 * `GET /api/anpr/feed` reports to Intozi. Two things decide it, and both must
 * hold for a plate to read as registered:
 *
 *   valid_till — still in the future. Expiry is implicit, not a flag someone
 *                has to flip: the moment it passes, every later detection is
 *                reported as unregistered, with no scheduled job involved.
 *   is_active  — the dashboard has not switched this registration off. A
 *                manual override for the cases a date cannot express: a
 *                resident who moved out, a pass suspended pending payment.
 *
 * Keeping them separate matters. A single stored `status` column would have to
 * be rewritten by a cron job the instant a pass expired, and would silently
 * disagree with `valid_till` the moment that job failed. Here, deactivating is
 * the only thing a person can set, and time takes care of the rest.
 *
 * Registration is scoped to a `group_id` (a project), so the same plate can be
 * a resident at one site and a stranger at another — the two records never see
 * each other.
 */
const registeredVehicleSchema = new mongoose.Schema(
  {
    // The tenant boundary. Matches Project.group_id and VehicleLog.group_id,
    // uppercased identically so a lookup can never miss on casing alone.
    group_id: { type: String, required: true, trim: true, uppercase: true },

    // The join key against VehicleLog.vehicle_number — same normalisation
    // (trimmed, uppercase) for the same reason.
    vehicle_number: { type: String, required: true, trim: true, uppercase: true },

    name: { type: String, required: true, trim: true },
    phone_number: { type: String, required: true, trim: true },

    // Who the holder is to this site: `resident` in a society, `tenant` in a
    // parking project. Derived from the project's own type when the vehicle is
    // registered, so the dashboard shows each customer the word they use rather
    // than a generic "owner" — and so a report can tell the permanent occupants
    // apart from the visitor passes in models/Visitor.js.
    //
    // Nullable rather than required, for the same reason Project.project_type
    // is: rows written before this field existed, and projects created without a
    // type, must still save when the ingestion path touches them. Nothing in the
    // barrier decision reads it — it is descriptive, not a permission.
    occupant_type: { type: String, enum: [...RESIDENT_OCCUPANT_TYPES, null], default: null },

    // Flat, shop, bay or office number. Free text, because "A-402", "Shop 12"
    // and "Bay 7" are all correct at different sites — and because it is what a
    // guard actually asks for when a visitor names their host.
    unit_number: { type: String, trim: true, default: null },

    // Make and model as the dashboard user typed it — "Swift Dzire", "Activa
    // 6G". Free text on purpose: this is a note to help an operator recognise
    // the vehicle at the gate, not a field anything branches on, and a fixed
    // list would be wrong within a week.
    //
    // Optional, and independent of the model a camera may report on an event:
    // that one is what the ANPR system inferred, this one is what a person
    // recorded. GET /api/logs prefers the camera's and falls back to this.
    vehicle_model: { type: String, trim: true, default: null },

    // Inclusive: a date sent without a time is stored as 23:59:59.999 UTC of
    // that day, so "valid till the 31st" means the whole 31st.
    valid_till: { type: Date, required: true },

    // Which gates this registration is good for. Empty means every device in
    // the project — the common case, and the default.
    device_names: { type: [{ type: String, trim: true }], default: [] },

    // The dashboard's manual switch. false reports the plate as unregistered at
    // every gate regardless of valid_till — deactivating beats deleting,
    // because the record and its audit trail survive and it can be switched
    // back on without re-keying anything.
    is_active: { type: Boolean, default: true },

    // When the sweeper wrote this registration's EXPIRED change (see
    // jobs/accessSweeper.js). Null means "valid_till has not been reported as
    // passed yet", which is what the sweeper looks for.
    //
    // This exists because expiry is the one state change nothing writes: the
    // clock crosses valid_till and the document is untouched, so `updatedAt`
    // cannot reveal it and the change feed would never carry it. The marker
    // turns "has this been reported?" into an indexed equality, so the sweep
    // touches only rows that have actually lapsed and never re-touches one.
    //
    // Reset to null whenever valid_till is extended, which is what re-arms a
    // renewed registration to expire again later.
    expiry_emitted_at: { type: Date, default: null },

    // Audit: which dashboard user registered or last renewed this vehicle.
    registered_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Who last edited, deactivated or reactivated it. Distinct from
    // registered_by so "who added this?" survives somebody else's edit.
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

// One record per plate *per project* — re-adding a vehicle inside the same
// project renews it instead of duplicating, while a different project keeps its
// own independent record.
registeredVehicleSchema.index(
  { group_id: 1, vehicle_number: 1 },
  { unique: true, name: 'uniq_group_vehicle_number' }
);

// Dashboard "expiring soon" / status filtering, within a project. is_active
// leads valid_till because status filtering asks for both, and it is the more
// selective of the two on a registry where most rows are switched on.
registeredVehicleSchema.index(
  { group_id: 1, is_active: 1, valid_till: 1 },
  { name: 'idx_group_active_valid_till' }
);

// Default dashboard listing: newest registration first, within a project.
registeredVehicleSchema.index({ group_id: 1, createdAt: -1 }, { name: 'idx_group_created_at' });

// The "residents" / "tenants" tab of that same table — the listing above with
// one equality in front of it, so the sort still comes off the index.
registeredVehicleSchema.index(
  { group_id: 1, occupant_type: 1, createdAt: -1 },
  { name: 'idx_group_occupant_created_at' }
);

// The Intozi feed's keyset cursor used to walk this collection directly. It now
// reads the access-change log instead (models/AccessChange.js), but the index
// stays: `GET /api/vehicles` sorts by updatedAt for the dashboard, and the seed
// script walks the registry in this order to build the initial change log.
registeredVehicleSchema.index(
  { group_id: 1, updatedAt: 1, _id: 1 },
  { name: 'idx_group_feed_cursor' }
);

// The expiry sweep, and the reason it is not a collection scan.
//
// Equality on the marker first, then a range on valid_till — the shape a
// compound index serves best. The sweep asks "not yet reported, and lapsed",
// which walks only the rows that have genuinely just expired, however many
// hundred thousand registrations sit behind them. Once a row is marked it leaves
// the index range for good.
registeredVehicleSchema.index(
  { expiry_emitted_at: 1, valid_till: 1 },
  { name: 'idx_expiry_sweep' }
);

module.exports = mongoose.model('RegisteredVehicle', registeredVehicleSchema);
