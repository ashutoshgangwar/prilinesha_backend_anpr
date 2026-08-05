# Prilinesha ANPR Ingestion API

Production-ready Express + MongoDB backend that receives ANPR (Automatic Number Plate Recognition)
detection events from cameras, stores the base64 event/plate images on disk and persists the event
metadata in MongoDB.

---

## Features

| Area | Implementation |
| --- | --- |
| Architecture | Clean layering — route → middleware → validator → controller → service → model/storage |
| Auth | Shared API key in the `Authorization` header, compared in constant time |
| Validation | `express-validator` rules with typed coercion and per-field error messages |
| Images | Optional base64 decode, magic-byte check, size cap, unique filenames, rollback on failure |
| Idempotency | Unique index on `transaction_id`; replays return `409` |
| Errors | Centralized handler with a single response envelope (`400/401/404/409/413/429/500`) |
| Logging | Winston, daily-rotated files + console, request ids, base64 payloads redacted |
| Security | Helmet, CORS, per-IP rate limiting, 15 MB body cap, NoSQL-operator sanitizing |
| Ops | Env validation at boot, Mongo connect retry with backoff, graceful shutdown, health + readiness probes |
| Docs | Swagger UI at `/api-docs`, Postman collection in [postman/](postman/) |

---

## Requirements

- Node.js **20 LTS** or newer
- MongoDB 6+ (local or Atlas)

---

## Setup

```bash
git clone <repo-url>
cd prilinesha_backend_anpr

npm install

cp .env.example .env
# then edit .env — MONGO_URI and API_KEY are required

# generate a strong API key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run dev     # nodemon, development
npm start       # production
```

The server refuses to boot with an invalid `.env` and prints exactly which variables are wrong.

On startup it creates `uploads/event-images/`, `uploads/plate-images/` and `logs/`, connects to
MongoDB (retrying with exponential backoff) and synchronises the indexes.

---

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `PORT` | no | `5050` | HTTP port |
| `MONGO_URI` | **yes** | — | MongoDB connection string |
| `MONGO_MAX_RETRIES` | no | `10` | Connection attempts before aborting boot |
| `MONGO_RETRY_DELAY_MS` | no | `3000` | Base backoff delay (doubles, capped at 30 s) |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | no | `10000` | Driver server-selection timeout |
| `API_KEY` | **yes** | — | Secret cameras send in `Authorization` |
| `UPLOAD_DIR` | no | `./uploads` | Root directory for stored images |
| `UPLOAD_PUBLIC_PATH` | no | `/uploads` | URL prefix images are served under |
| `SERVE_UPLOADS` | no | `true` | Serve `UPLOAD_DIR` statically |
| `MAX_IMAGE_BYTES` | no | `10485760` | Max decoded size per image (10 MB) |
| `JSON_BODY_LIMIT` | no | `15mb` | Max request body size |
| `CORS_ORIGIN` | no | `*` | `*` or a comma-separated origin list |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | no | `300` | Requests per window per IP |
| `REQUEST_TIMEOUT_MS` | no | `30000` | Socket timeout |
| `SHUTDOWN_TIMEOUT_MS` | no | `10000` | Grace period before a forced exit |
| `TRUST_PROXY` | no | `false` | `false`, `true`, a hop count, or trusted IPs |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `http` \| `debug` |
| `LOG_DIR` | no | `./logs` | Log output directory |
| `SWAGGER_ENABLED` | no | `true` | Serve `/api-docs` |

---

## API

### `POST /api/anpr`

Ingests one detection event.

**Headers**

```
Content-Type: application/json
Authorization: <API_KEY>          # "Bearer <API_KEY>" and "x-api-key" also accepted
```

**Body**

```json
{
  "application_name": "ANPR",
  "application_id": 1,
  "device_name": "Intozi Camera 1",
  "device_unique_key": "de21ba00-c4e2-474c-9106-b3bcc50e735f",
  "group_id": "Gate-A",
  "latitude": "12",
  "longitude": "14",
  "cam_id": 3,
  "transaction_id": 108,
  "color": "White",
  "event_image": "base64...",
  "vehicle_number": "UP32AB1234",
  "triple_riding": false,
  "vehicle_class": "car",
  "no_helmet": false,
  "plate_image": "base64...",
  "no_seatbelt": false,
  "driver_on_call_status": false,
  "created_datetime": "2025-12-22T12:33:01.744613"
}
```

**Field rules**

| Field | Required | Rule |
| --- | --- | --- |
| `application_name` | yes | string, ≤ 100 chars |
| `application_id` | yes | integer ≥ 0 |
| `device_name` | yes | string, ≤ 150 chars |
| `device_unique_key` | yes | UUID |
| `cam_id` | yes | integer ≥ 0 |
| `transaction_id` | yes | integer ≥ 0, unique across all events |
| `created_datetime` | yes | ISO 8601; **no offset is read as UTC** |
| `event_image` | no | base64 JPG/PNG (data-URI prefix optional); omitted → `event_image_path: null` |
| `plate_image` | no | base64 JPG/PNG (data-URI prefix optional); omitted → `plate_image_path: null` |
| `group_id` | no | string, ≤ 100 chars |
| `latitude` / `longitude` | no | numeric string within ±90 / ±180 |
| `vehicle_number` | no | 3–20 chars, `A-Z 0-9 -`, stored uppercase |
| `vehicle_class` | no | `bus` \| `car` \| `bike` \| `truck` \| `auto` |
| `color` | no | `White` \| `Gray` \| `Yellow` \| `Red` \| `Green` \| `Blue` \| `Black` |
| `triple_riding`, `no_helmet`, `no_seatbelt`, `driver_on_call_status` | no | boolean, default `false` |

**200 OK**

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6789ab01c2d3e4f567890123",
    "transaction_id": 108,
    "event_image_path": "uploads/event-images/event_108_20251222T123301844Z_9f3c1a20.jpg",
    "plate_image_path": "uploads/plate-images/plate_108_20251222T123301851Z_1b7de904.jpg"
  },
  "requestId": "0f5b1f8e-1f34-4c0e-9f0e-1d5c6f2a91cd"
}
```

**Error envelope** (identical for every failure)

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed.",
  "errors": [{ "field": "device_unique_key", "message": "device_unique_key must be a valid UUID." }],
  "requestId": "0f5b1f8e-1f34-4c0e-9f0e-1d5c6f2a91cd"
}
```

| Status | When |
| --- | --- |
| `400` | Validation failed, malformed JSON, or undecodable/non-image base64 |
| `401` | Missing or invalid API key |
| `404` | Unknown route |
| `409` | `transaction_id` already ingested |
| `413` | Body exceeds `JSON_BODY_LIMIT` |
| `429` | Rate limit exceeded |
| `500` | Unexpected server error |

### `GET /health`

```json
{ "status": "UP" }
```

### `GET /health/ready`

Returns `503` while MongoDB is unavailable — wire this to your load balancer.

```json
{ "status": "UP", "database": "connected", "uptimeSeconds": 128, "timestamp": "2025-12-22T12:33:01.744Z" }
```

### Docs

- Swagger UI: `http://localhost:5050/api-docs`
- OpenAPI JSON: `http://localhost:5050/api-docs.json`
- Postman: import [postman/ANPR-API.postman_collection.json](postman/ANPR-API.postman_collection.json),
  then set the `base_url` and `api_key` collection variables.

---

## Quick test

```bash
curl -X POST http://localhost:5050/api/anpr \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d '{
    "application_name":"ANPR","application_id":1,
    "device_name":"Intozi Camera 1",
    "device_unique_key":"de21ba00-c4e2-474c-9106-b3bcc50e735f",
    "cam_id":3,"transaction_id":108,
    "event_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "plate_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "created_datetime":"2025-12-22T12:33:01.744613"
  }'
```

---

## Project structure

```
.
├── app.js                      # Express wiring (no side effects — importable by tests)
├── server.js                   # Boot: storage → Mongo (retry) → indexes → listen → graceful shutdown
├── config/
│   ├── env.js                  # Environment validation & coercion (fails fast)
│   └── database.js             # Mongo connect/disconnect, retry, connection state
├── routes/
│   ├── anpr.js                 # POST /api/anpr
│   └── health.js               # GET /health, /health/ready
├── controllers/
│   └── anprController.js       # Thin HTTP adapter
├── services/
│   └── anprService.js          # Duplicate check → store images → insert → rollback
├── validators/
│   └── anprValidator.js        # express-validator rules
├── middleware/
│   ├── apiKeyAuth.js           # Constant-time API key check
│   ├── errorHandler.js         # 404 + centralized error handler
│   ├── rateLimiter.js
│   ├── requestContext.js       # Request id, response time, request logging
│   ├── sanitize.js             # Strips $-operators / dotted keys
│   └── validate.js             # Runs rules → 400 with field errors
├── models/
│   └── VehicleLog.js           # Mongoose schema + indexes
├── utils/
│   ├── AppError.js             # Operational error with status code
│   ├── asyncHandler.js
│   ├── constants.js            # Allowed vehicle classes / colors
│   ├── imageStorage.js         # Base64 decode, write, rollback
│   └── logger.js               # Winston (rotating files + console, redaction)
├── docs/swagger.js             # OpenAPI 3.0 spec
├── postman/                    # Postman collection
├── uploads/
│   ├── event-images/
│   └── plate-images/
└── logs/
```

---

## Data model

`VehicleLog` stores only the on-disk **paths** to the images, never the base64 payload.

| Index | Purpose |
| --- | --- |
| `transaction_id` (unique) | Idempotency — a retried delivery cannot duplicate a record |
| `vehicle_number + created_datetime` | Plate search, newest first |
| `created_datetime` | Time-range reports |

`created_datetime` is the camera's timestamp; `received_at` is when this API accepted it.

---

## Operational notes

- **Duplicates** are detected before any image is written, so a replay costs one indexed lookup.
- **Rollback**: if the second image or the Mongo insert fails, files already written are deleted —
  no orphans on disk.
- **Naive timestamps** (`2025-12-22T12:33:01.744613`, no offset) are interpreted as UTC so stored
  instants do not depend on the server's timezone.
- **Logs** rotate daily (14 days for `app-*`, 30 for `error-*`) and redact `event_image`,
  `plate_image` and any authorization header.
- **Graceful shutdown** on `SIGINT`/`SIGTERM`: stop accepting connections, drain in-flight requests,
  close MongoDB, then exit — force-exits after `SHUTDOWN_TIMEOUT_MS`.
- **Behind a proxy** set `TRUST_PROXY=1` (or the trusted subnet) so rate limiting sees real client IPs.
- **Backups**: `uploads/` holds the only copy of each image; include it in your backup routine.
