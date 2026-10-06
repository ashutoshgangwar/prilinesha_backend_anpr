# Prilinesha ANPR — Intozi Integration Guide

Everything the Intozi server needs to integrate with the Prilinesha ANPR backend,
and everything Prilinesha needs to keep Intozi's **Ikshana watchlist** in step.

The integration now runs in two directions, and the registry is no longer polled:

| | Flow | Direction | Trigger |
|---|---|---|---|
| **1** | `POST /api` — detection events | Camera/Intozi → Prilinesha | Every vehicle detection |
| **2** | Ikshana watchlist sync | Prilinesha → Intozi | Every registry change, as it happens |

Flow 2 replaces the old `GET /api/feed` pull. Instead of Intozi polling Prilinesha
for the registered-vehicle list, Prilinesha **pushes** each add / update / delete /
expiry to Intozi's `manage_watchlist_anpr_app_db_data` API the moment it occurs, so
Ikshana holds exactly the vehicles that are currently registered. See
[Section 3](#3-ikshana-watchlist-sync-prilinesha--intozi).

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
| `application_id` | integer | ≥ 0 |
| `device_name` | string | 1–150 characters. Identifies the gate |
| `device_unique_key` | string | **Must be a valid UUID** |
| `group_id` | string | 2–50 chars `A-Z 0-9 _ -`, uppercased automatically. A `pk_…` key still overrides it — the key decides the project, this states the sender's intent |
| `cam_id` | integer | ≥ 0 |
| `transaction_id` | integer | ≥ 0. **Must be unique per project** — see [Idempotency](#idempotency-and-retries) |
| `vehicle_number` | string | 3–20 chars, `A-Z 0-9 -` only. Uppercased automatically. An event with no plate cannot be matched against the registry, so do not post one |
| `vehicle_type` | string | `registered` \| `unregistered`, case-insensitive — **advisory only**, see below |
| `created_datetime` | string | ISO 8601. No offset is interpreted as **UTC** |

#### Optional

| Field | Type | Rule |
|---|---|---|
| `latitude` | string | Numeric string, −90 to 90 |
| `longitude` | string | Numeric string, −180 to 180 |
| `application_name` | string | ≤ 100 characters. Defaults to `ANPR` when omitted |
| `vehicle_class` | string | `bus` \| `car` \| `bike` \| `truck` \| `auto` — the body type, **not** the registration status |
| `color` | string | `White` \| `Gray` \| `Yellow` \| `Red` \| `Green` \| `Blue` \| `Black` (case-sensitive) |
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

### Accepted key aliases

Senders that already name these fields differently do not have to rename anything:
the following keys are accepted and translated on arrival, so both spellings work.

| Key you send | Stored as | Returned to you as | Meaning |
|---|---|---|---|
| `plate`, `plate_number`, `license_plate` | `vehicle_number` | the key you sent | Licence plate number |
| `vehicle_category`, `vehicle_status` | `vehicle_type` | the key you sent | `registered` / `unregistered`, any casing |
| `frame` | `event_image` | `frame_path` | Full-frame image, base64 |
| `plate_roi` | `plate_image` | `plate_roi_path` | Cropped plate image, base64 |
| `vehicle_class` | `vehicle_class` | — | Body type — `car`, `bus`, `bike`, `truck`, `auto` |
| `group_id` | `group_id` | `group_id` | Project identifier, uppercased on arrival |

Rules:

- **The canonical name wins.** If a request carries both `vehicle_number` and
  `plate`, the value of `vehicle_number` is stored and `plate` is ignored.
- **`vehicle_class` is not `vehicle_type`.** `vehicle_class` is what kind of
  vehicle it is (`car`); `vehicle_type` is whether the plate is registered at
  this site. They are two different fields and both may be sent.
- **`frame` / `plate_roi` that are not base64 image data are ignored, not
  rejected.** A sentinel value such as `"No frame found"` is treated exactly
  like an omitted image, and the event is still stored.
- Keys this API does not model — `plate_box`, `vehicle_box`, `video_gif_data` —
  are accepted and discarded. Sending them is harmless; they are not stored and
  not returned.
- **The response speaks your vocabulary.** Each field is named back the way you
  named it, so a sender that posts `plate` reads `plate` in the response and
  never has to learn the canonical name. An image field gains a `_path` suffix,
  because what comes back is where the image was stored, not the image. The
  values are identical either way, and a sender that posts the canonical names
  gets a response identical to the one it has always received.
- Field names are per field, not per request: post `vehicle_number` alongside
  `vehicle_category` and the response carries exactly those two names.

A payload in the vendor's own vocabulary is therefore accepted as-is:

```json
{
  "application_id": 92,
  "cam_id": 5,
  "plate": "NL07CA4869",
  "plate_box": [279, 268, 309, 294],
  "vehicle_box": [],
  "vehicle_class": "car",
  "transaction_id": 22,
  "created_datetime": "2026-09-09T14:25:05.689572",
  "vehicle_category": "Unregistered",
  "device_name": "cam4",
  "device_unique_key": "97c81c46-2e6b-4ae5-ba9a-44cdae3ff707",
  "group_id": "Intozi_Group_1",
  "latitude": "45",
  "longitude": "32",
  "video_gif_data": "No video GIF found",
  "frame": "<base64 jpg/png>",
  "plate_roi": "<base64 jpg/png>"
}
```

It is stored as `vehicle_number: "NL07CA4869"`, `vehicle_class: "car"`,
`vehicle_type: "unregistered"` (unless the plate is on the project's registry,
which wins), `group_id: "INTOZI_GROUP_1"` and `application_name: "ANPR"`.

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

The same event posted in the vendor vocabulary is answered in that vocabulary —
same values, your field names:

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6aa3a8db2c9af862ae6477f1",
    "group_id": "INTOZI_GROUP_1",
    "transaction_id": 22,
    "plate": "NL07CA4869",
    "vehicle_category": "unregistered",
    "frame_path": "uploads/event-images/event_22_20260909T142505689Z_1c7c4497.jpg",
    "plate_roi_path": "uploads/plate-images/plate_22_20260909T142505689Z_e73d36eb.jpg"
  },
  "requestId": "18889a86-c861-4515-ab26-f91c951dd73f"
}
```

`vehicle_category` comes back lower-cased (`unregistered`, not `Unregistered`) —
that is the stored value. `frame_path` / `plate_roi_path` are `null` when no
decodable image was sent.

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

## 3. Ikshana watchlist sync (Prilinesha → Intozi)

Prilinesha keeps Ikshana's watchlist in step by calling Intozi's
`manage_watchlist_anpr_app_db_data` API whenever a registration changes. There is
nothing for Intozi to poll and no cursor to manage — the push happens inside the
dashboard action (or the expiry sweep) that caused the change.

### Direction of the rule

The watchlist holds exactly the vehicles that are **currently registered** at a
site. Every change is resolved to that one rule:

| Dashboard action | Resulting state | Call to Intozi |
|---|---|---|
| Register a new vehicle | registered | `POST` add — stores the returned `anpr_wl_id` |
| Renew / edit a registered vehicle | registered | `PUT` update (by `anpr_wl_id`) |
| Deactivate (suspend) | unregistered | `DELETE` (by `data_id`) |
| Expiry (`valid_till` passes) | unregistered | `DELETE`, published by the sweeper |
| Delete the registration | gone | `DELETE` |

A vehicle that should be allowed in is present on the watchlist (added, or updated
if already there); a vehicle that should not is absent.

### Authentication

Every call carries the `x-api-key` header issued by Intozi:

```
x-api-key: <INTOZI_API_KEY>
```

### Field mapping

| Prilinesha registry | Intozi watchlist field |
|---|---|
| `vehicle_number` | `vehicle_number` |
| *(config)* `INTOZI_DEFAULT_VEHICLE_CATEGORY` | `vehicle_category_name` (required integer) |
| `name` | `person_name` |
| `phone_number` | `mobile_number` |
| `vehicle_model` | `make_model` |
| `unit_number` | `remarks` |
| `device_names` (array) | custom field `field_id 1` (device_name), a JSON-array string |
| `group_id` | custom field `field_id 2` (group_id) |

`device_names` is serialised as a stringified array, e.g. `["entry1","exit1"]`
(empty — "every gate" on our side — becomes `"[]"`). The two custom-field ids
(`field_id 1` = device_name, `field_id 2` = group_id) are configurable in case a
particular Ikshana instance numbers them differently.

> **The custom-field `group_id` is independent** of the ANPR watchlist database
> group's own `group_id`, exactly as the Ikshana document states. Prilinesha sends
> its project `group_id` as the `field_id 2` custom-field value only.

### Add (POST)

```json
{
  "vehicle_number": "KA01MN7823",
  "vehicle_category_name": 1,
  "person_name": "Rohit Sharma",
  "mobile_number": "9123456780",
  "make_model": "Toyota Fortuner",
  "remarks": "A-402",
  "custom_field_data": [
    { "field_id": 1, "custom_field_value": "[\"Camera10\",\"Camera12\"]" },
    { "field_id": 2, "custom_field_value": "DLF_PARKING" }
  ]
}
```

The response's `id` is stored on the registration as `anpr_wl_id`, and each
`custom_fields[].id` is stored as the `field_data_id` for that field — both are
needed to update the record in place later.

### Update (PUT)

```json
{
  "anpr_wl_id": 21,
  "vehicle_category_name": 1,
  "person_name": "Rohit Sharma",
  "mobile_number": "9123456780",
  "make_model": "Toyota Fortuner",
  "remarks": "A-402",
  "image_updated": 0,
  "custom_field_data": [
    { "field_id": 1, "custom_field_value": "[\"Camera14\"]", "field_data_id": 25 },
    { "field_id": 2, "custom_field_value": "DLF_PARKING", "field_data_id": 26 }
  ]
}
```

If a registration was created before its ids were captured, the `field_data_id`
is omitted and Ikshana treats the field as new.

### Delete (DELETE)

```json
{ "data_id": [21] }
```

The sweeper removes a whole batch of just-expired vehicles in one call by passing
several ids.

### Reliability

The push is **best-effort and never blocks the dashboard.** A registration is
committed to Prilinesha's own database first; the Intozi call then runs, and if
Intozi is slow, down, or rejects the request, the dashboard action still succeeds
and the row is marked `intozi.sync_status = "failed"` with the error, for a later
reconcile. Each call has a hard timeout (`INTOZI_TIMEOUT_MS`). A duplicate delete
(removing a plate Ikshana has already dropped) is harmless, which is why a crash
mid-sweep costs at most a repeated instruction, never a silent hole.

### Configuration

Set these in the Prilinesha environment (`.env`). Sync is **off** until
`INTOZI_SYNC_ENABLED=true`, at which point a base URL and key are required:

| Variable | Meaning |
|---|---|
| `INTOZI_SYNC_ENABLED` | Master switch (`true`/`false`). Off = every push is a no-op |
| `INTOZI_BASE_URL` | Ikshana base URL; the watchlist paths are appended to it |
| `INTOZI_API_KEY` | Value sent as `x-api-key` |
| `INTOZI_TIMEOUT_MS` | Per-request timeout (default 10000) |
| `INTOZI_DEFAULT_VEHICLE_CATEGORY` | Integer `vehicle_category_name` for every pushed vehicle (default 1) |
| `INTOZI_FIELD_ID_DEVICE_NAME` | Custom field id for the gate list (default 1) |
| `INTOZI_FIELD_ID_GROUP_ID` | Custom field id for the group id (default 2) |

> **Scope note.** This push covers the **registered-vehicle registry**. Visitor
> passes still record to Prilinesha's internal change log but are not pushed to the
> Ikshana watchlist; they can be added later over the same client if required.

---

## 4. Rate limits

### The limit (on `POST /api`)

| | Value |
|---|---|
| Budget | **300 requests per 60 seconds** |
| Sustained rate | **5 requests per second** |
| Scope | **Per source IP** |
| Response when exceeded | `429` with `code: RATE_LIMIT_EXCEEDED` |

With the registry no longer polled, this budget is effectively all for detections.

Standard rate-limit headers (IETF draft-7) are on every response — read them rather
than counting requests yourself:

```
RateLimit: limit=300, remaining=247, reset=34
RateLimit-Policy: 300;w=60
```

`reset` is **seconds until the window resets**. Note this is the single combined
`RateLimit` header of draft-7, not the older `X-RateLimit-*` triplet.

### Staying inside the budget

- **Batch nothing on `POST`** — one event per request is the contract. If a site
  exceeds ~4.5 detections/sec sustained, tell us and we will raise the limit for
  that deployment rather than have you drop events.
- **Back off on `429`.** Wait for `RateLimit-Reset` seconds, then retry. Do not
  retry in a tight loop.
- **One IP, one budget.** If several cameras share an outbound NAT address, they
  share the 300/min. Tell us the expected camera count per site so the limit can be
  sized correctly.

### Other operational limits

| Limit | Value |
|---|---|
| Max request body | **15 MB** (`413` beyond it) |
| Max decoded image | **10 MB** per image |
| Server request timeout | **30 seconds** |

Base64 inflates a payload by roughly one third — a 10 MB JPEG is about 13.3 MB on
the wire. Two large images in one event will exceed the 15 MB body limit. Send one
image per event, or compress before encoding.

---

## 5. Scoping and `group_id`

Every project has its own `group_id` (for example `ACME_MALL_PARKING`) and its own
API key.

- A `pk_…` key **is** the project. `group_id` in a `POST` body is ignored; the key's
  project always wins.
- Each project's registry is pushed to Ikshana under its own `group_id` (sent as the
  `field_id 2` custom-field value), so vehicles stay partitioned by site on Intozi's
  side too.

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
- [ ] `429` handled with a back-off (not a tight retry loop)
- [ ] `requestId` logged on every non-2xx, for support

On the Prilinesha side, for the watchlist push (Section 3):

- [ ] `INTOZI_BASE_URL` and `INTOZI_API_KEY` set, `INTOZI_SYNC_ENABLED=true`
- [ ] `INTOZI_DEFAULT_VEHICLE_CATEGORY` confirmed with Intozi for the site
- [ ] `intozi.sync_status = "failed"` rows monitored for reconcile

---

## 7. Quick test

Every command below was run against a live server; the responses are the real
output. Set the two variables and paste.

```bash
KEY="pk_your_project_api_key"
BASE="http://<host>:5050"
```

### 1. Is the service up?

```bash
curl -s "$BASE/health"
# {"status":"UP"}
```

### 2. Post a detection — vendor vocabulary

```bash
curl -s -X POST "$BASE/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "application_id": 92,
    "cam_id": 5,
    "plate": "NL07CA4869",
    "plate_box": [279, 268, 309, 294],
    "vehicle_box": [],
    "vehicle_class": "car",
    "transaction_id": 9001,
    "created_datetime": "2026-09-09T14:25:05.689572",
    "vehicle_category": "Unregistered",
    "device_name": "cam4",
    "device_unique_key": "97c81c46-2e6b-4ae5-ba9a-44cdae3ff707",
    "group_id": "Intozi_Group_1",
    "latitude": "45",
    "longitude": "32",
    "video_gif_data": "No video GIF found",
    "frame": "<base64 jpg/png, or any placeholder>",
    "plate_roi": "<base64 jpg/png, or any placeholder>"
  }'
```

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6aa3a9db5acb16fbbc7560d2",
    "group_id": "INTOZI_GROUP_1",
    "transaction_id": 9001,
    "plate": "NL07CA4869",
    "vehicle_category": "unregistered",
    "frame_path": null,
    "plate_roi_path": null
  },
  "requestId": "58caa513-a597-43ac-af36-40f9dc1e344c"
}
```

`frame_path` / `plate_roi_path` are `null` above because the images were
placeholders. Send real base64 and they carry the stored path.

Re-run the same command unchanged and it returns **409** —
`transaction_id 9001` is already stored. Bump `transaction_id` for each new
event.

### 3. Post a detection — canonical vocabulary

Identical result, canonical names in and out:

```bash
curl -s -X POST "$BASE/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "application_name": "ANPR",
    "application_id": 1,
    "device_name": "cam4",
    "device_unique_key": "3f9a1c22-7b6e-4d55-9f0a-2c8b41d7e610",
    "group_id": "ACME_MALL_PARKING",
    "cam_id": 101,
    "transaction_id": 9002,
    "vehicle_number": "DL8CAF1234",
    "vehicle_class": "car",
    "vehicle_type": "registered",
    "created_datetime": "2026-08-07T12:33:01.744613"
  }'
```

### 4. Watch the watchlist push happen

The registry push is server-to-server (Prilinesha → Intozi), so there is no
endpoint on Prilinesha to curl for it. Register a vehicle from the dashboard and
confirm it landed on Ikshana with Intozi's own read API:

```bash
# Register from the dashboard (JWT-authenticated), then read it back on Intozi:
curl -s -X POST "$INTOZI_BASE/get_watchlist_anpr_app_db_data" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $INTOZI_API_KEY" \
  -d '{"page":"1","page_size":"12"}'
# -> the vehicle appears in data[], with custom_fields for device_name and group_id
```

Deactivate, let expire, or delete the same vehicle on the dashboard and read again:
it is gone from the watchlist.

### Failure cases worth testing once

```bash
# No API key -> 401 UNAUTHORIZED
curl -s -X POST "$BASE/api" -H "Content-Type: application/json" -d '{}'

# Missing plate and status -> 400 VALIDATION_ERROR, naming both spellings
curl -s -X POST "$BASE/api" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"application_id":92,"cam_id":5,"transaction_id":9003,"device_name":"cam4",
       "device_unique_key":"97c81c46-2e6b-4ae5-ba9a-44cdae3ff707",
       "group_id":"Intozi_Group_1","created_datetime":"2026-09-09T14:25:05.689572"}'
# errors: [{"field":"vehicle_number","message":"vehicle_number (or plate) is required."},
#          {"field":"vehicle_type","message":"vehicle_type (or vehicle_category) is required."}]
```

Interactive API documentation, including every schema: **`<host>:5050/api-docs`**

---

*Questions or a limit that does not fit your deployment — contact the Prilinesha
team with the `requestId` of a representative request.*
