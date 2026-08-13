# Prilinesha ANPR ⇄ Intozi — API Specification for Sign-off

**Version:** 2.1 · **Date:** 11 August 2026 · **From:** Prilinesha backend team
**To:** Intozi backend team · **Purpose:** confirm the contract below, then freeze it.

> **Changed in 2.1 — please note before implementing**
> 1. `group_id` is now **mandatory** on `POST /api`.
> 2. `vehicle_number` is now **mandatory** on `POST /api`.
> 3. The `all_gates` field has been **removed** from the `GET /api/feed` rows.
>    `device_names` is now always the explicit, complete list of gates the pass
>    is valid at — the dashboard expands an operator's "all gates" selection
>    into the full gate list before storing it, so there is no wildcard to
>    interpret. The barrier rule is simpler as a result (see [§3.4](#34-the-barrier-decision-important)).

This document is the complete contract between the Intozi ANPR server and the
Prilinesha backend. It states exactly which fields are **mandatory**, which are
optional, and what the working flow is on both sides. Please review, mark the
open points in [§9](#9-points-to-confirm-sign-off), and return it — nothing on
our side changes after sign-off without a version bump.

There are exactly **two endpoints**.

| # | Endpoint | Direction | Called by | Frequency |
|---|---|---|---|---|
| **1** | `POST /api` | Intozi → Prilinesha | Camera/edge server | Once per detection |
| **2** | `GET /api/feed` | Intozi ← Prilinesha | Intozi server | Polled every 5–10 s |

---

## 1. Connection and authentication

| Item | Value |
|---|---|
| Base URL (production) | `https://backend-anpr.prilinesha.in` |
| Protocol | HTTPS, HTTP/1.1, JSON |
| Encoding | UTF-8 |
| Content type | `application/json` on `POST` |
| Auth header | `Authorization: Bearer <API_KEY>` — **required on every request** |
| Alternative header | `x-api-key: <API_KEY>` (accepted; `Authorization` preferred) |

### Two kinds of key — please use the right one in production

| Key form | Example | Scope | Status |
|---|---|---|---|
| **Project key** | `pk_a1b2c3…` | Bound to **one** project (`group_id`). Writes into it, reads only it. | **Use this in production** |
| Shared key | `ccd4ab67…` (64 hex chars) | Unscoped — writes to any project, reads every project's feed. | Legacy, test only |

> **Note on your current tests.** The key used in the sample calls
> (`ccd4ab67…`) is the **shared** key. That is why the feed response came back
> with `"group_id": null` and rows from two different projects
> (`ACME_MALL_PARKING` and `KM_APT`). With a `pk_…` key the response is scoped
> to that one project automatically. We will issue one `pk_…` key per site
> before go-live.

A project key is shown **once**, at project creation, and cannot be recovered —
only rotated. Store it in configuration, never in source control.

| Condition | Response |
|---|---|
| No key / wrong key | `401 UNAUTHORIZED` |
| Valid key, project deactivated | `403 FORBIDDEN` |

---

## 2. `POST /api` — submit a detection event

One request = one detection event. No batching.

```http
POST /api HTTP/1.1
Host: backend-anpr.prilinesha.in
Content-Type: application/json
Authorization: Bearer pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2.1 Mandatory fields — 9 in total

A request missing any of these — or sending it as `null` or `""` — is rejected
with `400`.

| Field | Type | Rule |
|---|---|---|
| `application_name` | string | 1–100 chars. e.g. `"Intozi ANPR"` |
| `application_id` | integer | ≥ 0 |
| `device_name` | string | 1–150 chars. **The gate name — must match the gate names configured on the Prilinesha dashboard**, because access rules are keyed on it (see [§3.4](#34-the-barrier-decision-important)) |
| `device_unique_key` | string | **Must be a valid UUID**, stable per camera |
| `group_id` | string | 2–50 chars of `A-Z 0-9 _ -`. Uppercased automatically. Every event names its site |
| `cam_id` | integer | ≥ 0 |
| `transaction_id` | integer | ≥ 0, **unique per project** (see [§2.5](#25-idempotency-and-retries)) |
| `vehicle_number` | string | 3–20 chars, `A-Z 0-9 -` only. Uppercased automatically |
| `created_datetime` | string | ISO 8601. **No offset ⇒ interpreted as UTC** |

> **On `group_id`:** it is mandatory, and a `pk_…` project key still overrides
> it — the key decides which project the event is written to, and this field is
> the sender stating which site it believes it is posting for. A key issued for
> one site can never write into another by sending a different `group_id`.

> **On `vehicle_number`:** an event with no plate cannot be matched against the
> registry, so it can never produce a barrier decision or a searchable log row.
> **If a camera fails to read a plate, do not post the event** — it will be
> rejected with `400`.

### 2.2 Optional fields

Omitted, `null` and `""` are all treated identically as "not supplied". An event
with no images is still accepted and stored.

| Field | Type | Rule |
|---|---|---|
| `latitude` | string | Numeric string, −90 … 90 |
| `longitude` | string | Numeric string, −180 … 180 |
| `vehicle_class` | string | `bus` \| `car` \| `bike` \| `truck` \| `auto` (lower-cased automatically) |
| `color` | string | `White` \| `Gray` \| `Yellow` \| `Red` \| `Green` \| `Blue` \| `Black` — **case-sensitive, exactly as listed** |
| `vehicle_type` | string | `registered` \| `unregistered` — **advisory only**, see [§2.3](#23-vehicle_type-in-the-request-is-not-authoritative) |
| `vehicle_model` | string | ≤ 100 chars |
| `owner_name` | string | ≤ 150 chars |
| `driver_name` | string | ≤ 150 chars |
| `contact_no` | string | 6–20 chars: digits, optional leading `+`, spaces/hyphens allowed |
| `email` | string | Valid email, ≤ 254 chars |
| `triple_riding` | boolean | `true`/`false`, or the strings `"true"`/`"false"` |
| `no_helmet` | boolean | as above |
| `no_seatbelt` | boolean | as above |
| `driver_on_call_status` | boolean | as above |
| `event_image` | string | Base64 JPG/PNG, ≤ 10 MB **decoded**. `data:image/...;base64,` prefix accepted |
| `plate_image` | string | Base64 JPG/PNG, ≤ 10 MB decoded |

Images are validated by magic bytes — only real JPG/PNG are stored.

### 2.3 `vehicle_type` in the request is **not** authoritative

Prilinesha looks the plate up in that project's registry and decides
`registered` / `unregistered` itself, judged against the registration's expiry
**at detection time** and against the gate the event came from. Send your best
guess if you have one; `data.vehicle_type` in the response is what was actually
recorded.

### 2.4 Success — `200 OK`

```json
{
  "success": true,
  "message": "ANPR event stored successfully.",
  "data": {
    "id": "6a74c91de374bd37706ab430",
    "group_id": "ACME_MALL_PARKING",
    "transaction_id": 987654327,
    "vehicle_number": "DL8CAF5678",
    "vehicle_type": "registered",
    "event_image_path": "/uploads/event-images/event_987654327_20260811T132015744Z_9f3c1a20.jpg",
    "plate_image_path": null
  },
  "requestId": "19dbb334-1dbf-4851-b352-7f786df0a8a4"
}
```

### 2.5 Idempotency and retries

`transaction_id` is unique **per project**. Re-sending the same one returns
`409` and creates nothing, so retrying after a network timeout is safe:

> **`409` means "already delivered". Log it and move on — do not escalate it as
> a failure and do not re-generate the event.**

Two different customers may both legitimately send `4471`; uniqueness is scoped
to the project, not global.

### 2.6 Errors

| Status | `code` | Cause | Intozi action |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | A field failed validation; `errors[]` names each one | Fix payload — do **not** retry unchanged |
| `401` | `UNAUTHORIZED` | Missing/invalid key | Alert, check config |
| `403` | `FORBIDDEN` | Project deactivated | Alert Prilinesha |
| `409` | `DUPLICATE_RESOURCE` | `transaction_id` already stored | Treat as success |
| `413` | `PAYLOAD_TOO_LARGE` | Body over 15 MB | Compress image, resend |
| `429` | `RATE_LIMIT_EXCEEDED` | Over budget | Back off, then retry |
| `500` | `INTERNAL_SERVER_ERROR` | Server fault | Retry with back-off |

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

**Please log `requestId` on every non-2xx.** It locates the exact request in our
logs and is the fastest path to a resolution.

---

## 3. `GET /api/feed` — poll the registered-vehicle list

Returns the vehicles the Prilinesha dashboard knows about and whether each is
currently registered.

> **This is the registry, not a detection log.** A vehicle appears here as soon
> as it is registered on the dashboard, whether or not a camera has ever seen
> it. It does not echo back the events you posted.

```http
GET /api/feed?limit=100 HTTP/1.1
Host: backend-anpr.prilinesha.in
Authorization: Bearer pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3.1 Query parameters — all optional

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string | — | `next_cursor` from the previous response. **The normal way to poll** |
| `limit` | integer | `100` | 1–1000 |
| `vehicle_type` | string | — | `registered` or `unregistered` |
| `since` | string | — | ISO 8601; rows changed strictly after this instant. Alternative to `cursor` |
| `group_id` | string | — | Only meaningful for the shared key. With a `pk_…` key, naming another project returns `403` |

### 3.2 Success — `200 OK`

```json
{
  "success": true,
  "message": "Vehicle feed fetched successfully.",
  "count": 3,
  "group_id": "ACME_MALL_PARKING",
  "next_cursor": "MjAyNi0wOC0wOVQxNzowNTowMi40ODhafDZhNzRkMmUyOWIwMDY3YTQzYTU3NGZlNg",
  "has_more": false,
  "data": [
    {
      "vehicle_number": "DL3CC9876",
      "group_id": "ACME_MALL_PARKING",
      "vehicle_type": "registered",
      "device_names": ["Entry_Gate_1", "Exit_Gate_1", "Entry_Gate_2", "Gate-12 Exit Camera"]
    },
    {
      "vehicle_number": "DL5CX1222",
      "group_id": "ACME_MALL_PARKING",
      "vehicle_type": "registered",
      "device_names": ["Entry_Gate_1", "Exit_Gate_1"]
    }
  ],
  "requestId": "9e57ea89-2cb0-4850-880f-57d9cba1e7ab"
}
```

### 3.3 Response fields

| Field | Meaning |
|---|---|
| `count` | Rows in `data` on this page |
| `group_id` | The project scope of this response. `null` on the shared key (rows then carry their own) |
| `next_cursor` | Send back as `cursor` on the next poll. Never `null` once you have polled once |
| `has_more` | `true` ⇒ more rows already waiting. **Poll again immediately, do not wait for the interval** |
| `data[].vehicle_number` | The plate, uppercased |
| `data[].group_id` | The project this vehicle is registered under |
| `data[].vehicle_type` | `registered` or `unregistered` |
| `data[].device_names` | **The complete, explicit list of gates this registration is valid at**, named exactly as the cameras report them |

Each row carries **exactly these four fields** — that is the frozen contract.
Owner names, phone numbers and emails stay on the Prilinesha side and are never
sent on the feed.

> **No wildcard, no flag to interpret.** When an operator picks "all gates" on
> the Prilinesha dashboard, we expand that into every active gate of the project
> **by name** before storing it. So `device_names` is always the literal set of
> gates — there is nothing to infer from an empty array, and no `all_gates`
> field on the feed.

### 3.4 The barrier decision — important

`vehicle_type` alone is **not** an open/close decision. A registration can be
limited to specific gates, so `registered` means "this pass is current", not
"valid everywhere".

```
allowed = (vehicle_type == "registered")
          and (device_name in device_names)
```

Match the gate name **case-insensitively**. Prilinesha applies the same rule
when stamping an incoming event, so both sides agree.

`vehicle_type` is computed at read time from the registration's expiry and its
dashboard on/off switch. A pass that lapsed a minute ago already reads
`unregistered` on the next poll — nothing has to be flipped by hand.

### 3.5 The polling loop — the flow that works

1. **First call:** no `cursor`. Returns the **oldest** page of the registry.
2. **Store `next_cursor`.**
3. **While `has_more == true`:** call again *immediately* with the new cursor.
   Repeat until `has_more == false` — you now hold the complete list.
4. **Every later call:** send the latest cursor. You receive only rows added or
   renewed since, each exactly once.
5. **On `429`/`5xx`:** keep the cursor you hold and retry after a delay. **Do
   not** drop back to no-cursor — that restarts the full sync from scratch.

```
GET /api/feed?limit=100            -> 100 rows, next_cursor=A, has_more=true
GET /api/feed?limit=100&cursor=A   -> 100 rows, next_cursor=B, has_more=true   (immediately)
GET /api/feed?limit=100&cursor=B   ->  12 rows, next_cursor=C, has_more=false  (full list held)
   ... wait 5-10 s ...
GET /api/feed?limit=100&cursor=C   ->   0 rows, next_cursor=C, has_more=false
   ... a vehicle is registered on the dashboard ...
GET /api/feed?limit=100&cursor=C   ->   1 row,  next_cursor=D, has_more=false
```

Three rules that catch most integrations:

> **The first call is a full sync, not a sample.** Keep paging while `has_more`
> is `true`. Stopping after one page leaves an incomplete list.

> **Renewals reappear.** An extended registration is re-sent with its new
> status — that is how you learn it changed. Treat a repeated `vehicle_number`
> as an **update** to what you hold, not a duplicate.

> **Do a full resync once every 24 h.** A registration that simply *expires*
> does not re-appear on a cursor poll, because nothing wrote to the row. Call
> once with no `cursor` (paging until `has_more == false`) daily and replace
> your cached list, so silently-expired plates are corrected.

An empty page is normal and returns the cursor unchanged, so you never have to
remember the last non-empty one.

### 3.6 Errors

| Status | `code` | Cause |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Bad `cursor`, `limit`, `since` or `vehicle_type` |
| `401` | `UNAUTHORIZED` | Missing or invalid key |
| `403` | `FORBIDDEN` | `group_id` names a project this key cannot read |
| `429` | `RATE_LIMIT_EXCEEDED` | Over the request budget |
| `500` | `INTERNAL_SERVER_ERROR` | Server fault — safe to retry |

---

## 4. End-to-end flow

```
  ┌──────────────┐                                   ┌────────────────────┐
  │ Intozi edge  │                                   │ Prilinesha backend │
  │  / camera    │                                   │                    │
  └──────┬───────┘                                   └─────────┬──────────┘
         │                                                     │
         │  A. Vehicle detected at gate                        │
         │─── POST /api  (9 mandatory fields + detail) ───────►│
         │                                                     │ look up plate in
         │                                                     │ this project's registry
         │                                                     │ → stamp registered /
         │                                                     │   unregistered
         │                                                     │ → store images
         │◄── 200 { data.vehicle_type = authoritative } ───────│
         │    (409 if this transaction_id already arrived)     │
         │                                                     │
         │  B. Every 5-10 s, independently of A                │
         │─── GET /api/feed?cursor=<last> ────────────────────►│
         │◄── 200 { data[], next_cursor, has_more } ───────────│
         │                                                     │
         │  cache locally →  allowed = registered AND           │
         │                   gate in device_names               │
         │  C. Barrier opens/closes from the local cache        │
         │     (works even if the network is momentarily down)  │
         │                                                     │
         │  D. Once per 24 h: full resync, no cursor            │
         │─── GET /api/feed  (page until has_more == false) ──►│
```

The two directions are **independent**. Posting an event never affects the feed,
and the feed never depends on events having been posted. The barrier should
decide from the locally cached feed, not from a live call, so a momentary
network problem does not block a gate.

---

## 5. Rate limits and operational limits

| | Value |
|---|---|
| Budget | **300 requests per 60 seconds** |
| Sustained rate | **5 requests/second** |
| Scope | **Per source IP, shared across both endpoints** |
| Over budget | `429` with `code: RATE_LIMIT_EXCEEDED` |

`POST /api` and `GET /api/feed` draw on the **same** budget — each poll is one
fewer detection you can post that minute.

IETF draft-7 rate-limit headers are on every response — read them rather than
counting requests yourself:

```
RateLimit: limit=300, remaining=247, reset=34
RateLimit-Policy: 300;w=60
```

`reset` is seconds until the window resets. Note this is the single combined
`RateLimit` header, not the older `X-RateLimit-*` triplet.

### Recommended interval

**Poll `GET /api/feed` every 5–10 seconds** (10 s recommended).

| Interval | Polls/min | Left for `POST` | Detections/sec |
|---|---|---|---|
| 5 s | 12 | 288 | ~4.8 |
| **10 s (recommended)** | **6** | **294** | **~4.9** |
| 30 s | 2 | 298 | ~4.9 |

Faster than 5 s consumes budget without reducing latency in any way that matters
for a barrier. Use `has_more` — not a tighter interval — to clear a backlog.

### Other limits

| Limit | Value |
|---|---|
| Max request body | **15 MB** (`413` beyond it) |
| Max decoded image | **10 MB** per image |
| Server request timeout | **30 seconds** |
| Feed page size | 100 default, **1000 max** |
| Gates per project | 50 max |

Base64 inflates a payload by ~⅓ — a 10 MB JPEG is ~13.3 MB on the wire, so
**two** large images in one event will breach the 15 MB body limit. Send one
image per event, or compress before encoding.

If a site exceeds ~4.5 detections/sec sustained, tell us the expected volume and
we will raise the limit for that deployment rather than have you drop events.
**One IP = one budget:** cameras behind a shared NAT share the 300/min.

---

## 6. Scoping and `group_id`

Every project has its own `group_id` (e.g. `ACME_MALL_PARKING`) and its own key.

- A `pk_…` key **is** the project. `group_id` in a `POST` body is ignored.
- On `GET /api/feed`, a `pk_…` key needs no `group_id` — it already returns only
  that project. Naming a **different** project returns `403`, never a wider
  result.
- Every feed row carries its own `group_id`, so rows are self-identifying.

This is a hard boundary: a key leaked from one site cannot read or write another
customer's data.

---

## 7. Working examples (production)

```bash
KEY="pk_your_project_api_key"
BASE="https://backend-anpr.prilinesha.in"

# --- 1. Post a detection (the 9 mandatory fields, nothing else) ---
curl -X POST "$BASE/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "application_name": "Intozi ANPR",
    "application_id": 11,
    "device_name": "Gate-12 Exit Camera",
    "device_unique_key": "7a2b3c4d-5e6f-4a71-9b82-3c4d5e6f7281",
    "group_id": "ACME_MALL_PARKING",
    "cam_id": 102,
    "transaction_id": 987654327,
    "vehicle_number": "DL8CAF5678",
    "created_datetime": "2026-08-11T13:20:15.744613"
  }'

# --- 2. Post a full detection ---
curl -X POST "$BASE/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "application_name": "Intozi ANPR",
    "application_id": 11,
    "device_name": "Gate-12 Exit Camera",
    "device_unique_key": "7a2b3c4d-5e6f-4a71-9b82-3c4d5e6f7281",
    "group_id": "ACME_MALL_PARKING",
    "latitude": "28.6145",
    "longitude": "77.2085",
    "cam_id": 102,
    "transaction_id": 987654328,
    "vehicle_number": "DL8CAF5678",
    "vehicle_class": "car",
    "color": "Black",
    "vehicle_type": "registered",
    "vehicle_model": "Hyundai Creta",
    "owner_name": "Amit Sharma",
    "driver_name": "Amit Sharma",
    "contact_no": "+919876543211",
    "email": "amit.sharma@example.com",
    "triple_riding": false,
    "no_helmet": false,
    "no_seatbelt": true,
    "driver_on_call_status": false,
    "event_image": "",
    "plate_image": "",
    "created_datetime": "2026-08-11T13:20:15.744613"
  }'

# --- 3. First feed call: no cursor, oldest page first ---
curl -s "$BASE/api/feed?limit=100" -H "Authorization: Bearer $KEY"

# --- 4. Continue from the cursor (repeat while has_more == true) ---
curl -s "$BASE/api/feed?limit=100&cursor=<next_cursor>" -H "Authorization: Bearer $KEY"

# --- 5. Only currently-registered vehicles ---
curl -s "$BASE/api/feed?vehicle_type=registered&limit=100" -H "Authorization: Bearer $KEY"
```

Interactive API documentation with every schema:
**`https://backend-anpr.prilinesha.in/api-docs`**
Health check: **`https://backend-anpr.prilinesha.in/health`**

---

## 8. Integration checklist

- [ ] `pk_…` project key issued per site and stored in configuration, not source
- [ ] All **9 mandatory** `POST` fields always present, never `null` or `""`
- [ ] `group_id` sent on every event
- [ ] Events with an unread plate are **not** posted (`vehicle_number` is mandatory)
- [ ] `device_unique_key` is a real UUID, stable per camera
- [ ] `device_name` matches the gate names configured on the Prilinesha dashboard
- [ ] `transaction_id` unique per project, monotonically increasing
- [ ] `created_datetime` ISO 8601 (UTC assumed when no offset)
- [ ] `409` treated as "already delivered", not a failure
- [ ] Response `data.vehicle_type` used as authoritative, not the value sent
- [ ] Feed polled every 5–10 s, always with `cursor`
- [ ] `has_more == true` triggers an immediate re-poll
- [ ] Barrier rule = `registered` **AND** gate in `device_names` (no `all_gates` field)
- [ ] `429` handled with back-off that **keeps** the existing cursor
- [ ] Full resync (no cursor) once every 24 hours
- [ ] `requestId` logged on every non-2xx for support

---

## 9. Points to confirm (sign-off)

Please confirm or amend each, and return this document.

| # | Point | Prilinesha proposal | Intozi confirms |
|---|---|---|---|
| 1 | Gate naming | `device_name` values are fixed per site and identical to the dashboard's gate names | ☐ |
| 2 | `group_id` mandatory | Intozi sends `group_id` on **every** event, configured per site | ☐ |
| 3 | `vehicle_number` mandatory | Intozi does **not** post events where the plate could not be read | ☐ |
| 4 | `transaction_id` generation | Unique per project, monotonically increasing, stable across retries | ☐ |
| 5 | Timestamp | ISO 8601; naive values treated as **UTC**. Confirm cameras send UTC, or add an offset | ☐ |
| 6 | Images | One image per event; `event_image` and `plate_image` both base64 JPG/PNG ≤ 10 MB | ☐ |
| 7 | Expected volume | Peak detections/second **per site** and camera count per outbound IP → so the 300/min limit can be sized | ☐ |
| 8 | Poll interval | 10 s, cursor-based, plus a daily full resync | ☐ |
| 9 | Barrier rule | `registered` AND gate in `device_names`, matched case-insensitively. No `all_gates` field | ☐ |
| 10 | Feed row shape | The four disclosed fields are sufficient — no owner/contact data required on the feed | ☐ |
| 11 | Key type | Production uses `pk_…` project keys; the shared 64-hex key is test-only and will be retired | ☐ |
| 12 | Error handling | `409` = success, `400` = do not retry unchanged, `429`/`5xx` = retry with back-off keeping the cursor | ☐ |

**Anything not fitting your deployment — reply with the point number and the
`requestId` of a representative request, and we will adjust before freeze.**

---

*Prilinesha ANPR backend · spec v2.1 · questions to the Prilinesha backend team.*
