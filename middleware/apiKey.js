/**
 * Validates the `x-api-key` header against INTOZI_API_KEY from the environment.
 * Protects the Intozi receiver endpoint.
 */
module.exports = function apiKey(req, res, next) {
  const expected = process.env.INTOZI_API_KEY;

  if (!expected) {
    // Misconfiguration — fail closed rather than accepting unauthenticated events.
    console.error("[apiKey] INTOZI_API_KEY is not set in environment");
    return res.status(500).json({ success: false, message: "Server API key not configured" });
  }

  const provided = req.header("x-api-key");

  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Invalid or missing x-api-key" });
  }

  next();
};
