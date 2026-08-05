const mongoose = require('mongoose');

const { VEHICLE_CLASSES, VEHICLE_COLORS } = require('../utils/constants');

/**
 * One ANPR detection event delivered by a camera.
 *
 * Images are NOT stored in Mongo — only the on-disk paths written by
 * utils/imageStorage.js, keeping documents small and queries fast.
 */
const vehicleLogSchema = new mongoose.Schema(
  {
    // ---- Source application / device ----
    application_name: { type: String, required: true, trim: true },
    application_id: { type: Number, required: true },
    device_name: { type: String, required: true, trim: true },
    device_unique_key: { type: String, required: true, trim: true, index: true },
    group_id: { type: String, trim: true, default: null },

    // ---- Geo ----
    latitude: { type: String, trim: true, default: null },
    longitude: { type: String, trim: true, default: null },

    // ---- Event identity ----
    cam_id: { type: Number, required: true, index: true },
    transaction_id: { type: Number, required: true },

    // ---- Detection ----
    vehicle_number: { type: String, trim: true, uppercase: true, default: null },
    vehicle_class: { type: String, enum: [...VEHICLE_CLASSES, null], default: null },
    color: { type: String, enum: [...VEHICLE_COLORS, null], default: null },

    // ---- Violations ----
    triple_riding: { type: Boolean, default: false },
    no_helmet: { type: Boolean, default: false },
    no_seatbelt: { type: Boolean, default: false },
    driver_on_call_status: { type: Boolean, default: false },

    // ---- Stored image locations (relative to the project root) ----
    // null when the camera did not send that image — both are optional.
    event_image_path: { type: String, default: null },
    plate_image_path: { type: String, default: null },

    // ---- Timestamps ----
    created_datetime: { type: Date, required: true }, // as reported by the camera
    received_at: { type: Date, default: Date.now, required: true }, // as recorded by this API
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

// Idempotency: a camera retrying a delivery must never create a second record.
vehicleLogSchema.index({ transaction_id: 1 }, { unique: true, name: 'uniq_transaction_id' });

// Dashboard lookups: search by plate, newest first.
vehicleLogSchema.index({ vehicle_number: 1, created_datetime: -1 }, { name: 'idx_vehicle_number_created' });

// Time-range reports.
vehicleLogSchema.index({ created_datetime: -1 }, { name: 'idx_created_datetime' });

module.exports = mongoose.model('VehicleLog', vehicleLogSchema);
