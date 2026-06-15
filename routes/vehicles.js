const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Vehicle = require("../models/Vehicle");

/**
 * GET /api/vehicles
 * List all registered vehicles (newest first).
 */
router.get("/", async (req, res) => {
  try {
    const vehicles = await Vehicle.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: vehicles });
  } catch (err) {
    console.error("[GET /api/vehicles] error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch vehicles" });
  }
});

/**
 * POST /api/vehicles
 * Add a vehicle: { vehicle_number, owner_name, vehicle_class, notes }
 */
router.post("/", async (req, res) => {
  try {
    const { vehicle_number, owner_name, vehicle_class, notes } = req.body || {};

    if (!vehicle_number || !String(vehicle_number).trim()) {
      return res.status(400).json({ success: false, message: "vehicle_number is required" });
    }

    const vehicle = await Vehicle.create({
      vehicle_number: String(vehicle_number).trim().toUpperCase(),
      owner_name: owner_name || "",
      vehicle_class: vehicle_class || "",
      notes: notes || "",
    });

    return res.status(201).json({ success: true, message: "Vehicle added", data: vehicle });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: "Vehicle already registered" });
    }
    if (err && err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error("[POST /api/vehicles] error:", err);
    return res.status(500).json({ success: false, message: "Failed to add vehicle" });
  }
});

/**
 * DELETE /api/vehicles/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid vehicle id" });
    }

    const deleted = await Vehicle.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Vehicle not found" });
    }

    return res.json({ success: true, message: "Vehicle deleted", id: req.params.id });
  } catch (err) {
    console.error("[DELETE /api/vehicles/:id] error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete vehicle" });
  }
});

module.exports = router;
