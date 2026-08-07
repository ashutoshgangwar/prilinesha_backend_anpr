const mongoose = require('mongoose');

const {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  DEFAULT_VEHICLE_TYPE,
} = require('../utils/constants');

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

    // The tenant boundary: which project (Project.group_id) this event belongs
    // to. Uppercased to match Project.group_id and RegisteredVehicle.group_id.
    // Null only for events ingested with the legacy global API key.
    group_id: { type: String, trim: true, uppercase: true, default: null },

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

    // Registration status. Defaults to "unregistered": a vehicle counts as
    // registered only when the camera positively says so.
    vehicle_type: { type: String, enum: VEHICLE_TYPES, default: DEFAULT_VEHICLE_TYPE, index: true },
    vehicle_model: { type: String, trim: true, default: null },

    // ---- Owner / driver details ----
    // Stored when supplied, but never exposed on the Intozi feed — which reads
    // the registry, not this collection, and returns only the three fields in
    // FEED_DISCLOSED_FIELDS (utils/constants.js).
    owner_name: { type: String, trim: true, default: null },
    contact_no: { type: String, trim: true, default: null },
    email: { type: String, trim: true, lowercase: true, default: null },
    driver_name: { type: String, trim: true, default: null },

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
// Scoped to the project because transaction_id is only unique within the Intozi
// deployment that generated it — two customers can legitimately both send 4471.
vehicleLogSchema.index(
  { group_id: 1, transaction_id: 1 },
  { unique: true, name: 'uniq_group_transaction_id' }
);

// Dashboard lookups: search by plate within a project, newest first.
vehicleLogSchema.index(
  { group_id: 1, vehicle_number: 1, created_datetime: -1 },
  { name: 'idx_group_vehicle_number_created' }
);

// The dashboard's log table: one project's detections, newest first. Without
// group_id leading, a customer admin's default listing sorts the whole
// collection and then filters, which is the query that degrades first as
// events accumulate.
vehicleLogSchema.index(
  { group_id: 1, created_datetime: -1 },
  { name: 'idx_group_created_datetime' }
);

// Time-range reports, and the super admin's unscoped view of the same table.
vehicleLogSchema.index({ created_datetime: -1 }, { name: 'idx_created_datetime' });

// Intozi polling feed: keyset pagination over (received_at, _id) ascending,
// with group_id leading so each project pages through its own events only.
// The _id tiebreaker makes the cursor exact when several events land in the
// same millisecond, so a poll can neither skip nor repeat a record.
vehicleLogSchema.index({ group_id: 1, received_at: 1, _id: 1 }, { name: 'idx_group_feed_cursor' });

// Same cursor walk for an unscoped (global-key) read across every project.
vehicleLogSchema.index({ received_at: 1, _id: 1 }, { name: 'idx_feed_cursor' });

module.exports = mongoose.model('VehicleLog', vehicleLogSchema);
