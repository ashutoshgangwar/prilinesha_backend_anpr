const mongoose = require('mongoose');

/**
 * Opaque keyset cursor for the Intozi polling feed.
 *
 * A cursor pins an exact position in the (received_at, _id) ordering, so a
 * poller that resumes from it sees every newer record exactly once — unlike an
 * offset, which shifts as rows are inserted between two polls.
 *
 * Wire format: base64url("<received_at ISO>|<_id hex>").
 */

/**
 * @param {{ received_at: Date, _id: any }} record
 * @returns {string} Cursor to hand back to the client.
 */
const encodeCursor = ({ received_at: receivedAt, _id: id }) =>
  Buffer.from(`${new Date(receivedAt).toISOString()}|${String(id)}`, 'utf8').toString('base64url');

/**
 * @param {string} cursor Value previously produced by encodeCursor.
 * @returns {{ receivedAt: Date, id: mongoose.Types.ObjectId } | null} null when malformed.
 */
const decodeCursor = (cursor) => {
  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');

    if (!timestamp || !id || !mongoose.Types.ObjectId.isValid(id)) return null;

    const receivedAt = new Date(timestamp);
    if (Number.isNaN(receivedAt.getTime())) return null;

    return { receivedAt, id: new mongoose.Types.ObjectId(id) };
  } catch {
    return null;
  }
};

module.exports = { encodeCursor, decodeCursor };
