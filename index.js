require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const intoziRoutes = require("./routes/intozi");
const logsRoutes = require("./routes/logs");
const vehiclesRoutes = require("./routes/vehicles");
const camerasRoutes = require("./routes/cameras");

const app = express();

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/vehicle_lpr";

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: "20mb" })); // base64 images can be large
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// --- Health check ---
app.get("/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status: "ok",
    uptime: process.uptime(),
    db: states[mongoose.connection.readyState] || "unknown",
    timestamp: new Date().toISOString(),
  });
});

// --- Routes ---
app.use("/api/intozi", intoziRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/vehicles", vehiclesRoutes);
app.use("/api/cameras", camerasRoutes);

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// --- Centralized error handler (catches body-parser errors, etc.) ---
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Payload too large" });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }
  console.error("[unhandled error]:", err);
  return res.status(500).json({ success: false, message: "Internal server error" });
});

// --- Start ---
async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected");

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("\n👋 MongoDB connection closed. Exiting.");
  process.exit(0);
});

start();
