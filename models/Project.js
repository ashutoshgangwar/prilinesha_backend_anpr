const mongoose = require('mongoose');

const { PROJECT_TYPES } = require('../utils/constants');

/**
 * A device (camera / gate) belonging to a project.
 *
 * `device_name` is what Intozi sends on every event — "entry1", "exit1",
 * "exit2" and so on. The pair (group_id, device_name) is what identifies a
 * physical gate in this system; the name only has to be unique inside its own
 * project, so two customers can both have an "entry1".
 */
const deviceSchema = new mongoose.Schema(
  {
    // Spaces are allowed: the name is stored exactly as the camera reports it
    // ("Netru Pro Exit"), not normalised into an identifier.
    device_name: { type: String, required: true, trim: true },

    // Free-text label for the dashboard ("Main gate — north side").
    label: { type: String, trim: true, default: null },

    // Which way traffic flows through this gate. Nothing enforces it today; it
    // is what an in/out report will group by.
    direction: { type: String, enum: ['entry', 'exit', 'both', null], default: null },

    // True when the device was added by an incoming event rather than by a
    // human. Surfaces "a camera we never configured is posting to us" in the
    // dashboard without dropping the event that revealed it.
    auto_registered: { type: Boolean, default: false },

    // Set by the ingestion path, so the dashboard can show a camera as offline.
    last_seen_at: { type: Date, default: null },

    is_active: { type: Boolean, default: true },
  },
  { _id: true, timestamps: false, versionKey: false }
);

/**
 * A customer project — the tenant boundary of the whole system.
 *
 * `group_id` is the value Intozi puts on every posted event, and it is the key
 * everything else hangs off: devices belong to a project, registered vehicles
 * belong to a project, and a dashboard user only ever sees the projects listed
 * on their own record. Nothing in this codebase reads data without a group_id
 * scope except a super admin explicitly asking for all of them.
 */
const projectSchema = new mongoose.Schema(
  {
    // Uppercased so "acme_mall" and "ACME_MALL" can never become two tenants.
    group_id: { type: String, required: true, trim: true, uppercase: true },

    // A mirror of `group_id`: a project has one name and that is it. The field
    // survives because documents written before the two were unified carry a
    // distinct name, and readers (the project switcher, for one) still ask for it.
    project_name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: null },

    // Where the site physically is. Required by the create API, but deliberately
    // not `required` here: projects created before this field existed must still
    // save when the ingestion path touches their device list.
    address: { type: String, trim: true, default: null },

    // Parking lot or residential society. Same reasoning as `address` for why
    // the enum tolerates null rather than being required.
    project_type: { type: String, enum: [...PROJECT_TYPES, null], default: null },

    // Customer-facing contact, for the internal project list.
    customer_name: { type: String, trim: true, default: null },
    contact_email: { type: String, trim: true, lowercase: true, default: null },
    contact_phone: { type: String, trim: true, default: null },

    devices: { type: [deviceSchema], default: [] },

    // ---- Intozi credentials ----
    // Only the SHA-256 of the key is stored: a database dump does not hand an
    // attacker a working camera credential. The plaintext is shown exactly once,
    // when the project is created or its key is rotated.
    api_key_hash: { type: String, required: true, select: false },
    // Last 4 characters of the plaintext, so the dashboard can say which key is
    // installed on site without being able to reproduce it.
    api_key_last4: { type: String, default: null },
    api_key_rotated_at: { type: Date, default: null },

    // A deactivated project rejects both camera posts and dashboard reads —
    // the switch to pull for a customer who has not paid, without deleting data.
    is_active: { type: Boolean, default: true },

    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.api_key_hash;
        return ret;
      },
    },
  }
);

// One project per group_id — this is the identity Intozi is told to send.
projectSchema.index({ group_id: 1 }, { unique: true, name: 'uniq_group_id' });

// Authenticating a camera is a hash lookup on every ingest, so it must be
// indexed. Sparse because the field is `select: false`, never absent in practice.
projectSchema.index({ api_key_hash: 1 }, { name: 'idx_api_key_hash' });

// Default listing: newest project first.
projectSchema.index({ createdAt: -1 }, { name: 'idx_project_created_at' });

/**
 * Finds a device by name within this project, case-insensitively — cameras are
 * not consistent about "Entry1" vs "entry1".
 *
 * @param {string} deviceName
 * @returns {object|undefined}
 */
projectSchema.methods.findDevice = function findDevice(deviceName) {
  if (!deviceName) return undefined;
  const needle = String(deviceName).trim().toLowerCase();
  return this.devices.find((device) => device.device_name.toLowerCase() === needle);
};

module.exports = mongoose.model('Project', projectSchema);
