const mongoose = require("mongoose");

/**
 * Stores every event POSTed by the Intozi AI camera server.
 * Keeps the full raw payload plus a derived `event_type` (entry/exit/unknown)
 * resolved from the CameraConfig that matches the event's cam_id.
 */
const vehicleLogSchema = new mongoose.Schema(
  {
    // ---- Intozi payload fields ----
    application_name: { type: String },
    application_id: { type: Number },
    device_name: { type: String },
    device_unique_key: { type: String },
    group_id: { type: String },
    latitude: { type: String },
    longitude: { type: String },
    cam_id: { type: Number, index: true },

    // Unique per Intozi event — used to reject duplicate deliveries/retries.
    transaction_id: { type: Number },

    // Base64 (often data-URI) images. Can be large, hence the 20mb body limit.
    event_image: { type: String, default: "" },
    plate_image: { type: String, default: "" },

    vehicle_number: { type: String, trim: true, uppercase: true },
    vehicle_box: { type: [Number], default: [] }, // [x1, y1, x2, y2]
    vehicle_class: { type: String },

    // Original timestamp string Intozi generated for the event.
    created_datetime: { type: String },

    // ---- Derived / server-side fields ----
    event_type: {
      type: String,
      enum: ["entry", "exit", "unknown"],
      default: "unknown",
      index: true,
    },

    // Whether this plate matches a vehicle registered by the dashboard user.
    is_registered: { type: Boolean, default: false },
  },
  { timestamps: true } // adds createdAt / updatedAt
);

// Fast lookups for the dashboard list view (filter by plate, newest first).
vehicleLogSchema.index({ vehicle_number: 1, createdAt: -1 });

// Enforce idempotency of Intozi deliveries. Sparse so legacy/empty docs are allowed.
vehicleLogSchema.index({ transaction_id: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("VehicleLog", vehicleLogSchema);
