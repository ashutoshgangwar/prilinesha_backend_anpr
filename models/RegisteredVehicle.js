const mongoose = require('mongoose');

/**
 * A vehicle registered from the internal dashboard, within one project.
 *
 * This collection is the authority on the registered/unregistered status that
 * `GET /api/anpr/feed` reports to Intozi: a plate found here for the detecting
 * project, and still inside its `valid_till` window, is registered — anything
 * else is unregistered. Expiry is therefore implicit, not a flag someone has to
 * flip: the moment `valid_till` passes, every later detection is reported as
 * unregistered.
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

    // Inclusive: a date sent without a time is stored as 23:59:59.999 UTC of
    // that day, so "valid till the 31st" means the whole 31st.
    valid_till: { type: Date, required: true },

    // Which gates this registration is good for. Empty means every device in
    // the project — the common case, and the default.
    device_names: { type: [{ type: String, trim: true }], default: [] },

    // Audit: which dashboard user registered or last renewed this vehicle.
    registered_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

// Dashboard "expiring soon" / status filtering, within a project.
registeredVehicleSchema.index({ group_id: 1, valid_till: 1 }, { name: 'idx_group_valid_till' });

// Default dashboard listing: newest registration first, within a project.
registeredVehicleSchema.index({ group_id: 1, createdAt: -1 }, { name: 'idx_group_created_at' });

// The Intozi feed's keyset cursor walks (updatedAt, _id) within a project, every
// 5-10 seconds. Without this the poll is a collection scan plus an in-memory
// sort, which is the one query here that must never degrade.
registeredVehicleSchema.index(
  { group_id: 1, updatedAt: 1, _id: 1 },
  { name: 'idx_group_feed_cursor' }
);

module.exports = mongoose.model('RegisteredVehicle', registeredVehicleSchema);
