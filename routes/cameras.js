const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const CameraConfig = require("../models/CameraConfig");

/**
 * GET /api/cameras
 * List all camera configs.
 */
router.get("/", async (req, res) => {
  try {
    const cameras = await CameraConfig.find().sort({ cam_id: 1 }).lean();
    return res.json({ success: true, data: cameras });
  } catch (err) {
    console.error("[GET /api/cameras] error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch cameras" });
  }
});

/**
 * POST /api/cameras
 * Upsert a camera config: { cam_id, device_name, gate_type: "entry"|"exit", location }
 */
router.post("/", async (req, res) => {
  try {
    const { cam_id, device_name, gate_type, location } = req.body || {};

    if (cam_id === undefined || cam_id === null || isNaN(Number(cam_id))) {
      return res.status(400).json({ success: false, message: "cam_id (number) is required" });
    }
    if (!["entry", "exit"].includes(gate_type)) {
      return res
        .status(400)
        .json({ success: false, message: "gate_type must be 'entry' or 'exit'" });
    }

    const camera = await CameraConfig.findOneAndUpdate(
      { cam_id: Number(cam_id) },
      {
        $set: {
          cam_id: Number(cam_id),
          device_name: device_name || "",
          gate_type,
          location: location || "",
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    return res.status(200).json({ success: true, message: "Camera saved", data: camera });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: "Camera already exists" });
    }
    if (err && err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error("[POST /api/cameras] error:", err);
    return res.status(500).json({ success: false, message: "Failed to save camera" });
  }
});

/**
 * DELETE /api/cameras/:id
 * Removes a camera config by Mongo _id.
 */
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid camera id" });
    }

    const deleted = await CameraConfig.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Camera not found" });
    }

    return res.json({ success: true, message: "Camera deleted", id: req.params.id });
  } catch (err) {
    console.error("[DELETE /api/cameras/:id] error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete camera" });
  }
});

module.exports = router;
