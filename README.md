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
| Intozi feed | `GET /api/anpr/feed`, polled every 5–10 s; keyset cursor delivers each event exactly once |
| Vehicle registry | Dashboard adds a vehicle with a `valid_till`; expiry flips detections to `unregistered` with no cron job |
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

## How the three surfaces fit together

```
 Internal dashboard              This API                        Intozi server
 ─────────────────────           ─────────────────────           ─────────────────────
 POST /api/vehicles  ─────────►  RegisteredVehicle
 (name, phone, plate,            (plate → valid_till)
  valid_till)                            │
                                         │ looked up at detection time
 GET  /api/vehicles  ◄────────           ▼
 (table + status)                VehicleLog.vehicle_type
                                         │
       Intozi camera ──────────►         │
       POST /api/anpr                    ▼
                                 GET /api/anpr/feed  ─────────►  polls every 5–10 s
                                 (plate + registered?)
```

A plate is **registered** only while a dashboard registration covers it. The moment `valid_till`
passes, the next detection is reported to Intozi as **unregistered** — nothing has to expire it.

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
  "vehicle_type": "registered",
  "vehicle_model": "Swift VXI",
  "owner_name": "Ramesh Kumar",
  "contact_no": "+91 9876543210",
  "email": "owner@example.com",
  "driver_name": "Suresh Yadav",
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
| `vehicle_type` | no | `registered` \| `unregistered`. **Ignored when the plate is on the registry** — see below. |
| `vehicle_model` | no | string, ≤ 100 chars |
| `owner_name` | no | string, ≤ 150 chars |
| `driver_name` | no | string, ≤ 150 chars |
| `contact_no` | no | 6–20 digits, optional `+` prefix, spaces/hyphens allowed |
| `email` | no | valid email, ≤ 254 chars, stored lowercase |
| `triple_riding`, `no_helmet`, `no_seatbelt`, `driver_on_call_status` | no | boolean, default `false` |

**How `vehicle_type` is decided** — the camera does not get the last word:

| Plate on the registry? | Result |
| --- | --- |
| Yes, `valid_till` not passed at `created_datetime` | `registered` |
| Yes, but expired | `unregistered` — even if the payload says `"vehicle_type": "registered"` |
| No | Falls back to the payload's `vehicle_type`, else `unregistered` |

Status is judged at **detection time**, not at read time, so the stored event stays an honest record
of what the vehicle was when it was seen — a registration expiring tomorrow cannot rewrite today's
detections.

**200 OK**

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6789ab01c2d3e4f567890123",
    "transaction_id": 108,
    "vehicle_number": "UP32AB1234",
    "vehicle_type": "registered",
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

### `GET /api/anpr/feed`

The endpoint the **Intozi server polls every 5–10 seconds**. It reports the vehicle number and
whether the vehicle is registered; every other field is returned as `null` **by contract** — the
database may well hold owner name, contact number, email, driver name, model and creation time, but
this feed never discloses them.

**Headers**

```
Authorization: <API_KEY>
```

**Query parameters**

| Param | Default | Rule |
| --- | --- | --- |
| `cursor` | – | The `next_cursor` from the previous response. Omit on the first call. |
| `since` | – | ISO 8601; alternative cold start. Ignored when `cursor` is sent. |
| `limit` | `100` | Integer 1–1000 |
| `vehicle_type` | – | `registered` \| `unregistered` — optional filter |

**200 OK**

```json
{
  "success": true,
  "message": "Vehicle feed fetched successfully.",
  "count": 1,
  "next_cursor": "MjAyNi0wOC0wNVQxNTo1MjozMi4yNDhafDZhNzM1YzQwYTczYjNhZTMzY2MwODI5ZA",
  "has_more": false,
  "data": [
    {
      "owner_name": null,
      "created_datetime": null,
      "contact_no": null,
      "email": null,
      "driver_name": null,
      "vehicle_model": null,
      "vehicle_type": "registered",
      "vehicle_number": "HR26DK8337"
    }
  ],
  "requestId": "1f5f6c11-d4f0-4a9f-aa80-a8e3dd5227bc"
}
```

**How Intozi should poll it**

1. First call with no parameters → the newest `limit` events, oldest-first, plus a `next_cursor`.
2. Every later call sends that cursor back: `GET /api/anpr/feed?cursor=<next_cursor>`.
   Only events ingested since are returned — **exactly once, never skipped, never repeated**, no
   matter how many arrived between two polls.
3. Store the `next_cursor` from every response, including empty ones (`count: 0` echoes the cursor
   back, so nothing is lost if the poller restarts mid-loop).
4. While `has_more` is `true` the client is behind — poll again immediately instead of sleeping
   for the interval.

Paging is keyset-based on `(received_at, _id)`, not an offset, which is what makes the guarantee in
step 2 hold under concurrent ingestion.

| Status | When |
| --- | --- |
| `200` | Page returned (an empty `data` array just means nothing new) |
| `400` | Malformed `cursor`, `since`, `limit` or `vehicle_type` |
| `401` | Missing or invalid API key |
| `429` | Rate limit exceeded — see `RATE_LIMIT_MAX` |

> A 5-second interval is 12 requests/minute per poller, well inside the default limit of 300/minute.

### `POST /api/vehicles`

Internal dashboard: register a vehicle, or renew one that is already on the registry.

```bash
curl -X POST http://localhost:5050/api/vehicles \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d '{
    "vehicle_number": "MH12AB1234",
    "name": "Ramesh Kumar",
    "phone_number": "+91 9876543210",
    "valid_till": "2027-03-31"
  }'
```

**Field rules**

| Field | Required | Rule |
| --- | --- | --- |
| `vehicle_number` | yes | 3–20 chars, `A-Z 0-9 -`, stored uppercase — unique |
| `name` | yes | string, ≤ 150 chars |
| `phone_number` | yes | 6–20 characters of digits, optional `+`, spaces/hyphens allowed |
| `valid_till` | yes | `YYYY-MM-DD` or ISO 8601 datetime; a plain date covers the **whole** day |

**201 Created** (a new plate) / **200 OK** (an existing plate was renewed — `created: false`)

```json
{
  "success": true,
  "message": "Vehicle registered successfully.",
  "created": true,
  "data": {
    "id": "6a7378aa86d8e0aa080d4f95",
    "vehicle_number": "MH12AB1234",
    "name": "Ramesh Kumar",
    "phone_number": "+91 9876543210",
    "valid_till": "2027-03-31T23:59:59.999Z",
    "status": "registered",
    "days_remaining": 239,
    "created_at": "2026-08-05T17:53:46.014Z",
    "updated_at": "2026-08-05T17:53:46.014Z"
  },
  "requestId": "999e9050-8b0f-4096-9e34-93384819a14f"
}
```

A plate is unique, so **re-posting one renews it** rather than failing — that is how an expired
vehicle is brought back, and it keeps exactly one row per plate. `created` tells the dashboard which
happened. Posting a `valid_till` that is already in the past is allowed; it simply stores a vehicle
whose `status` is `unregistered`.

### `GET /api/vehicles`

The dashboard table. Offset paging with a row count (unlike the Intozi feed's cursor, a table needs
page numbers).

```bash
curl -H "Authorization: $API_KEY" \
  "http://localhost:5050/api/vehicles?search=MH12&status=registered&page=1&limit=25"
```

| Param | Default | Rule |
| --- | --- | --- |
| `search` | – | Partial, case-insensitive match on vehicle number, name **or** phone |
| `status` | – | `registered` (inside `valid_till`) \| `unregistered` (expired) |
| `page` | `1` | Integer ≥ 1 |
| `limit` | `25` | Integer 1–200 |

```json
{
  "success": true,
  "message": "Vehicles fetched successfully.",
  "count": 2,
  "pagination": { "page": 1, "limit": 25, "total": 2, "total_pages": 1, "has_next": false, "has_previous": false },
  "data": [
    {
      "id": "6a7378aa86d8e0aa080d4f96",
      "vehicle_number": "DL01XY9999",
      "name": "Anita Sharma",
      "phone_number": "9812345678",
      "valid_till": "2026-01-31T23:59:59.999Z",
      "status": "unregistered",
      "days_remaining": -185,
      "created_at": "2026-08-05T17:53:46.225Z",
      "updated_at": "2026-08-05T17:53:46.225Z"
    }
  ],
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

`status` and `days_remaining` are **computed from `valid_till` on every read** — never stored. A row
cannot drift out of sync with reality, and nothing needs a scheduled job to expire it.
`days_remaining` goes negative once lapsed, so the UI can render "expired 185 days ago" directly.

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

Register a vehicle from the dashboard side first — it is what makes the detection below come back
as `registered`:

```bash
curl -X POST http://localhost:5050/api/vehicles \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d '{"vehicle_number":"UP32AB1234","name":"Ramesh Kumar","phone_number":"+91 9876543210","valid_till":"2027-03-31"}'
```

Then send a detection:

```bash
curl -X POST http://localhost:5050/api/anpr \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d '{
    "application_name":"ANPR","application_id":1,
    "device_name":"Intozi Camera 1",
    "device_unique_key":"de21ba00-c4e2-474c-9106-b3bcc50e735f",
    "cam_id":3,"transaction_id":108,
    "vehicle_number":"UP32AB1234",
    "event_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "plate_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "created_datetime":"2025-12-22T12:33:01.744613"
  }'
```

Then read it back off the Intozi feed — first the newest page, then only what is new:

```bash
# 1. cold start
curl -s -H "Authorization: $API_KEY" "http://localhost:5050/api/anpr/feed?limit=5"

# 2. every later poll — reuse the next_cursor from the previous response
curl -s -H "Authorization: $API_KEY" "http://localhost:5050/api/anpr/feed?cursor=<next_cursor>"
```

A minimal poller:

```bash
CURSOR=""
while true; do
  BODY=$(curl -s -H "Authorization: $API_KEY" "http://localhost:5050/api/anpr/feed?cursor=$CURSOR")
  echo "$BODY" | jq -c '.data[]'
  CURSOR=$(echo "$BODY" | jq -r '.next_cursor // empty')
  sleep 5
done
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
│   ├── anpr.js                 # POST /api/anpr, GET /api/anpr/feed
│   ├── vehicles.js             # POST /api/vehicles, GET /api/vehicles (dashboard)
│   └── health.js               # GET /health, /health/ready
├── controllers/
│   ├── anprController.js       # Thin HTTP adapter
│   └── vehicleController.js
├── services/
│   ├── anprService.js          # Ingestion (dedupe → images → insert → rollback) + Intozi feed
│   └── vehicleService.js       # Registry CRUD + resolveVehicleStatus (registered/unregistered)
├── validators/
│   ├── anprValidator.js        # express-validator rules
│   └── vehicleValidator.js
├── middleware/
│   ├── apiKeyAuth.js           # Constant-time API key check
│   ├── errorHandler.js         # 404 + centralized error handler
│   ├── rateLimiter.js
│   ├── requestContext.js       # Request id, response time, request logging
│   ├── sanitize.js             # Strips $-operators / dotted keys
│   └── validate.js             # Runs rules → 400 with field errors
├── models/
│   ├── VehicleLog.js           # Detection events — Mongoose schema + indexes
│   └── RegisteredVehicle.js    # Dashboard registry (plate → holder + valid_till)
├── utils/
│   ├── AppError.js             # Operational error with status code
│   ├── asyncHandler.js
│   ├── constants.js            # Vehicle classes / colors / types, feed masking & paging
│   ├── feedCursor.js           # Opaque keyset cursor for the Intozi feed
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
| `received_at + _id` | Intozi feed cursor paging |

`created_datetime` is the camera's timestamp; `received_at` is when this API accepted it.

Owner and driver details (`owner_name`, `contact_no`, `email`, `driver_name`, `vehicle_model`) are
stored whenever a camera sends them, but `GET /api/anpr/feed` always reports them as `null`. The
masking list lives in `FEED_MASKED_FIELDS` (`utils/constants.js`) and is enforced in
`anprService.toFeedRecord` — widen the feed there if Intozi's contract ever changes.

`vehicle_type` is stamped at ingestion from the `RegisteredVehicle` registry (see the table under
`POST /api/anpr`), defaulting to `unregistered`. Documents written before this field existed
therefore read back as `unregistered`.

`RegisteredVehicle` is the registry the dashboard writes to:

| Index | Purpose |
| --- | --- |
| `vehicle_number` (unique) | One row per plate — re-registering renews instead of duplicating |
| `valid_till` | `status` filtering on the dashboard |
| `createdAt` | Default listing order, newest first |

Registration status is **derived, never stored** — `valid_till` compared against the relevant instant
(detection time when stamping an event, request time when listing the dashboard). There is no
`is_active` flag to go stale and no scheduled job to expire anything.

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
