# Prilinesha ANPR Ingestion API

Production-ready Express + MongoDB backend that receives ANPR (Automatic Number Plate Recognition)
detection events from cameras, stores the base64 event/plate images on disk and persists the event
metadata in MongoDB.

---

## Features

| Area | Implementation |
| --- | --- |
| Architecture | Clean layering — route → middleware → validator → controller → service → model/storage |
| Multi-tenancy | Every record is scoped to a **project** (`group_id`); no query runs unscoped except for a super admin |
| Dashboard auth | Email + password → JWT; user reloaded per request, so revocation is immediate |
| Roles | `super_admin` (internal) and `admin` (customer), expressed as permissions so new APIs need no new role |
| Camera auth | Per-project API key (`pk_…`) binds a camera to one project; legacy shared `API_KEY` still accepted |
| Validation | `express-validator` rules with typed coercion and per-field error messages |
| Images | Optional base64 decode, magic-byte check, size cap, unique filenames, rollback on failure |
| Idempotency | Unique index on `group_id + transaction_id`; replays return `409` |
| Intozi feed | `GET /api/anpr/feed`, polled every 5–10 s; keyset cursor delivers each event exactly once, scoped to the key's project |
| Vehicle registry | Dashboard adds a vehicle with a `valid_till`; expiry flips detections to `unregistered` with no cron job |
| Errors | Centralized handler with a single response envelope (`400/401/403/404/409/413/429/500`) |
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
# then edit .env — MONGO_URI, API_KEY and JWT_SECRET are required

# generate the two secrets
node -e "console.log('API_KEY   =', require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_SECRET=', require('crypto').randomBytes(48).toString('hex'))"

# set the first super admin so somebody can log in and create projects
#   SUPER_ADMIN_EMAIL=admin@prilinesha.com
#   SUPER_ADMIN_PASSWORD=<a real password>

npm run dev     # nodemon, development
npm start       # production
```

The server refuses to boot with an invalid `.env` and prints exactly which variables are wrong.

On startup it creates `uploads/event-images/`, `uploads/plate-images/` and `logs/`, connects to
MongoDB (retrying with exponential backoff), synchronises the indexes and — **only if no super
admin exists yet** — seeds one from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`. Once one exists
the seed is skipped entirely, so leaving those variables set cannot resurrect a deleted account or
undo a password change. Log in, change the password, then clear `SUPER_ADMIN_PASSWORD`.

### Upgrading a database that predates projects

`group_id` is now required on registered vehicles, so rows written before this change are invisible
to every scoped query. Create the project they belong to, then:

```bash
node scripts/backfillGroupId.js ACME_MALL           # dry run — reports what it would change
node scripts/backfillGroupId.js ACME_MALL --apply   # writes
```

Safe to re-run: it only touches documents that have no `group_id`.

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
| `API_KEY` | **yes** | — | Legacy shared camera secret — **unscoped**, reads every project. Prefer per-project keys. |
| `JWT_SECRET` | **yes** | — | Signs dashboard tokens; min 32 chars. Changing it logs everyone out. |
| `JWT_EXPIRES_IN` | no | `12h` | Access-token lifetime |
| `JWT_ISSUER` | no | `prilinesha-anpr` | `iss` claim, verified on every token |
| `JWT_REFRESH_SECRET` | no | derived from `JWT_SECRET` | Signs refresh tokens. Set explicitly (≥32 chars, different from `JWT_SECRET`) to rotate the two apart. |
| `JWT_REFRESH_EXPIRES_IN` | no | `30d` | Refresh-token lifetime |
| `MAX_ACTIVE_SESSIONS` | no | `5` | Concurrent refresh tokens (≈ devices) per account; the least recently used is dropped past the cap |
| `BCRYPT_ROUNDS` | no | `12` | Password hashing cost (10–15) |
| `SIGNUP_ENABLED` | no | `true` | Allow `POST /api/auth/signup`. Set `false` once all accounts exist. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | no | `900000` | Login/signup/refresh rate-limit window (15 min) |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | Failed login/signup/refresh attempts per window per IP |
| `SUPER_ADMIN_EMAIL` | no | — | Seeds the first super admin, only when none exists |
| `SUPER_ADMIN_PASSWORD` | no | — | Required together with the email; min 8 chars |
| `SUPER_ADMIN_NAME` | no | `Super Admin` | Display name for the seeded account |
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

## Tenancy: projects, gates and users

> 📐 **[docs/SYSTEM-FLOW.md](docs/SYSTEM-FLOW.md)** has the same material as flow diagrams — the auth
> pipeline, the onboarding sequence, tenant isolation and the registered/unregistered decision.

Everything hangs off one identifier: **`group_id`**, the project. It is the value the customer types
into their Intozi configuration and that arrives on every event.

```
Project  ACME_MALL  ("Acme Mall Parking")
  ├── api_key           pk_ACMEMALL_9f2c…      ← installed on the customer's Intozi server
  ├── devices           entry1, exit1, exit2   ← the gates; device_name on every event
  ├── registered vehicles                      ← who is allowed in, until when
  ├── detection events                         ← what the cameras saw
  └── users             ravi@acmemall.com      ← the customer admins who can see all of the above
```

Nothing is shared between projects. The same plate registered under `ACME_MALL` and `BLUE_FACTORY`
is two independent records, and neither project can see the other's.

### The two roles

| | `super_admin` (you) | `admin` (your customer) |
| --- | --- | --- |
| Scope | Every project, including ones created later | Only the projects assigned to them |
| Create projects & issue API keys | ✅ | ❌ |
| Manage gates (`device_name`) | ✅ | ✅ *(own projects)* |
| Register vehicles | ✅ | ✅ *(own projects)* |
| Create users, assign projects, reset passwords | ✅ | ❌ |

Routes check **permissions**, not roles — see `PERMISSIONS` and `ROLE_PERMISSIONS` in
[utils/constants.js](utils/constants.js). Adding an API later means adding one permission entry and
listing it under whichever roles should have it; no route or middleware changes.

### End-to-end flow

```
 ① super admin                    This API                        ⑤ Intozi server
 ─────────────────────            ─────────────────────           ─────────────────────
 POST /api/auth/login   ────────►  JWT
 POST /api/projects     ────────►  Project ACME_MALL
                                   + gates entry1/exit1
                                   + api_key pk_…       ─────────► installed on site
 ② customer
 POST /api/auth/signup  ────────►  User (admin, projects: [])   ← account, but no access

 ③ super admin
 PUT /api/users/{id}/projects ──►  User.projects = ["ACME_MALL"] ← the access grant
                                                                    (live on the next request)
 ④ customer
 POST /api/vehicles     ────────►  RegisteredVehicle
 (plate, name, valid_till)         (ACME_MALL + plate → valid_till)
                                            │
 GET  /api/vehicles     ◄────────           │ looked up at detection time
 (their project only)                       ▼
                                    VehicleLog.vehicle_type
       camera ──────────────────►           │
       POST /api/anpr                       ▼
       (Bearer pk_…)               GET /api/anpr/feed  ─────────►  polls every 5–10 s
                                   (plate + registered?)             ACME_MALL events only
```

A plate is **registered** only while a registration *in that project* covers it. The moment
`valid_till` passes, the next detection is reported as **unregistered** — nothing has to expire it.

### What stops the tenants leaking into each other

- A customer admin's queries are filtered by their `projects` list. An unassigned account gets
  `{ $in: [] }`, which matches nothing — never everything.
- Naming a project outside your scope is a `403`, on reads and writes alike.
- A per-project API key ignores any `group_id` in the request body, so a key leaked from one site
  cannot write into — or read — another customer's data.
- Access is re-read from the database on every request rather than trusted from the token, so
  removing a project, changing a role or deactivating an account takes effect immediately instead of
  whenever the token happens to expire.

---

## API

| Endpoint | Auth | Who |
| --- | --- | --- |
| `POST /api/auth/signup` | — | anyone (creates an `admin` with no access) |
| `POST /api/auth/login` | — | any user |
| `POST /api/auth/refresh` | refresh token in body | any user |
| `POST /api/auth/logout` | Bearer JWT | any user |
| `GET /api/auth/me` | Bearer JWT | any user |
| `POST /api/auth/change-password` | Bearer JWT | any user |
| `POST /api/projects` | Bearer JWT | super admin |
| `GET /api/projects` · `GET /api/projects/{group_id}` | Bearer JWT | scoped to the caller |
| `PATCH /api/projects/{group_id}` | Bearer JWT | super admin |
| `POST /api/projects/{group_id}/rotate-key` | Bearer JWT | super admin |
| `POST·PATCH·DELETE /api/projects/{group_id}/devices…` | Bearer JWT | scoped to the caller |
| `POST /api/users` · `GET /api/users…` | Bearer JWT | super admin |
| `PUT /api/users/{id}/projects` | Bearer JWT | super admin |
| `PATCH /api/users/{id}/role` · `/status` | Bearer JWT | super admin |
| `POST /api/users/{id}/reset-password` | Bearer JWT | super admin |
| `POST /api/vehicles` · `GET /api/vehicles` | Bearer JWT | scoped to the caller |
| `GET /api/vehicles/filters` | Bearer JWT | scoped to the caller |
| `GET·PATCH·DELETE /api/vehicles/{id}` | Bearer JWT | scoped to the caller |
| `PATCH /api/vehicles/{id}/status` | Bearer JWT | scoped to the caller |
| `GET /api/logs` · `GET /api/logs/filters` | Bearer JWT | scoped to the caller |
| `POST /api/anpr` · `GET /api/anpr/feed` | API key | camera / Intozi |

Full request and response schemas are in Swagger at `/api-docs`.

---

### `POST /api/auth/signup`

Creates a dashboard account. The role is **forced to `admin`** and the project list starts empty —
a `role` in the body is ignored, so this endpoint cannot mint a super admin. The user can log in
straight away but sees nothing until a super admin assigns them a project.

```json
{ "name": "Ravi Sharma", "email": "ravi@acmemall.com", "password": "AcmePass123" }
```

`201` returns the user and a token. `403` if `SIGNUP_ENABLED=false`, `409` if the email is taken.

---

### `POST /api/auth/login`

```json
{ "email": "ravi@acmemall.com", "password": "AcmePass123" }
```

```json
{
  "success": true,
  "message": "Logged in successfully.",
  "data": {
    "user": {
      "id": "6a7378aa86d8e0aa080d4f95",
      "name": "Ravi Sharma",
      "role": "admin",
      "group_ids": ["ACME_MALL"],
      "projects": [{ "group_id": "ACME_MALL", "project_name": "Acme Mall Parking", "is_active": true }],
      "permissions": ["project:read", "project:device_manage", "vehicle:read", "vehicle:write", "event:read"]
    },
    "token": "eyJhbGciOiJIUzI1NiIs…",
    "token_type": "Bearer",
    "expires_in": "12h",
    "refresh_token": "eyJhbGciOiJIUzI1NiIs…",
    "refresh_expires_in": "30d"
  }
}
```

One endpoint serves both roles — the role is never sent, it is looked up. What differs is the
response: a super admin gets `"group_ids": "ALL"` (they are scoped to every project including ones
created later) and all twelve permissions; a customer admin gets their assigned `group_ids` and
five. `permissions` lets the dashboard hide actions the role cannot perform — it is never the
enforcement point, which is always server-side.

A wrong email and a wrong password return the identical `401`, and take comparable time, so the
endpoint cannot be used to discover which addresses are registered.

---

### `POST /api/auth/refresh`

No `Authorization` header — the refresh token in the body **is** the credential, which is what lets
it work once the access token has expired.

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }
```

`200` returns a new pair, plus the current `user` so a dashboard resuming a session need not also
call `/api/auth/me` — the role, permissions and project list may have changed while it was closed.

**Rotating and single-use.** Every call returns a new refresh token and retires the one presented.
Presenting the generation that was just spent means two parties hold it, so the server assumes theft
and revokes *every* session on the account — both must then come back through the password. A token
that was revoked on purpose (logged out, dropped by `MAX_ACTIVE_SESSIONS`, cleared by a password
change) is simply refused and other devices are left alone.

`401` also covers tokens that predate a password change, a role change or a deactivation.

---

### `POST /api/auth/logout`

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }   // this device
{ "all": true }                                 // every device
```

Ending one session does **not** invalidate its access token — access tokens are stateless and simply
expire, which is the cost of not hitting the database on every request. `all: true` bumps
`tokens_valid_from` and so retires them too; that is the option for a lost laptop. Revoking an
already-revoked token is not an error, it reports `sessions_revoked: 0`.

---

### `POST /api/projects`

Super admin only. Creates the tenant and issues the Intozi credential.

```json
{
  "group_id": "ACME_MALL",
  "project_name": "Acme Mall Parking",
  "customer_name": "Acme Retail Pvt Ltd",
  "devices": [
    { "device_name": "entry1", "direction": "entry" },
    { "device_name": "exit1",  "direction": "exit"  },
    { "device_name": "exit2",  "direction": "exit"  }
  ]
}
```

```json
{
  "success": true,
  "warning": "Store this api_key now — it is shown once and cannot be retrieved later.",
  "data": {
    "project": { "group_id": "ACME_MALL", "device_count": 3, "api_key_last4": "8b1c", "...": "..." },
    "api_key": "pk_ACMEMALL_9f2c1e8a4b7d0c3e6f5a2b9d8c7e4f1a0b3c6d9e2f5a8b1c",
    "intozi_setup": {
      "group_id": "ACME_MALL",
      "post_url": "/api/anpr",
      "feed_url": "/api/anpr/feed",
      "authorization_header": "Bearer pk_ACMEMALL_9f2c…"
    }
  }
}
```

**The `api_key` is shown once.** Only its SHA-256 is stored, so a lost key must be rotated
(`POST /api/projects/{group_id}/rotate-key`), not recovered — and rotating breaks the cameras until
the new key reaches the site.

`group_id` is immutable: it is stamped on every event already ingested and configured on the
cameras themselves.

---

### `PUT /api/users/{id}/projects`

Super admin only. **This is the access grant** — the moment a signed-up customer can see anything.

```json
{ "group_ids": ["ACME_MALL"], "mode": "replace" }
```

`mode` is `replace` (default), `add` or `remove`. Assigning a `group_id` that does not exist is
rejected with `400`, because a typo would silently grant access to nothing and look like a bug.

Takes effect on the user's **very next request** — no re-login. The same is true in reverse: removing
a project, demoting a role, or `PATCH /api/users/{id}/status` with `is_active: false` revokes access
immediately rather than when the token expires.

Safety rails: you cannot change your own role, deactivate your own account, or demote the last
active super admin.

---

### `POST /api/anpr`

Ingests one detection event.

**Headers**

```
Content-Type: application/json
Authorization: Bearer pk_ACMEMALL_9f2c…   # per-project key; raw and "x-api-key" also accepted
```

The event is filed under the project the key belongs to. A `group_id` in the body **cannot override
that** — it is only read when the legacy unscoped `API_KEY` is used.

`transaction_id` is idempotent **within a project**, so two customers may legitimately both send
`4471`.

A `device_name` the project has never seen is auto-registered and flagged `auto_registered: true`
rather than rejected — dropping a live event is a worse failure than an unexpected row in the device
table, and the flag is what surfaces it for review.

**Body**

```json
{
  "application_name": "ANPR",
  "application_id": 1,
  "device_name": "entry1",
  "device_unique_key": "de21ba00-c4e2-474c-9106-b3bcc50e735f",
  "group_id": "ACME_MALL",
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
| `transaction_id` | yes | integer ≥ 0, unique **within the project** |
| `created_datetime` | yes | ISO 8601; **no offset is read as UTC** |
| `event_image` | no | base64 JPG/PNG (data-URI prefix optional); omitted → `event_image_path: null` |
| `plate_image` | no | base64 JPG/PNG (data-URI prefix optional); omitted → `plate_image_path: null` |
| `group_id` | no | Project id, `A-Z 0-9 _ -`. **Ignored when a per-project key is used** — the key decides. |
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

**How `vehicle_type` is decided** — the camera does not get the last word. The lookup is scoped to
the detecting project, so a vehicle registered at one customer's site is a stranger at another's:

| Plate on **this project's** registry? | Result |
| --- | --- |
| Yes, `valid_till` not passed at `created_datetime` | `registered` |
| Yes, but expired | `unregistered` — even if the payload says `"vehicle_type": "registered"` |
| Yes, but restricted to gates that exclude this `device_name` | `unregistered` |
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
    "group_id": "ACME_MALL",
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
| `403` | The project is deactivated |
| `404` | Unknown route |
| `409` | `transaction_id` already ingested **for this project** |
| `413` | Body exceeds `JSON_BODY_LIMIT` |
| `429` | Rate limit exceeded |
| `500` | Unexpected server error |

### `GET /api/anpr/feed`

The endpoint the **Intozi server polls every 5–10 seconds**. It reports the vehicle number and
whether the vehicle is registered; every other field is returned as `null` **by contract** — the
database may well hold owner name, contact number, email, driver name, model and creation time, but
this feed never discloses them.

**Scoped to the key's project.** A per-project key returns that project's events only — no parameter
needed, and none accepted that would widen it. Naming a different `group_id` is a `403`, not a wider
read, so a key leaked from one site cannot be used to read another customer's plates. Only the
legacy shared `API_KEY` sees every project.

**Headers**

```
Authorization: Bearer pk_ACMEMALL_9f2c…
```

**Query parameters**

| Param | Default | Rule |
| --- | --- | --- |
| `cursor` | – | The `next_cursor` from the previous response. Omit on the first call. |
| `since` | – | ISO 8601; alternative cold start. Ignored when `cursor` is sent. |
| `limit` | `100` | Integer 1–1000 |
| `vehicle_type` | – | `registered` \| `unregistered` — optional filter |
| `group_id` | – | Narrows *within* what the key already grants; `403` if it names anything else |

**200 OK**

```json
{
  "success": true,
  "message": "Vehicle feed fetched successfully.",
  "count": 1,
  "group_id": "ACME_MALL",
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
| `400` | Malformed `cursor`, `since`, `limit`, `vehicle_type` or `group_id` |
| `401` | Missing or invalid API key |
| `403` | `group_id` outside the key's scope, or the project is deactivated |
| `429` | Rate limit exceeded — see `RATE_LIMIT_MAX` |

> A 5-second interval is 12 requests/minute per poller, well inside the default limit of 300/minute.

### `POST /api/vehicles`

Dashboard: register a vehicle in a project, or renew one already on that project's registry.
Authenticated with a **dashboard token**, not the camera API key — "which vehicles may I see?" is now
a per-user question.

```bash
curl -X POST http://localhost:5050/api/vehicles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "group_id": "ACME_MALL",
    "vehicle_number": "MH12AB1234",
    "name": "Ramesh Kumar",
    "phone_number": "+91 9876543210",
    "vehicle_model": "Swift Dzire",
    "valid_till": "2027-03-31"
  }'
```

**Field rules**

| Field | Required | Rule |
| --- | --- | --- |
| `group_id` | conditional | Optional if you are assigned to exactly **one** project — yours is used. Required otherwise. |
| `vehicle_number` | yes | 3–20 chars, `A-Z 0-9 -`, stored uppercase — unique **within the project** |
| `name` | yes | string, ≤ 150 chars |
| `phone_number` | yes | 6–20 characters of digits, optional `+`, spaces/hyphens allowed |
| `vehicle_model` | no | Make and model as the operator types it — free text, ≤ 100 chars. Surfaces on `GET /api/logs` when the camera reports no model of its own. |
| `valid_till` | yes | `YYYY-MM-DD` or ISO 8601 datetime; a plain date covers the **whole** day |
| `device_names` | no | Restrict to specific gates. Empty/omitted = every gate in the project. |

Omitting `vehicle_model` on a **renewal** keeps whatever model is already recorded, rather than
clearing it — the required fields above are always re-sent, but silently wiping optional data
because somebody did not retype it is how a registry loses information. Clear one explicitly with
`PATCH /api/vehicles/{id}` and `"vehicle_model": null`.

**201 Created** (a new plate) / **200 OK** (an existing plate was renewed — `created: false`)

```json
{
  "success": true,
  "message": "Vehicle registered successfully.",
  "created": true,
  "data": {
    "id": "6a7378aa86d8e0aa080d4f95",
    "group_id": "ACME_MALL",
    "vehicle_number": "MH12AB1234",
    "device_names": [],
    "name": "Ramesh Kumar",
    "phone_number": "+91 9876543210",
    "vehicle_model": "Swift Dzire",
    "valid_till": "2027-03-31T23:59:59.999Z",
    "status": "registered",
    "days_remaining": 239,
    "created_at": "2026-08-05T17:53:46.014Z",
    "updated_at": "2026-08-05T17:53:46.014Z"
  },
  "requestId": "999e9050-8b0f-4096-9e34-93384819a14f"
}
```

A plate is unique **within a project**, so re-posting one there **renews it** rather than failing —
that is how an expired vehicle is brought back, and it keeps exactly one row per plate per project.
`created` tells the dashboard which happened. The same plate under a different `group_id` is an
entirely separate record. Posting a `valid_till` that is already in the past is allowed; it simply
stores a vehicle whose `status` is `unregistered`.

Writing into a project you are not assigned to returns `403`.

### `GET /api/vehicles`

The dashboard table, restricted to the caller's projects: a super admin sees every project, a
customer admin only their assigned ones, an unassigned account an empty list. Add `?group_id=` to
narrow to one. Offset paging with a row count (unlike the Intozi feed's cursor, a table needs page
numbers).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5050/api/vehicles?search=MH12&status=registered&page=1&limit=25"
```

| Param | Default | Rule |
| --- | --- | --- |
| `group_id` | – | Narrow to one project. `403` if it is outside your scope. |
| `search` | – | Partial, case-insensitive match on vehicle number, name, phone **or** model |
| `status` | – | Effective status: `registered` (switched on **and** in date) \| `unregistered` (expired **or** deactivated) |
| `is_active` | – | The manual switch alone. `false` = what you have suspended |
| `registered_by` | – | User id — "what did this operator enter?" |
| `device_name` | – | Registrations that count at this gate, case-insensitive. Includes the unrestricted ones (empty `device_names` = every gate) |
| `valid_from` | – | Passes expiring on or after this date |
| `valid_to` | – | Passes expiring on or before this date. A bare date covers the whole day |
| `expiring_in_days` | – | Integer 0–730. The renewals queue: switched on **and** lapsing within N days |
| `page` | `1` | Integer ≥ 1 |
| `limit` | `25` | Integer 1–200 |

Filters intersect, so a contradiction returns nothing rather than the wrong rows —
`?status=registered&is_active=false` is empty by construction, not by accident.

`device_name` answers "who may come through this entrance?", which is not the same question as
"whose registration names this gate": a registration with an empty `device_names` is the wildcard
meaning every gate in the project, so it is valid there too and is included.

`valid_from`/`valid_to` filter the **expiry date itself** — "which passes run out this month?" —
which is independent of `status`, and that only asks whether that date has already gone by.
`expiring_in_days` is the renewals queue as one parameter: it excludes the already expired (the
window starts now) and the deactivated, because a suspended vehicle is waiting on a decision, not on
a renewal.

```json
{
  "success": true,
  "message": "Vehicles fetched successfully.",
  "count": 2,
  "pagination": { "page": 1, "limit": 25, "total": 2, "total_pages": 1, "has_next": false, "has_previous": false },
  "data": [
    {
      "id": "6a7378aa86d8e0aa080d4f96",
      "group_id": "ACME_MALL",
      "vehicle_number": "DL01XY9999",
      "device_names": [],
      "name": "Anita Sharma",
      "phone_number": "9812345678",
      "vehicle_model": "Alto K10",
      "valid_till": "2026-01-31T23:59:59.999Z",
      "is_active": true,
      "status": "unregistered",
      "inactive_reason": "expired",
      "days_remaining": -185,
      "registered_by": { "id": "6a7378aa86d8e0aa080d4f95", "name": "Ravi Sharma", "email": "ravi@acmemall.com" },
      "updated_by": { "id": "6a7378aa86d8e0aa080d4f95", "name": "Ravi Sharma", "email": "ravi@acmemall.com" },
      "created_at": "2026-08-05T17:53:46.225Z",
      "updated_at": "2026-08-05T17:53:46.225Z"
    }
  ],
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

`status` and `days_remaining` are **computed on every read** — never stored. A row cannot drift out
of sync with reality, and nothing needs a scheduled job to expire it. `days_remaining` goes negative
once lapsed, so the UI can render "expired 185 days ago" directly.

---

### `GET /api/vehicles/filters`

What the filter bar above that table can offer. Fetch it once when the screen opens, then send the
chosen values back to `GET /api/vehicles`. Without it a dashboard would have to hard-code every
customer's gate names, or page the registry to discover them — and both go stale the day a gate is
added.

Scoped exactly like the table it drives, so a dropdown can never offer a project the caller would
then get a `403` for. `?group_id=` narrows the options **and** the counts to one project.

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:5050/api/vehicles/filters"
```

```json
{
  "success": true,
  "message": "Vehicle filters fetched successfully.",
  "data": {
    "projects": [
      { "group_id": "ACME_MALL", "project_name": "ACME_MALL", "is_active": true, "device_names": ["entry1", "exit1"] }
    ],
    "device_names": ["entry1", "exit1"],
    "statuses": ["registered", "unregistered"],
    "registered_by": [
      { "id": "6a7378aa86d8e0aa080d4f95", "name": "Ravi Sharma", "email": "ravi@acmemall.com" }
    ],
    "counts": { "total": 128, "registered": 101, "unregistered": 27, "expired": 22, "deactivated": 5 },
    "expiring_soon": { "within_days": 30, "count": 9 },
    "paging": { "default_limit": 25, "max_limit": 200 }
  },
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

The counts partition the registry exactly — `registered + expired + deactivated = total`, and
`unregistered` is the last two added up — which is the same decomposition `status` and `is_active`
filter on. A chip's number therefore always matches the table it opens. `expired` and `deactivated`
are reported apart because they are fixed differently: one needs renewing, the other switching back
on.

`registered_by` lists only operators who have actually registered something in this scope, so the
dropdown is the handful of names that appear in the table rather than every account on the system.
`expiring_soon.count` is what `?expiring_in_days=30` returns.

Gates come from the project registry, not from a `distinct` over the registry rows: a gate list is
one small document per project, a `distinct` is a scan, and a gate nobody has registered at yet is
still a gate worth offering.

---

### `GET /api/vehicles/{id}`

One registration, same shape as a list row. A vehicle in another customer's project is a **404**, not
a `403` — an object id is opaque and guessable in bulk, and answering "that exists, but it is not
yours" would confirm which ids are real, and for whom.

---

### `PATCH /api/vehicles/{id}`

Edits a registration. Only the fields sent change.

```json
{ "name": "Ravi K Sharma", "vehicle_model": "Swift Dzire VXi", "valid_till": "2028-03-31" }
```

| Field | Rule |
| --- | --- |
| `name` | ≤150 chars |
| `phone_number` | 6–20 digits, optional `+` |
| `vehicle_model` | Free text ≤100 chars. `null` or `""` clears it |
| `valid_till` | `YYYY-MM-DD` (whole day) or ISO 8601 |
| `device_names` | Gate list. Omit to leave alone; send `[]` to widen back to every gate |
| `is_active` | Also settable here, though `/status` below is the endpoint for toggling alone |

`group_id` and `vehicle_number` are **not editable** — together they are the row's identity and its
unique index, so changing either is registering a different vehicle (that's a POST). Allowing it
would also let a customer admin move a record into a project they cannot see. A body that changes
nothing is a `400`, so a mistyped field name cannot look like a successful edit.

`registered_by` survives an edit by someone else; `updated_by` records who touched it last.

---

### `PATCH /api/vehicles/{id}/status` — mark registered / unregistered

```json
{ "is_active": false }
```

```json
{
  "success": true,
  "message": "Vehicle deactivated. It reads as unregistered at every gate until reactivated.",
  "data": {
    "id": "6a7378aa86d8e0aa080d4f96",
    "vehicle_number": "DL01XY9999",
    "is_active": false,
    "status": "unregistered",
    "inactive_reason": "deactivated",
    "valid_till": "2027-12-31T23:59:59.999Z",
    "days_remaining": 511,
    "...": "..."
  },
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

**Two things decide status, and both must hold for a plate to read as registered:**

| | Owned by | Stored? |
| --- | --- | --- |
| `valid_till` in the future | time | yes, as a date |
| `is_active` true | the dashboard user | yes, as a flag |

`is_active: false` reports the plate as **unregistered at every gate immediately**, whatever
`valid_till` says — for a resident who moved out, or a pass suspended pending payment. `true`
restores it. `valid_till` is untouched either way, so the pass keeps running down while suspended.

There is deliberately **no stored `status` column**. One would have to be rewritten by a cron job the
instant a pass expired, and would silently disagree with `valid_till` the moment that job failed.
Instead the flag is the only thing a person can set, and the three places that need the status —
the dashboard table, the ingestion-time decision in `POST /api/anpr`, and the Intozi feed — all
derive it from the same two fields through one function. Deactivating is therefore live on Intozi's
next poll and on the very next detection, with nothing to synchronise.

`inactive_reason` (`deactivated` \| `expired` \| `null`) lets the UI tell "we suspended this" apart
from "the pass ran out" instead of showing one ambiguous badge.

Re-registering a suspended plate via `POST /api/vehicles` switches it **back on** — submitting the
registration form is an explicit "this vehicle is allowed until X", and leaving it deactivated would
hand back a record saying registered and a barrier that refuses to open.

---

### `DELETE /api/vehicles/{id}`

```json
{
  "success": true,
  "message": "Vehicle registration deleted.",
  "data": { "id": "6a7378aa86d8e0aa080d4f96", "group_id": "ACME_MALL", "vehicle_number": "DL01XY9999" },
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

**Prefer deactivating.** A deleted row loses who registered it and when, and the plate becomes
indistinguishable from one that was never registered. Deleting is right for a record entered by
mistake, not for a resident who moved out.

Detections already logged are untouched — `VehicleLog` stores the status as judged at detection time,
not a reference to this row, so the history of what the barrier actually did stays intact.

---

### `GET /api/logs`

The detection log for the internal dashboard — the ANPR events themselves, with the owner resolved.
**Dashboard only:** a dashboard JWT is the only credential accepted, so a camera or Intozi API key
cannot read it. That separation is the point — `GET /api/feed` reads the *registry* and discloses
three fields, this reads the *events* and names the owner.

Restricted to the caller's projects, on the same rules as `GET /api/vehicles`: a super admin sees
every project, a customer admin only their assigned ones, an unassigned account an empty list rather
than everything. `?group_id=` narrows to one; naming a project outside your scope is a `403`, not a
quiet empty page.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5050/api/logs?group_id=ACME_MALL&from=2026-08-01&to=2026-08-07&page=1&limit=25"
```

| Param | Default | Rule |
| --- | --- | --- |
| `group_id` | – | Narrow to one project. `403` if it is outside your scope. |
| `search` | – | Partial, case-insensitive match on vehicle number, owner name **or** vehicle model |
| `vehicle_number` | – | One exact plate — every crossing by this vehicle |
| `vehicle_type` | – | `registered` \| `unregistered` |
| `device_name` | – | Exact gate, matched case-insensitively |
| `from` | – | `YYYY-MM-DD` (from 00:00:00 UTC) or ISO 8601 datetime |
| `to` | – | `YYYY-MM-DD` covers the **whole** day, or ISO 8601 datetime |
| `page` | `1` | Integer ≥ 1 |
| `limit` | `25` | Integer 1–200 |

```json
{
  "success": true,
  "message": "Vehicle logs fetched successfully.",
  "count": 2,
  "pagination": { "page": 1, "limit": 25, "total": 2, "total_pages": 1, "has_next": false, "has_previous": false },
  "data": [
    {
      "id": "6b8f21c4d9e3a70f1c45b902",
      "group_id": "ACME_MALL",
      "device_name": "entry1",
      "vehicle_number": "HR26DK8337",
      "vehicle_type": "registered",
      "vehicle_model": "Swift Dzire",
      "vehicle_model_source": "registry",
      "owner_name": "Ravi Sharma",
      "owner_name_source": "registry",
      "detected_at": "2026-08-05T10:00:00.000Z",
      "received_at": "2026-08-05T10:00:05.000Z"
    },
    {
      "id": "6b8f21c4d9e3a70f1c45b903",
      "group_id": "ACME_MALL",
      "device_name": "exit1",
      "vehicle_number": "UP16XY9999",
      "vehicle_type": "unregistered",
      "vehicle_model": null,
      "vehicle_model_source": null,
      "owner_name": null,
      "owner_name_source": null,
      "detected_at": "2026-08-04T09:00:00.000Z",
      "received_at": "2026-08-04T09:00:02.000Z"
    }
  ],
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

**`owner_name`** comes from the event when the camera sent one, and otherwise from the
registered-vehicle registry matched on `(group_id, vehicle_number)` — Intozi normally sends no
owner, so the registry is where the name actually lives. `owner_name_source` says which answered
(`event`, `registry`, or `null` when the plate is unknown to both). The registry lookup is one
bounded query per page, not one per row, and it never crosses projects: the same plate can be Ravi
at one site and a stranger at another.

**`vehicle_model`** resolves the same way, with `vehicle_model_source` reporting which answered:
what the camera inferred wins, and the model an operator typed on the registration fills the gap.
Note that `?search=` matches the event's own values only — a plate whose model is known solely from
the registry will not match on model here, because resolving the registry before filtering means a
join on every query to serve a rare case. Search the registry itself via `GET /api/vehicles`.

**`vehicle_type`** is the status as judged *when the vehicle was seen*, read from the event — so a
registration expiring today cannot rewrite last week's rows.

**`vehicle_number`** is the "follow one vehicle" filter, and it is deliberately not `search`: the
plate is uppercased on the way in and matched as an equality, so it walks
`idx_group_vehicle_number_created` instead of regex-scanning three columns. Use `search` when you
have a fragment, `vehicle_number` when you have the plate.

Rows are sorted by `detected_at` (when the camera saw it) descending, with `_id` breaking ties so no
row can appear on two pages. The response is built field by field rather than by hiding columns, so
the contact details stored on an event — `contact_no`, `email`, `driver_name` — never appear here,
and a column added to `VehicleLog` later cannot leak by default.

---

### `GET /api/logs/filters`

What the filter bar above the log table can offer — the same idea as
`GET /api/vehicles/filters`, for the detections. Fetch it once when the screen opens, then send the
chosen values back to `GET /api/logs`. Scoped identically to the table, so a dropdown can never
offer a project the caller would then get a `403` for.

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:5050/api/logs/filters"
```

```json
{
  "success": true,
  "message": "Vehicle log filters fetched successfully.",
  "data": {
    "projects": [
      { "group_id": "ACME_MALL", "project_name": "ACME_MALL", "is_active": true, "device_names": ["entry1", "exit1"] }
    ],
    "device_names": ["entry1", "exit1"],
    "vehicle_types": ["registered", "unregistered"],
    "detected_between": { "from": "2026-07-02T06:11:40.000Z", "to": "2026-08-11T09:58:12.000Z" },
    "paging": { "default_limit": 25, "max_limit": 200 }
  },
  "requestId": "540629b8-3baf-4065-8964-db33188a4986"
}
```

`detected_between` is the real extent of the caller's data, so a date picker can bound itself to it.
Both ends are `null` when there are no detections at all — which is a different thing from a filter
that matched nothing, and the UI should be able to tell those apart.

Gates come from the project registry rather than from the events themselves: a camera that has not
seen anything yet is still a gate worth offering, and reading one small document per project beats a
`distinct` over every detection ever ingested.

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

The whole flow, start to finish.

**1 · Log in as the super admin** (seeded from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`):

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@prilinesha.com","password":"<your password>"}' | jq -r .data.token)
```

**2 · Create the project and its gates.** Save the `api_key` — it is shown once:

```bash
curl -s -X POST http://localhost:5050/api/projects \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{
    "group_id":"ACME_MALL",
    "project_name":"Acme Mall Parking",
    "devices":[{"device_name":"entry1","direction":"entry"},{"device_name":"exit1","direction":"exit"}]
  }' | jq '{group_id:.data.project.group_id, api_key:.data.api_key}'

PROJECT_KEY=pk_ACMEMALL_…   # paste it here
```

**3 · The customer signs up, then you grant them the project:**

```bash
USER_ID=$(curl -s -X POST http://localhost:5050/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Ravi Sharma","email":"ravi@acmemall.com","password":"AcmePass123"}' | jq -r .data.user.id)

curl -s -X PUT http://localhost:5050/api/users/$USER_ID/projects \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"group_ids":["ACME_MALL"]}' | jq .data.group_ids
```

**4 · The customer logs in and registers a vehicle** — this is what makes the detection below come
back as `registered`. They are in exactly one project, so `group_id` can be omitted:

```bash
CUST=$(curl -s -X POST http://localhost:5050/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ravi@acmemall.com","password":"AcmePass123"}' | jq -r .data.token)

curl -s -X POST http://localhost:5050/api/vehicles \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CUST" \
  -d '{"vehicle_number":"UP32AB1234","name":"Ramesh Kumar","phone_number":"+91 9876543210","valid_till":"2027-03-31"}' | jq .data
```

**5 · Send a detection as the camera would**, using the project key:

```bash
curl -X POST http://localhost:5050/api/anpr \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROJECT_KEY" \
  -d '{
    "application_name":"ANPR","application_id":1,
    "device_name":"entry1",
    "device_unique_key":"de21ba00-c4e2-474c-9106-b3bcc50e735f",
    "cam_id":3,"transaction_id":108,
    "vehicle_number":"UP32AB1234",
    "event_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "plate_image":"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "created_datetime":"2025-12-22T12:33:01.744613"
  }'
```

The response should show `"vehicle_type": "registered"` and `"group_id": "ACME_MALL"`.

**6 · Read it back off the Intozi feed** — first the newest page, then only what is new. The key
scopes it to `ACME_MALL` automatically:

```bash
# cold start
curl -s -H "Authorization: Bearer $PROJECT_KEY" "http://localhost:5050/api/anpr/feed?limit=5"

# every later poll — reuse the next_cursor from the previous response
curl -s -H "Authorization: Bearer $PROJECT_KEY" "http://localhost:5050/api/anpr/feed?cursor=<next_cursor>"
```

A minimal poller:

```bash
CURSOR=""
while true; do
  BODY=$(curl -s -H "Authorization: Bearer $PROJECT_KEY" "http://localhost:5050/api/anpr/feed?cursor=$CURSOR")
  echo "$BODY" | jq -c '.data[]'
  CURSOR=$(echo "$BODY" | jq -r '.next_cursor // empty')
  sleep 5
done
```

**7 · Confirm the isolation holds.** All three of these must fail:

```bash
# the customer cannot reach another project
curl -s -H "Authorization: Bearer $CUST" "http://localhost:5050/api/vehicles?group_id=BLUE_FACTORY" | jq .code   # FORBIDDEN

# the customer cannot create projects or manage users
curl -s -H "Authorization: Bearer $CUST" "http://localhost:5050/api/users" | jq .code                            # FORBIDDEN

# revoking the project takes effect on the very next request, with no re-login
curl -s -X PUT http://localhost:5050/api/users/$USER_ID/projects \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"group_ids":["ACME_MALL"],"mode":"remove"}' > /dev/null
curl -s -H "Authorization: Bearer $CUST" "http://localhost:5050/api/vehicles" | jq .count                        # 0
```

---

## Project structure

```
.
├── app.js                      # Express wiring (no side effects — importable by tests)
├── server.js                   # Boot: storage → Mongo (retry) → indexes → listen → graceful shutdown
├── config/
│   ├── env.js                  # Environment validation & coercion (fails fast)
│   ├── database.js             # Mongo connect/disconnect, retry, connection state
│   └── bootstrap.js            # Seeds the first super admin — only when none exists
├── routes/
│   ├── auth.js                 # signup, login, me, change-password
│   ├── users.js                # User admin + project assignment (super admin)
│   ├── projects.js             # Projects (group_id), gates, API-key rotation
│   ├── vehicles.js             # GET/POST /api/vehicles, /filters, /{id} (dashboard)
│   ├── logs.js                 # GET /api/logs, /api/logs/filters (dashboard)
│   ├── anpr.js                 # POST /api/anpr, GET /api/anpr/feed (cameras)
│   └── health.js               # GET /health, /health/ready
├── controllers/                # Thin HTTP adapters
│   ├── authController.js
│   ├── userController.js
│   ├── projectController.js
│   ├── vehicleController.js
│   ├── logController.js
│   └── anprController.js
├── services/
│   ├── authService.js          # Signup, login, profile, password change
│   ├── userService.js          # User admin; assignProjects IS the access grant
│   ├── projectService.js       # Projects, gates, API keys, device auto-registration
│   ├── vehicleService.js       # Registry CRUD + resolveVehicleStatus (registered/unregistered)
│   ├── logService.js           # Detection-log table + its filter options
│   └── anprService.js          # Ingestion (dedupe → images → insert → rollback) + Intozi feed
├── validators/                 # express-validator rules
│   ├── authValidator.js        # Password policy lives here, stated once
│   ├── userValidator.js
│   ├── projectValidator.js     # GROUP_ID_PATTERN / DEVICE_NAME_PATTERN — reused everywhere
│   ├── dateRules.js            # from/to windows — one reading of "a bare date", shared
│   ├── vehicleValidator.js
│   ├── logValidator.js
│   └── anprValidator.js
├── middleware/
│   ├── auth.js                 # JWT verify → authorize(permission) → project scoping
│   ├── apiKeyAuth.js           # Per-project key lookup, or constant-time global key check
│   ├── errorHandler.js         # 404 + centralized error handler
│   ├── rateLimiter.js          # General limiter + a much stricter one for login/signup
│   ├── requestContext.js       # Request id, response time, request logging
│   ├── sanitize.js             # Strips $-operators / dotted keys
│   └── validate.js             # Runs rules → 400 with field errors
├── models/
│   ├── User.js                 # Dashboard users; hashes passwords in a pre-save hook
│   ├── Project.js              # Tenant: group_id, devices, hashed API key
│   ├── VehicleLog.js           # Detection events — Mongoose schema + indexes
│   └── RegisteredVehicle.js    # Registry (group_id + plate → holder + valid_till)
├── utils/
│   ├── AppError.js             # Operational error with status code
│   ├── asyncHandler.js
│   ├── constants.js            # ROLES, PERMISSIONS, ROLE_PERMISSIONS, feed masking & paging
│   ├── jwt.js                  # Sign/verify access tokens
│   ├── apiKeys.js              # Project key generation + SHA-256 hashing
│   ├── feedCursor.js           # Opaque keyset cursor for the Intozi feed
│   ├── imageStorage.js         # Base64 decode, write, rollback
│   └── logger.js               # Winston (rotating files + console, redaction)
├── scripts/
│   └── backfillGroupId.js      # One-off migration for pre-project databases
├── docs/
│   ├── swagger.js              # OpenAPI 3.0 spec
│   ├── swaggerAuthPaths.js     # Auth / project / user paths (split for size)
│   └── swaggerAuthSchemas.js   # Auth / project / user schemas
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
| `group_id + transaction_id` (unique) | Idempotency — scoped, because a transaction id is only unique within one Intozi deployment |
| `group_id + vehicle_number + created_datetime` | Plate search within a project, newest first |
| `created_datetime` | Time-range reports |
| `group_id + received_at + _id` | Intozi feed cursor paging, per project |
| `received_at + _id` | The same cursor walk for an unscoped (global-key) read |

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
| `group_id + vehicle_number` (unique) | One row per plate **per project** — re-registering renews instead of duplicating, while another project keeps its own independent record |
| `group_id + valid_till` | `status` filtering on the dashboard |
| `group_id + createdAt` | Default listing order, newest first |

Registration status is **derived, never stored** — `valid_till` compared against the relevant instant
(detection time when stamping an event, request time when listing the dashboard). There is no
`is_active` flag to go stale and no scheduled job to expire anything.

`Project` is the tenant record:

| Index | Purpose |
| --- | --- |
| `group_id` (unique) | One project per identifier — this is what Intozi is told to send |
| `api_key_hash` | Authenticating a camera is a lookup on every ingest, so it must be indexed |
| `createdAt` | Default listing order |

Only the SHA-256 of an API key is stored (`select: false`), plus its last 4 characters so the
dashboard can say which key is installed on site without being able to reproduce it. SHA-256 rather
than bcrypt is deliberate: the key is 192 bits of generated randomness, so there is no dictionary to
defend against, and ingestion authenticates on every event — it has to be an indexed lookup.

`User` holds dashboard accounts:

| Index | Purpose |
| --- | --- |
| `email` (unique) | One account per address; stored lowercase so casing cannot fork an account |
| `projects` | "Who has access to this project?" without scanning the collection |
| `createdAt` | Default listing order |

Passwords are bcrypt-hashed in a `pre('save')` hook rather than in the service, so no code path can
write a plaintext password by forgetting a call, and `password_hash` is `select: false` so it cannot
leak through a forgotten projection. `tokens_valid_from` retires every token issued before it —
bumped on password change, role change and deactivation.

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
- **Index sync on boot** also *drops* indexes no longer declared on a schema — that is what retires
  the old globally-unique plate index once registrations became per-project.
- **Lost project key**: rotate it (`POST /api/projects/{group_id}/rotate-key`). The old key stops
  working immediately, so the cameras for that project fail until the new key reaches the site.
- **Offboarding a customer**: `PATCH /api/projects/{group_id}` with `is_active: false` stops their
  cameras posting and their feed being read, without deleting anything. Deactivating a *user*
  (`PATCH /api/users/{id}/status`) revokes them on their next request while leaving their audit
  trail intact — prefer both to deletion.
- **Turn signup off** (`SIGNUP_ENABLED=false`) once every customer account exists; create the rest
  with `POST /api/users`.
- **Rotating `JWT_SECRET`** invalidates every issued token at once — that is the global logout.
