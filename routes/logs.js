const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const VehicleLog = require("../models/VehicleLog");

/**
 * GET /api/logs
 * Paginated list of events. Excludes heavy base64 image fields.
 *
 * Query params:
 *   - page (default 1)
 *   - limit (default 20, max 100)
 *   - vehicle_number (partial, case-insensitive)
 *   - event_type (entry | exit | unknown)
 *   - from, to (ISO date strings, filtered on createdAt)
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.vehicle_number) {
      // Escape regex special chars from user input.
      const safe = String(req.query.vehicle_number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.vehicle_number = { $regex: safe, $options: "i" };
    }

    if (req.query.event_type) {
      filter.event_type = req.query.event_type;
    }

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) {
        const fromDate = new Date(req.query.from);
        if (!isNaN(fromDate.getTime())) filter.createdAt.$gte = fromDate;
      }
      if (req.query.to) {
        const toDate = new Date(req.query.to);
        if (!isNaN(toDate.getTime())) filter.createdAt.$lte = toDate;
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }

    const [items, total] = await Promise.all([
      VehicleLog.find(filter)
        .select("-event_image -plate_image") // exclude heavy fields from list view
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VehicleLog.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (err) {
    console.error("[GET /api/logs] error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch logs" });
  }
});

/**
 * GET /api/logs/:id
 * Single log with the full document, including base64 images.
 */
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid log id" });
    }

    const log = await VehicleLog.findById(req.params.id).lean();
    if (!log) {
      return res.status(404).json({ success: false, message: "Log not found" });
    }

    return res.json({ success: true, data: log });
  } catch (err) {
    console.error("[GET /api/logs/:id] error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch log" });
  }
});

/**
 * DELETE /api/logs/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid log id" });
    }

    const deleted = await VehicleLog.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Log not found" });
    }

    return res.json({ success: true, message: "Log deleted", id: req.params.id });
  } catch (err) {
    console.error("[DELETE /api/logs/:id] error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete log" });
  }
});

module.exports = router;
