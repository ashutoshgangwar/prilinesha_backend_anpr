const mongoose = require('mongoose');

/**
 * A vehicle registered from the internal dashboard.
 *
 * This collection is the authority on the registered/unregistered status that
 * `GET /api/anpr/feed` reports to Intozi: a plate found here and still inside
 * its `valid_till` window is registered — anything else is unregistered.
 * Expiry is therefore implicit, not a flag someone has to flip: the moment
 * `valid_till` passes, every later detection is reported as unregistered.
 */
const registeredVehicleSchema = new mongoose.Schema(
  {
    // The join key against VehicleLog.vehicle_number — same normalisation
    // (trimmed, uppercase) so a lookup can never miss on casing alone.
    vehicle_number: { type: String, required: true, trim: true, uppercase: true },

    name: { type: String, required: true, trim: true },
    phone_number: { type: String, required: true, trim: true },

    // Inclusive: a date sent without a time is stored as 23:59:59.999 UTC of
    // that day, so "valid till the 31st" means the whole 31st.
    valid_till: { type: Date, required: true },
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

// One record per plate — re-adding a vehicle renews it instead of duplicating.
registeredVehicleSchema.index({ vehicle_number: 1 }, { unique: true, name: 'uniq_vehicle_number' });

// Dashboard "expiring soon" / status filtering.
registeredVehicleSchema.index({ valid_till: 1 }, { name: 'idx_valid_till' });

// Default dashboard listing: newest registration first.
registeredVehicleSchema.index({ createdAt: -1 }, { name: 'idx_created_at' });

module.exports = mongoose.model('RegisteredVehicle', registeredVehicleSchema);
