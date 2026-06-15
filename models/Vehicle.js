const mongoose = require("mongoose");

/**
 * Vehicles registered by the dashboard user (whitelist / known vehicles).
 */
const vehicleSchema = new mongoose.Schema(
  {
    vehicle_number: {
      type: String,
      required: [true, "vehicle_number is required"],
      unique: true,
      trim: true,
      uppercase: true,
    },
    owner_name: { type: String, trim: true, default: "" },
    vehicle_class: { type: String, trim: true, default: "" }, // car, truck, bike...
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Vehicle", vehicleSchema);
