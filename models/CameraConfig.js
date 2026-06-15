const mongoose = require("mongoose");

/**
 * Maps an Intozi cam_id to a logical gate ("entry" or "exit").
 * Used by the Intozi receiver to tag each event with an event_type.
 */
const cameraConfigSchema = new mongoose.Schema(
  {
    cam_id: {
      type: Number,
      required: [true, "cam_id is required"],
      unique: true,
      index: true,
    },
    device_name: { type: String, trim: true, default: "" },
    gate_type: {
      type: String,
      enum: ["entry", "exit"],
      required: [true, "gate_type must be 'entry' or 'exit'"],
    },
    location: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CameraConfig", cameraConfigSchema);
