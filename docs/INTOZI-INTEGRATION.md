# Prilinesha ANPR — Intozi Integration Guide

Everything the Intozi server needs to integrate with the Prilinesha ANPR backend.
There are exactly **two endpoints**: one to push detections, one to pull the
registered-vehicle list.

| | Endpoint | Direction | Called by |
|---|---|---|---|
| **1** | `POST /api` | Intozi → Prilinesha | Camera, on every detection |
| **2** | `GET /api/feed` | Intozi ← Prilinesha | Intozi server, polled on a timer |

---

## 1. Connection details

| Item | Value |
|---|---|
| Base URL (staging) | `http://<host>:5050` |
| Base URL (production) | *provided separately* |
| Protocol | HTTP/1.1, JSON |
| Character encoding | UTF-8 |
| Authentication | `Authorization: Bearer <API_KEY>` on **every** request |

The API key is issued per project and looks like `pk_…`. It is shown **once**, when
the project is created, and cannot be recovered afterwards — only rotated. Store it
in your configuration, not in source control.

A key is bound to one project. It can only write into, and read from, that project.
Sending a different `group_id` will not change that (see [Scoping](#5-scoping-and-group_id)).

**Missing or wrong key → `401`. Deactivated project → `403`.**

---

## 2. `POST /api` — submit a detection event

Called once per vehicle detection. One request = one event.

### Request

```http
POST /api HTTP/1.1
Host: <host>:5050
Content-Type: application/json
Authorization: Bearer pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```json
{
  "application_name": "ANPR",
  "application_id": 1,
  "device_name": "entry1",
  "device_unique_key": "3f9a1c22-7b6e-4d55-9f0a-2c8b41d7e610",
  "group_id": "ACME_MALL_PARKING",
  "latitude": "28.6139",
  "longitude": "77.2090",
  "cam_id": 101,
  "transaction_id": 100001,
  "vehicle_number": "DL8CAF1234",
  "vehicle_class": "car",
  "color": "White",
  "vehicle_type": "unregistered",
  "vehicle_model": "Swift Dzire",
  "owner_name": "Amit Verma",
  "driver_name": "Amit Verma",
  "contact_no": "+91 9876543210",
  "email": "amit.verma@example.com",
  "triple_riding": false,
  "no_helmet": false,
  "no_seatbelt": false,
  "driver_on_call_status": false,
  "event_image": null,
  "plate_image": null,
  "created_datetime": "2026-08-07T12:33:01.744613"
}
```

### Request fields

#### Required

| Field | Type | Rule |
|---|---|---|
| `application_name` | string | 1–100 characters |
| `application_id` | integer | ≥ 0 |
| `device_name` | string | 1–150 characters. Identifies the gate |
| `device_unique_key` | string | **Must be a valid UUID** |
| `group_id` | string | 2–50 chars `A-Z 0-9 _ -`, uppercased automatically. A `pk_…` key still overrides it — the key decides the project, this states the sender's intent |
| `cam_id` | integer | ≥ 0 |
| `transaction_id` | integer | ≥ 0. **Must be unique per project** — see [Idempotency](#idempotency-and-retries) |
| `vehicle_number` | string | 3–20 chars, `A-Z 0-9 -` only. Uppercased automatically. An event with no plate cannot be matched against the registry, so do not post one |
| `created_datetime` | string | ISO 8601. No offset is interpreted as **UTC** |

#### Optional

| Field | Type | Rule |
|---|---|---|
| `latitude` | string | Numeric string, −90 to 90 |
| `longitude` | string | Numeric string, −180 to 180 |
| `vehicle_class` | string | `bus` \| `car` \| `bike` \| `truck` \| `auto` |
| `color` | string | `White` \| `Gray` \| `Yellow` \| `Red` \| `Green` \| `Blue` \| `Black` (case-sensitive) |
| `vehicle_type` | string | `registered` \| `unregistered` — **advisory only**, see below |
| `vehicle_model` | string | ≤ 100 characters |
| `owner_name` | string | ≤ 150 characters |
| `driver_name` | string | ≤ 150 characters |
| `contact_no` | string | 6–20 chars, digits, optional `+`, spaces/hyphens |
| `email` | string | Valid email, ≤ 254 characters |
| `triple_riding` | boolean | Accepts `true`/`false` or `"true"`/`"false"` |
| `no_helmet` | boolean | as above |
| `no_seatbelt` | boolean | as above |
| `driver_on_call_status` | boolean | as above |
| `event_image` | string | Base64-encoded image, ≤ 10 MB decoded |
| `plate_image` | string | Base64-encoded image, ≤ 10 MB decoded |

Omitted, `null` and `""` are all treated as "not supplied" for optional fields.
A required field sent as `null` or `""` is a `400`, not a "not supplied". An
event with no images is still accepted and stored.

> **`vehicle_type` in the request is not authoritative.** Prilinesha looks the plate
> up in that project's registry and decides `registered` / `unregistered` itself,
> judged against the registration's expiry at detection time. Send your best guess
> if you have one; the response tells you what was actually recorded.

### Success response — `200 OK`

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6a74c91de374bd37706ab430",
    "group_id": "ACME_MALL_PARKING",
    "transaction_id": 100001,
    "vehicle_number": "DL8CAF1234",
    "vehicle_type": "registered",
    "event_image_path": "/uploads/event-images/100001-a1b2c3.jpg",
    "plate_image_path": null
  },
  "requestId": "19dbb334-1dbf-4851-b352-7f786df0a8a4"
}
```

`data.vehicle_type` is the **authoritative** status Prilinesha recorded, which may
differ from what was sent.

### Error responses

| Status | `code` | Cause |
|---|---|---|
| `400` | `VALIDATION_ERROR` | A field failed validation. `errors[]` names each one |
| `401` | `UNAUTHORIZED` | Missing or invalid API key |
| `403` | `FORBIDDEN` | The project is deactivated |
| `409` | `DUPLICATE_RESOURCE` | This `transaction_id` already exists for this project |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeded 15 MB |
| `429` | `RATE_LIMIT_EXCEEDED` | Over the request budget — see [Rate limits](#4-rate-limits-and-polling-intervals) |
| `500` | `INTERNAL_SERVER_ERROR` | Server fault — safe to retry |

Every error has the same shape:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed.",
  "errors": [
    { "field": "device_unique_key", "message": "device_unique_key must be a valid UUID." }
  ],
  "requestId": "4ba4e1a6-3799-442d-a1c7-fc402a63a7ed"
}
```

Quote `requestId` when reporting a problem — it locates the exact request in our logs.

### Idempotency and retries

`transaction_id` is **unique per project**. Re-sending the same one returns `409`
without creating a duplicate, so a retry after a network timeout is safe: `409`
means "already delivered", not an error to escalate.

Two different customers may legitimately both send `4471` — uniqueness is scoped to
the project, not global.

---

## 3. `GET /api/feed` — poll the registered-vehicle list

Returns the vehicles the Prilinesha dashboard knows about, and whether each is
currently registered. **This is the registry, not a detection log** — a vehicle
appears here as soon as it is registered, whether or not a camera has ever seen it.

### Request

```http
GET /api/feed?limit=100 HTTP/1.1
Host: <host>:5050
Authorization: Bearer pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Query parameters — all optional

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string | — | `next_cursor` from the previous response. **The normal way to poll** |
| `limit` | integer | `100` | 1–1000 |
| `vehicle_type` | string | — | `registered` or `unregistered` |
| `since` | string | — | ISO 8601. Rows changed strictly after this instant |
| `group_id` | string | — | Only meaningful for the legacy shared key |

### Success response — `200 OK`

```json
{
  "success": true,
  "message": "Vehicle feed fetched successfully.",
  "count": 2,
  "group_id": "ACME_MALL_PARKING",
  "next_cursor": "MjAyNi0wOC0wN1QxMDoxNTowMC4wMDBafDZhNzRjOTFkZTM3NGJkMzc3MDZhYjQzMA",
  "has_more": false,
  "data": [
    {
      "vehicle_number": "DL3CC9876",
      "group_id": "ACME_MALL_PARKING",
      "vehicle_type": "registered",
      "device_names": ["Netru Pro Entry", "exit1"]
    },
    {
      "vehicle_number": "DL5CX1222",
      "group_id": "ACME_MALL_PARKING",
      "vehicle_type": "registered",
      "device_names": ["Netru Pro Entry"]
    }
  ],
  "requestId": "a618d237-88f8-4d4b-bd47-62713898ed3c"
}
```

### Response fields

| Field | Meaning |
|---|---|
| `count` | Rows in `data` for this page |
| `next_cursor` | Send back as `cursor` on the next poll. Never `null` once you have polled once |
| `has_more` | `true` = more rows are already waiting. Poll again **immediately**, do not wait for the interval |
| `data[].vehicle_number` | The plate, uppercased |
| `data[].group_id` | The project this vehicle is registered under |
| `data[].vehicle_type` | `registered` or `unregistered` |
| `data[].device_names` | The **complete, explicit** list of gates this registration is good for. Names exactly as the cameras report them |

Each row contains **exactly these four fields**. Owner names and phone numbers
are held on the Prilinesha side and are never sent.

> **`vehicle_type` is not a barrier decision on its own.** A registration can be
> limited to specific gates, so `registered` means "this pass is current", not
> "open anywhere". At a gate whose `device_name` is not in `device_names`, treat
> the vehicle as **unregistered**:
>
> ```
> allowed = vehicle_type == "registered"
>           and device_name in device_names
> ```
>
> Match the gate name case-insensitively; Prilinesha applies the same rule
> when it stamps an incoming event, so the two sides agree.

> **There is no wildcard to interpret.** When a dashboard operator picks "all
> gates", it is expanded to every active gate of the project **by name** before
> being stored — so `device_names` is always the literal set of gates, and there
> is no `all_gates` flag on the feed.

`vehicle_type` is computed when you read it, from the registration's expiry date.
A registration that lapsed a minute ago already reads `unregistered`; nothing has
to be flipped by hand.

### Error responses

| Status | `code` | Cause |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Bad `cursor`, `limit`, `since` or `vehicle_type` |
| `401` | `UNAUTHORIZED` | Missing or invalid API key |
| `403` | `FORBIDDEN` | `group_id` names a project this key cannot read |
| `429` | `RATE_LIMIT_EXCEEDED` | Over the request budget |
| `500` | `INTERNAL_SERVER_ERROR` | Server fault — safe to retry |

### The polling loop

1. **First call:** no `cursor`. Returns the **oldest** page of the registry.
2. **Store `next_cursor`** from the response.
3. **While `has_more` is `true`,** call again immediately with the new `cursor`.
   Repeat until `has_more` is `false` — you now hold the complete list.
4. **Every later call:** send the latest `cursor`. You receive only rows added or
   renewed since, each exactly once.
5. **On `429` or `5xx`,** keep the cursor you already have and retry after a delay.
   Do **not** drop back to no-cursor; that restarts the full sync from the beginning.

```
GET /api/feed?limit=100            -> 100 rows, next_cursor = A, has_more = true
GET /api/feed?limit=100&cursor=A   -> 100 rows, next_cursor = B, has_more = true    (immediately)
GET /api/feed?limit=100&cursor=B   ->  12 rows, next_cursor = C, has_more = false   (full list held)
   ... wait 5-10 s ...
GET /api/feed?limit=100&cursor=C   ->   0 rows, next_cursor = C, has_more = false
   ... a vehicle is registered ...
GET /api/feed?limit=100&cursor=C   ->   1 row,  next_cursor = D, has_more = false
```

An empty page is normal and returns the cursor unchanged, so you never have to
remember the last non-empty one.

> **The first call is a full sync, not a sample.** With no cursor you get the oldest
> page and must keep paging while `has_more` is `true`. Stopping after one page
> leaves you with an incomplete list.

> **Renewals reappear.** When a registration is extended, its row is re-sent with its
> new status — that is how you learn the status changed. Treat a repeated
> `vehicle_number` as an update to what you hold, not a duplicate.

> **Recommended: a full resync once a day.** A registration that simply *expires*
> does not re-appear on a cursor poll, because nothing wrote to it. Call once with
> no `cursor` (paging with `has_more` until exhausted) every 24 hours and replace
> your cached list, so silently-expired plates are corrected.

---

## 4. Rate limits and polling intervals

### The limit

| | Value |
|---|---|
| Budget | **300 requests per 60 seconds** |
| Sustained rate | **5 requests per second** |
| Scope | **Per source IP, shared across both endpoints** |
| Response when exceeded | `429` with `code: RATE_LIMIT_EXCEEDED` |

`POST /api` and `GET /api/feed` draw on the **same** budget. Every poll you make is
one fewer detection you can post in that minute.

Standard rate-limit headers (IETF draft-7) are on every response — read them rather
than counting requests yourself:

```
RateLimit: limit=300, remaining=247, reset=34
RateLimit-Policy: 300;w=60
```

`reset` is **seconds until the window resets**. Note this is the single combined
`RateLimit` header of draft-7, not the older `X-RateLimit-*` triplet.

### Recommended polling interval

**Poll `GET /api/feed` every 5–10 seconds.**

| Interval | Polls/min | Left for `POST` | Detections/sec |
|---|---|---|---|
| 5 s | 12 | 288 | ~4.8 |
| **10 s (recommended)** | **6** | **294** | **~4.9** |
| 30 s | 2 | 298 | ~4.9 |

Polling faster than every 5 seconds is not useful: it consumes budget without
lowering latency in any way that matters for a barrier.

### Staying inside the budget

- **Use `has_more`, not a tighter interval,** to catch up after a backlog. It costs
  the same requests but clears far faster.
- **Batch nothing on `POST`** — one event per request is the contract. If a site
  exceeds ~4.5 detections/sec sustained, tell us and we will raise the limit for
  that deployment rather than have you drop events.
- **Back off on `429`.** Wait for `RateLimit-Reset` seconds, then resume from the
  cursor you already hold. Do not retry in a tight loop.
- **One IP, one budget.** If several cameras share an outbound NAT address, they
  share the 300/min. Tell us the expected camera count per site so the limit can be
  sized correctly.

### Other operational limits

| Limit | Value |
|---|---|
| Max request body | **15 MB** (`413` beyond it) |
| Max decoded image | **10 MB** per image |
| Server request timeout | **30 seconds** |
| Feed page size | 100 default, **1000 max** |

Base64 inflates a payload by roughly one third — a 10 MB JPEG is about 13.3 MB on
the wire. Two large images in one event will exceed the 15 MB body limit. Send one
image per event, or compress before encoding.

---

## 5. Scoping and `group_id`

Every project has its own `group_id` (for example `ACME_MALL_PARKING`) and its own
API key.

- A `pk_…` key **is** the project. `group_id` in a `POST` body is ignored; the key's
  project always wins.
- On `GET /api/feed`, a `pk_…` key needs no `group_id` — it already returns only that
  project. Naming a **different** project returns `403`, never a wider result.
- Every feed row carries its own `group_id`, so rows are self-identifying.

This is a hard boundary: a key leaked from one site cannot read or write another
customer's data.

---

## 6. Integration checklist

- [ ] API key stored in configuration, not in source
- [ ] `group_id` sent on every event
- [ ] Events with an unread plate are not posted — `vehicle_number` is required
- [ ] `device_unique_key` is a real UUID, stable per camera
- [ ] `transaction_id` unique per project and monotonically increasing
- [ ] `created_datetime` in ISO 8601 (UTC assumed when no offset is given)
- [ ] `409` treated as "already delivered", not as a failure
- [ ] Feed polled every 5–10 s, always with `cursor`
- [ ] `has_more: true` triggers an immediate re-poll
- [ ] `429` handled with a back-off that keeps the existing cursor
- [ ] Full resync (no cursor) once every 24 hours
- [ ] `requestId` logged on every non-2xx, for support

---

## 7. Quick test

```bash
KEY="pk_your_project_api_key"
BASE="http://<host>:5050"

# Post a detection
curl -X POST "$BASE/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "application_name": "ANPR",
    "application_id": 1,
    "device_name": "entry1",
    "device_unique_key": "3f9a1c22-7b6e-4d55-9f0a-2c8b41d7e610",
    "group_id": "ACME_MALL_PARKING",
    "cam_id": 101,
    "transaction_id": 1,
    "vehicle_number": "DL8CAF1234",
    "created_datetime": "2026-08-07T12:33:01.744613"
  }'

# Poll the registered-vehicle list
curl -s "$BASE/api/feed?limit=100" -H "Authorization: Bearer $KEY"

# Continue from a cursor
curl -s "$BASE/api/feed?cursor=<next_cursor>" -H "Authorization: Bearer $KEY"
```

Interactive API documentation, including every schema: **`<host>:5050/api-docs`**

---

*Questions or a limit that does not fit your deployment — contact the Prilinesha
team with the `requestId` of a representative request.*
