const express = require("express");
const router = express.Router();

const apiKey = require("../middleware/apiKey");
const VehicleLog = require("../models/VehicleLog");
const Vehicle = require("../models/Vehicle");
const CameraConfig = require("../models/CameraConfig");

/**
 * POST /api/intozi/event
 * Receives a vehicle detection event from the Intozi AI camera server.
 *
 * - Protected by x-api-key.
 * - Idempotent: duplicate transaction_id returns 200 with "Already received".
 * - Resolves event_type from CameraConfig (entry/exit/unknown).
 * - Flags whether the plate is a registered vehicle.
 * - ALWAYS returns 200 on success (Intozi retries on non-200).
 */
router.post("/event", apiKey, async (req, res) => {
  try {
    const payload = req.body || {};
    const { transaction_id, cam_id, vehicle_number } = payload;

    // --- Idempotency check ---
    if (transaction_id !== undefined && transaction_id !== null) {
      const existing = await VehicleLog.findOne({ transaction_id }).select("_id").lean();
      if (existing) {
        return res.status(200).json({
          success: true,
          message: "Already received",
          duplicate: true,
          id: existing._id,
        });
      }
    }

    // --- Resolve gate / event type from camera config ---
    let event_type = "unknown";
    if (cam_id !== undefined && cam_id !== null) {
      const cam = await CameraConfig.findOne({ cam_id }).select("gate_type").lean();
      if (cam && cam.gate_type) event_type = cam.gate_type;
    }

    // --- Check whether this plate is a registered vehicle ---
    let is_registered = false;
    if (vehicle_number) {
      const normalized = String(vehicle_number).trim().toUpperCase();
      const known = await Vehicle.findOne({ vehicle_number: normalized }).select("_id").lean();
      is_registered = Boolean(known);
    }

    // --- Persist the full payload ---
    const log = await VehicleLog.create({
      application_name: payload.application_name,
      application_id: payload.application_id, 
      device_name: payload.device_name,
      device_unique_key: payload.device_unique_key,
      group_id: payload.group_id,
      latitude: payload.latitude,
      longitude: payload.longitude,
      cam_id: payload.cam_id,
      transaction_id: payload.transaction_id,
      event_image: payload.event_image || "",
      plate_image: payload.plate_image || "",
      vehicle_number: payload.vehicle_number,
      vehicle_box: Array.isArray(payload.vehicle_box) ? payload.vehicle_box : [],
      vehicle_class: payload.vehicle_class,
      created_datetime: payload.created_datetime,
      event_type,
      is_registered,
    });

    return res.status(200).json({
      success: true,
      message: "Event received",
      id: log._id,
      event_type,
      is_registered,
    });
  } catch (err) {
    // Handle race condition on the unique transaction_id index gracefully.
    if (err && err.code === 11000) {
      return res.status(200).json({
        success: true,
        message: "Already received",
        duplicate: true,
      });
    }

    console.error("[intozi/event] error:", err);
    // Intozi retries on non-200; return 500 so it can retry on genuine failures.
    return res.status(500).json({ success: false, message: "Failed to process event" });
  }
});

module.exports = router;
