const {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_MAX_LIMIT,
  LIST_MAX_LIMIT,
  ROLE_VALUES,
  PERMISSIONS,
} = require('../utils/constants');

const { authPaths, projectPaths, userPaths, logPaths } = require('./swaggerAuthPaths');
const { authSchemas } = require('./swaggerAuthSchemas');
const { analyticsPaths, analyticsSchemas } = require('./swaggerAnalyticsPaths');

/** OpenAPI 3.0 description of the public surface, served at /api-docs. */
/** The `{id}` path parameter shared by the single-registration routes. */
const vehicleIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', example: '6a7378aa86d8e0aa080d4f96' },
  description: 'The registration id returned by POST or GET /api/vehicles.',
};

const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Prilinesha ANPR Ingestion API',
    version: '3.0.0',
    description: [
      'Receives ANPR (Automatic Number Plate Recognition) detection events from cameras,',
      'stores the base64 event/plate images on disk and persists the event metadata in MongoDB.',
      '',
      '## Tenancy',
      '',
      'Everything is scoped to a **project**, identified by its `group_id` — the value the',
      'customer configures in Intozi and that arrives on every event. A project owns its gates',
      '(`device_name`: entry1, exit1, exit2 …), its registered vehicles and its detection events.',
      '',
      '## Two ways to authenticate',
      '',
      '| Caller | Credential | Scope |',
      '| --- | --- | --- |',
      '| Dashboard user | `Authorization: Bearer <JWT>` from `/api/auth/login` | `super_admin`: every project. `admin`: only assigned projects. |',
      '| Intozi / camera | `Authorization: Bearer pk_…` (per-project API key) | Exactly one project. |',
      '| Legacy camera | `Authorization: Bearer <API_KEY>` (shared secret) | Unscoped — every project. |',
      '',
      '## Roles',
      '',
      '- **super_admin** — internal Prilinesha staff. Creates projects, issues API keys, creates',
      '  users and grants them project access. Holds every permission.',
      '- **admin** — the customer\'s operator. Sees and manages only the projects assigned to them.',
      '',
      'Routes check *permissions*, not roles, so a new capability is one entry in',
      '`ROLE_PERMISSIONS` (utils/constants.js) rather than a new role.',
      '',
      '## Typical setup',
      '',
      '1. Super admin logs in (`POST /api/auth/login`).',
      '2. Creates the project with its gates (`POST /api/projects`) → returns the Intozi `api_key` **once**.',
      '3. Customer signs up (`POST /api/auth/signup`) — an account with no data access yet.',
      '4. Super admin assigns them the project (`PUT /api/users/{id}/projects`) — access is live immediately.',
      '5. Customer registers vehicles (`POST /api/vehicles`).',
      '6. Intozi posts events (`POST /api/anpr`) and polls the feed (`GET /api/anpr/feed`).',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'Auth', description: 'Signup, login and the caller’s own account' },
    { name: 'Projects', description: 'Projects (group_id) and their gates (device_name)' },
    { name: 'Users', description: 'Dashboard user administration — super admin only' },
    { name: 'Vehicles', description: 'Registered-vehicle registry, scoped per project' },
    { name: 'Logs', description: 'Detection log for the internal dashboard, scoped to the caller' },
    {
      name: 'Analytics',
      description: 'Registry totals and entry/exit counts over time — the dashboard tiles and charts',
    },
    { name: 'ANPR', description: 'Event ingestion and the Intozi polling feed' },
    { name: 'System', description: 'Health probes' },
  ],
  components: {
    securitySchemes: {
      // Dashboard users.
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Dashboard access token from `POST /api/auth/login`. Sent as `Authorization: Bearer <token>`.',
      },
      // Cameras / Intozi.
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description:
          'Per-project key issued by `POST /api/projects` (`Bearer pk_…`), which scopes the request ' +
          'to that project, or the legacy shared `API_KEY`, which is unscoped. Both are also ' +
          'accepted raw or via the `x-api-key` header.',
      },
    },
    schemas: {
      ...authSchemas({ ROLE_VALUES, PERMISSIONS, LIST_MAX_LIMIT }),
      ...analyticsSchemas,
      AnprEvent: {
        type: 'object',
        required: [
          'application_name',
          'application_id',
          'device_name',
          'device_unique_key',
          'group_id',
          'cam_id',
          'transaction_id',
          'vehicle_number',
          'vehicle_type',
          'created_datetime',
        ],
        properties: {
          application_name: { type: 'string', maxLength: 100, example: 'ANPR' },
          application_id: { type: 'integer', minimum: 0, example: 1 },
          device_name: { type: 'string', maxLength: 150, example: 'Intozi Camera 1' },
          device_unique_key: {
            type: 'string',
            format: 'uuid',
            example: 'de21ba00-c4e2-474c-9106-b3bcc50e735f',
          },
          group_id: {
            type: 'string',
            description:
              'The project this event belongs to. Required. A per-project `pk_…` key still ' +
              'overrides it — the key decides the scope, this field states the sender’s intent.',
            example: 'ACME_MALL_PARKING',
          },
          latitude: { type: 'string', nullable: true, example: '12' },
          longitude: { type: 'string', nullable: true, example: '14' },
          cam_id: { type: 'integer', minimum: 0, example: 3 },
          transaction_id: {
            type: 'integer',
            minimum: 0,
            example: 108,
            description: 'Unique per event. Re-sending one returns 409.',
          },
          color: { type: 'string', nullable: true, enum: VEHICLE_COLORS, example: 'White' },
          event_image: {
            type: 'string',
            nullable: true,
            description: 'Optional. Base64 JPG/PNG, with or without a data-URI prefix.',
            example: '/9j/4AAQSkZJRgABAQAAAQABAAD...',
          },
          vehicle_number: {
            type: 'string',
            minLength: 3,
            maxLength: 20,
            description:
              'Required. Letters, digits and hyphens only; uppercased on the way in. An event ' +
              'with no plate cannot be matched against the registry, so it is rejected rather ' +
              'than stored.',
            example: 'UP32AB1234',
          },
          vehicle_type: {
            type: 'string',
            enum: VEHICLE_TYPES,
            description:
              'Required. The status the camera believes the plate has. Advisory only: a plate ' +
              'found on this project’s registry is stamped from the registry instead, and this ' +
              'value is used only when the plate is unknown there.',
            example: 'registered',
          },
          vehicle_model: { type: 'string', nullable: true, maxLength: 100, example: 'Swift VXI' },
          owner_name: { type: 'string', nullable: true, maxLength: 150, example: 'Ramesh Kumar' },
          contact_no: { type: 'string', nullable: true, example: '+91 9876543210' },
          email: { type: 'string', format: 'email', nullable: true, example: 'owner@example.com' },
          driver_name: { type: 'string', nullable: true, maxLength: 150, example: 'Suresh Yadav' },
          triple_riding: { type: 'boolean', default: false },
          vehicle_class: { type: 'string', nullable: true, enum: VEHICLE_CLASSES, example: 'car' },
          no_helmet: { type: 'boolean', default: false },
          plate_image: {
            type: 'string',
            nullable: true,
            description: 'Optional. Base64 JPG/PNG, with or without a data-URI prefix.',
            example: '/9j/4AAQSkZJRgABAQAAAQABAAD...',
          },
          no_seatbelt: { type: 'boolean', default: false },
          driver_on_call_status: { type: 'boolean', default: false },
          created_datetime: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601. A value without an offset is interpreted as UTC.',
            example: '2025-12-22T12:33:01.744613',
          },
        },
      },
      AnprEventStored: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'ANPR event stored successfully.' },
          data: {
            type: 'object',
            properties: {
              id: { type: 'string', example: '6789ab01c2d3e4f567890123' },
              group_id: {
                type: 'string',
                nullable: true,
                description:
                  'The project the event was filed under — taken from the API key, not the body. ' +
                  'null only for the legacy unscoped API_KEY.',
                example: 'ACME_MALL',
              },
              transaction_id: { type: 'integer', example: 108 },
              vehicle_number: { type: 'string', nullable: true, example: 'MH12AB1234' },
              vehicle_type: {
                type: 'string',
                enum: VEHICLE_TYPES,
                description:
                  'Resolved against this project’s registry at detection time — not taken from ' +
                  'the camera when the plate is known.',
                example: 'registered',
              },
              event_image_path: { type: 'string', example: 'uploads/event-images/event_108_20251222T123301844Z_9f3c1a20.jpg' },
              plate_image_path: { type: 'string', example: 'uploads/plate-images/plate_108_20251222T123301851Z_1b7de904.jpg' },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      VehicleFeedRecord: {
        type: 'object',
        description:
          'One registered vehicle on the Intozi feed. Only the fields below are disclosed; the ' +
          'owner name and phone number on the underlying record stay internal.',
        properties: {
          vehicle_number: { type: 'string', nullable: true, example: 'UP32AB1234' },
          group_id: {
            type: 'string',
            nullable: true,
            description:
              'The project this vehicle is registered under. Per-row, because the legacy global ' +
              'key reads across every project; with a per-project key it is the same on every row.',
            example: 'ACME_MALL_PARKING',
          },
          vehicle_type: {
            type: 'string',
            enum: VEHICLE_TYPES,
            description:
              'Derived from `valid_till` and the manual switch at read time — `unregistered` once ' +
              'the registration has expired or has been switched off. Never stored, so it cannot ' +
              'go stale.\n\n' +
              '**Not a barrier decision on its own** — read it together with `device_names`.',
            example: 'registered',
          },
          device_names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The gates this registration is good for, as configured on the project. A vehicle ' +
              'that is `registered` but whose list does not name the gate it just arrived at must ' +
              'be treated as unregistered there — that is the whole reason the list is on the ' +
              'feed.\n\n' +
              'The list is explicit: when an operator picks "all gates" on the dashboard it is ' +
              'expanded to every active gate by name before it is stored, so this is the complete ' +
              'set of gates the pass is good at — not a restriction read against a wildcard.',
            example: ['Netru Pro Entry', 'exit1'],
          },
        },
      },
      VehicleFeedResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Vehicle feed fetched successfully.' },
          count: { type: 'integer', example: 2 },
          next_cursor: {
            type: 'string',
            nullable: true,
            description: 'Send this back as `cursor` on the next poll to receive only newer events.',
            example: 'MjAyNS0xMi0yMlQxMjozMzowMS44NDRafDY3ODlhYjAxYzJkM2U0ZjU2Nzg5MDEyMw',
          },
          has_more: {
            type: 'boolean',
            description: 'true when more events are already waiting — poll again immediately instead of sleeping.',
            example: false,
          },
          data: { type: 'array', items: { $ref: '#/components/schemas/VehicleFeedRecord' } },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      RegisterVehicle: {
        type: 'object',
        required: ['vehicle_number', 'name', 'phone_number', 'valid_till'],
        properties: {
          group_id: {
            type: 'string',
            description:
              'The project to register the vehicle in. Optional for a user assigned to exactly ' +
              'one project — theirs is used. Required for anyone with access to several.',
            example: 'ACME_MALL',
          },
          vehicle_number: {
            type: 'string',
            minLength: 3,
            maxLength: 20,
            description:
              'Stored uppercase. Re-sending an existing plate in the same project renews it ' +
              'instead of creating a duplicate; the same plate in another project is separate.',
            example: 'MH12AB1234',
          },
          name: { type: 'string', maxLength: 150, example: 'Ramesh Kumar' },
          phone_number: { type: 'string', example: '+91 9876543210' },
          vehicle_model: {
            type: 'string',
            nullable: true,
            maxLength: 100,
            description:
              'Optional. Make and model as the operator types it — free text, because it is a ' +
              'note that helps somebody recognise the vehicle at the gate and nothing branches ' +
              'on it.\n\n' +
              'Surfaces on `GET /api/logs` as `vehicle_model` whenever the camera did not report ' +
              'one itself. Omitting it on a **renewal** keeps whatever model is already recorded, ' +
              'rather than clearing it.',
            example: 'Swift Dzire',
          },
          valid_till: {
            type: 'string',
            description:
              'Date (YYYY-MM-DD) or ISO 8601 datetime. A plain date covers the whole day — it is ' +
              'stored as 23:59:59.999 UTC. Once it passes, every later detection of this plate is ' +
              'reported to Intozi as "unregistered".',
            example: '2027-03-31',
          },
          device_names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restricts the registration to specific gates. Pick them from ' +
              '`GET /api/projects/{group_id}/devices` — every name is checked against that ' +
              'project, matched case-insensitively and stored with the project\'s own casing, so ' +
              'a gate that does not exist is a 400 rather than a restriction no camera can ever ' +
              'satisfy.\n\n' +
              'Empty or omitted means every gate in the project, which is the normal case. At a ' +
              'gate not on the list, the vehicle is reported as unregistered.',
            example: ['entry1', 'exit1'],
          },
          all_devices: {
            type: 'boolean',
            description:
              '"All gates", as an explicit choice on the form. Stores **every active gate of the ' +
              'project by name**, so the record states what was granted instead of leaving it ' +
              'implied. Takes precedence over `device_names` when both are sent.\n\n' +
              'It differs from an empty `device_names` in one way that matters: an expanded list ' +
              'is a snapshot, so a gate added to the project later is *not* covered until the ' +
              'vehicle is saved again, while an empty list follows the project automatically.',
            example: true,
          },
        },
      },
      RegisteredVehicle: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
          group_id: { type: 'string', example: 'ACME_MALL' },
          vehicle_number: { type: 'string', example: 'MH12AB1234' },
          device_names: { type: 'array', items: { type: 'string' }, example: [] },
          name: { type: 'string', example: 'Ramesh Kumar' },
          phone_number: { type: 'string', example: '+91 9876543210' },
          vehicle_model: {
            type: 'string',
            nullable: true,
            description: 'As recorded by the operator. Null when none was entered.',
            example: 'Swift Dzire',
          },
          valid_till: { type: 'string', format: 'date-time', example: '2027-03-31T23:59:59.999Z' },
          is_active: {
            type: 'boolean',
            description:
              'The manual switch, set from the dashboard via `PATCH /api/vehicles/{id}/status`. ' +
              'false reports the plate as unregistered at every gate whatever valid_till says.',
            example: true,
          },
          status: {
            type: 'string',
            enum: VEHICLE_TYPES,
            description:
              'What the barrier will actually do. Derived at read time from `is_active` and ' +
              '`valid_till` together — never stored, so it cannot go stale and needs no cron job. ' +
              '`registered` requires both: switched on **and** in date.',
            example: 'registered',
          },
          inactive_reason: {
            type: 'string',
            nullable: true,
            enum: ['deactivated', 'expired', null],
            description:
              'Why it is unregistered, so the UI can distinguish "we suspended this" from "the pass ' +
              'ran out" instead of showing one ambiguous badge. Null while registered. ' +
              '`deactivated` wins when both apply.',
            example: null,
          },
          days_remaining: {
            type: 'integer',
            description:
              'Negative once expired (e.g. -185 means it lapsed 185 days ago). Still reported for a ' +
              'deactivated vehicle, whose pass keeps running down while it is switched off.',
            example: 239,
          },
          registered_by: {
            type: 'object',
            nullable: true,
            description:
              'Who originally added the vehicle. Preserved across renewals and edits by anyone ' +
              'else. Null on rows created before this was recorded.',
            properties: {
              id: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
              name: { type: 'string', nullable: true, example: 'Ravi Sharma' },
              email: { type: 'string', nullable: true, example: 'ravi@acmemall.com' },
            },
          },
          updated_by: {
            type: 'object',
            nullable: true,
            description: 'Who last edited, deactivated or reactivated it.',
            properties: {
              id: { type: 'string' },
              name: { type: 'string', nullable: true },
              email: { type: 'string', nullable: true },
            },
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      RegisteredVehicleSaved: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Vehicle registered successfully.' },
          created: {
            type: 'boolean',
            description: 'true when a new plate was added (201), false when an existing one was renewed (200).',
            example: true,
          },
          data: { $ref: '#/components/schemas/RegisteredVehicle' },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      RegisteredVehicleList: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Vehicles fetched successfully.' },
          count: { type: 'integer', example: 2 },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer', example: 1 },
              limit: { type: 'integer', example: 25 },
              total: { type: 'integer', example: 2 },
              total_pages: { type: 'integer', example: 1 },
              has_next: { type: 'boolean', example: false },
              has_previous: { type: 'boolean', example: false },
            },
          },
          data: { type: 'array', items: { $ref: '#/components/schemas/RegisteredVehicle' } },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      // ---- Filter options, shared shape between the two filter endpoints ----
      // One project a dashboard may filter on, with the gates it can offer for
      // it. Deactivated projects are listed and flagged rather than hidden —
      // their history is still readable — while deactivated gates are left out,
      // because a decommissioned camera has no place in a picker.
      FilterProject: {
        type: 'object',
        properties: {
          group_id: { type: 'string', example: 'ACME_MALL' },
          project_name: { type: 'string', example: 'ACME_MALL' },
          is_active: { type: 'boolean', example: true },
          device_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Active gates on this project.',
            example: ['entry1', 'exit1'],
          },
        },
      },
      VehicleLogFilters: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Vehicle log filters fetched successfully.' },
          data: {
            type: 'object',
            properties: {
              projects: {
                type: 'array',
                items: { $ref: '#/components/schemas/FilterProject' },
                description: 'Every project the caller may filter on, with its gates.',
              },
              device_names: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Every gate across those projects, de-duplicated case-insensitively — what an ' +
                  '"any project" gate dropdown binds to.',
                example: ['entry1', 'exit1'],
              },
              vehicle_types: {
                type: 'array',
                items: { type: 'string', enum: VEHICLE_TYPES },
                example: VEHICLE_TYPES,
              },
              detected_between: {
                type: 'object',
                description:
                  'The span the caller’s detections actually cover, so a date picker can bound ' +
                  'itself to it. Both ends are null when there are no detections at all — which ' +
                  'is a different thing from a filter that matched nothing.',
                properties: {
                  from: { type: 'string', format: 'date-time', nullable: true },
                  to: { type: 'string', format: 'date-time', nullable: true },
                },
              },
              paging: {
                type: 'object',
                description: 'The limits this API enforces, so the client need not hard-code them.',
                properties: {
                  default_limit: { type: 'integer', example: 25 },
                  max_limit: { type: 'integer', example: 200 },
                },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      VehicleFilters: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Vehicle filters fetched successfully.' },
          data: {
            type: 'object',
            properties: {
              projects: {
                type: 'array',
                items: { $ref: '#/components/schemas/FilterProject' },
              },
              device_names: {
                type: 'array',
                items: { type: 'string' },
                example: ['entry1', 'exit1'],
              },
              statuses: {
                type: 'array',
                items: { type: 'string', enum: VEHICLE_TYPES },
                example: VEHICLE_TYPES,
              },
              registered_by: {
                type: 'array',
                description:
                  'Only operators who have actually registered a vehicle in this scope, so the ' +
                  'dropdown is the handful of names that appear in the table rather than every ' +
                  'account on the system. Send an `id` back as `registered_by`.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
                    name: { type: 'string', nullable: true, example: 'Ravi Sharma' },
                    email: { type: 'string', nullable: true, example: 'ravi@acmemall.com' },
                  },
                },
              },
              counts: {
                type: 'object',
                description:
                  'The number behind each filter chip. They partition the registry exactly: ' +
                  '`registered + expired + deactivated = total`, and `unregistered` is the last ' +
                  'two added up — the same decomposition `status` and `is_active` filter on.',
                properties: {
                  total: { type: 'integer', example: 128 },
                  registered: { type: 'integer', example: 101 },
                  unregistered: { type: 'integer', example: 27 },
                  expired: { type: 'integer', example: 22 },
                  deactivated: { type: 'integer', example: 5 },
                },
              },
              expiring_soon: {
                type: 'object',
                description:
                  'The renewals queue. Send `expiring_in_days=<within_days>` to `GET /api/vehicles` ' +
                  'to open exactly these rows.',
                properties: {
                  within_days: { type: 'integer', example: 30 },
                  count: { type: 'integer', example: 9 },
                },
              },
              paging: {
                type: 'object',
                properties: {
                  default_limit: { type: 'integer', example: REGISTRY_DEFAULT_LIMIT },
                  max_limit: { type: 'integer', example: REGISTRY_MAX_LIMIT },
                },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string', example: 'Request validation failed.' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string', example: 'device_unique_key' },
                message: { type: 'string', example: 'device_unique_key must be a valid UUID.' },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Unauthorized: {
        description: 'Missing, invalid or expired credential — logging in again is the fix',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Forbidden: {
        description:
          'Authenticated, but not allowed: the role lacks the permission, or the project is ' +
          'outside the caller’s scope. Logging in again will not help.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      NotFound: {
        description: 'No such resource',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Conflict: {
        description: 'Duplicate resource (transaction_id, group_id, email or device name)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      TooManyRequests: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      ServerError: {
        description: 'Unexpected server error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
    },
  },
  paths: {
    // Dashboard: JWT-authenticated, scoped to the caller's projects.
    ...authPaths,
    ...projectPaths,
    ...userPaths,
    ...logPaths,
    ...analyticsPaths,

    // Cameras / Intozi: API-key authenticated, scoped to the key's project.
    '/api': {
      post: {
        tags: ['ANPR'],
        summary: 'Ingest an ANPR detection event',
        description:
          'The event is stored against the project the API key belongs to. A `group_id` in the ' +
          'body **cannot override that** — a key issued for one site can never write into another ' +
          'customer’s data. It is still read when the legacy unscoped `API_KEY` is used.\n\n' +
          '`vehicle_type` is mandatory on the request but is **not** authoritative: the plate is ' +
          'looked up in that project’s registry and judged against `valid_till` at detection time, ' +
          'and the sent value is used only when the plate is not on the registry at all.\n\n' +
          '`transaction_id` is idempotent **within a project**, so two customers may legitimately ' +
          'both send 4471.\n\n' +
          'A `device_name` the project has never seen is auto-registered and flagged rather than ' +
          'rejected — dropping a live event is a worse failure than an unexpected row in the ' +
          'device table.',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AnprEvent' } } },
        },
        responses: {
          200: {
            description: 'Event stored',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AnprEventStored' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/feed': {
      get: {
        tags: ['ANPR'],
        summary: 'Registered-vehicle feed polled by the Intozi server',
        description:
          'Designed to be polled every 5-10 seconds. Reads the **registered-vehicle registry** — ' +
          'not the detection log — so every vehicle the dashboard knows about appears here ' +
          'whether or not a camera has ever seen it.\n\n' +
          'Each row is `vehicle_number`, `group_id`, `vehicle_type` and `device_names`. ' +
          '`vehicle_type` is derived from `valid_till` at read time, so a ' +
          'registration that lapsed a minute ago already reads `unregistered`.\n\n' +
          '**Read the status and the gates together.** A registration can be limited to specific ' +
          'gates, so `vehicle_type: "registered"` means "this pass is current", not "open the ' +
          'barrier anywhere". At a gate that is not in `device_names` the vehicle must be treated ' +
          'as unregistered. Prilinesha applies that same rule ' +
          'itself when it stamps an incoming event.\n\n' +
          '**Polling loop:** call once without parameters (returns the oldest page), then send the ' +
          '`next_cursor` from every response back as `cursor`. Each row is delivered exactly once; ' +
          'renewing a registration re-sends it with its new status, which is how a poller learns ' +
          'the status changed. While `has_more` is true, poll again immediately rather than ' +
          'waiting for the next interval.\n\n' +
          '**Scope:** a per-project key returns that project’s registrations only, with no ' +
          'parameter needed and none accepted that would widen it — naming a different `group_id` ' +
          'is a 403, not a wider read. Only the legacy shared `API_KEY` sees every project.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'group_id',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'ACME_MALL' },
            description:
              'Narrows within what the key already grants. Pointless for a per-project key, and ' +
              'rejected with 403 if it names anything else.',
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'The `next_cursor` from the previous response. Omit on the very first call.',
          },
          {
            name: 'since',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description:
              'Alternative cold start: return events received after this instant. Ignored when `cursor` is sent.',
            example: '2025-12-22T12:33:01.744Z',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: FEED_MAX_LIMIT,
              default: FEED_DEFAULT_LIMIT,
            },
            description: 'Page size.',
          },
          {
            name: 'vehicle_type',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: VEHICLE_TYPES },
            description: 'Return only registered or only unregistered vehicles.',
          },
        ],
        responses: {
          200: {
            description: 'Feed page (an empty `data` array simply means nothing new since the cursor)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/VehicleFeedResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/vehicles': {
      post: {
        tags: ['Vehicles'],
        summary: 'Register a vehicle in a project (or renew it)',
        description:
          'Adds a vehicle to the registry that decides what `GET /api/anpr/feed` reports.\n\n' +
          'A plate is unique **within a project**: submitting one already registered there updates ' +
          'the holder and extends `valid_till` (200, `created: false`) instead of failing — that is ' +
          'how an expired vehicle is renewed. A brand-new plate returns 201. The same plate ' +
          'registered under a different `group_id` is an entirely separate record.\n\n' +
          '`group_id` may be omitted by a user assigned to exactly one project; anyone with access ' +
          'to several must name one, because guessing on their behalf is how data lands in the ' +
          'wrong tenant.\n\n' +
          '**Gates.** Fetch the project\'s gates from `GET /api/projects/{group_id}/devices` and ' +
          'send back the ones the operator picked as `device_names`, or `all_devices: true` for ' +
          'every gate. Names are validated against that project, so a typo is a 400 rather than a ' +
          'registration silently restricted to a gate that does not exist.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterVehicle' } } },
        },
        responses: {
          200: {
            description: 'Existing registration renewed',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleSaved' } },
            },
          },
          201: {
            description: 'Vehicle registered',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleSaved' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      get: {
        tags: ['Vehicles'],
        summary: 'List registered vehicles for the dashboard table',
        description:
          'Offset paging with a total row count, plus search and status filtering. ' +
          '`status` is evaluated against `valid_till` at request time, so expiry needs no cron job.\n\n' +
          'Restricted to the caller’s projects: a super admin sees every project, a customer admin ' +
          'only their assigned ones, and an unassigned account sees an empty list.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'group_id',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'ACME_MALL' },
            description:
              'Narrow to one project. Omit to see every project the caller can access. Naming a ' +
              'project outside their scope is a 403.',
          },
          {
            name: 'search',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 100 },
            description: 'Partial, case-insensitive match on vehicle number, name or phone number.',
          },
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: VEHICLE_TYPES },
            description:
              'The **effective** status. `registered` = switched on AND inside valid_till; ' +
              '`unregistered` = expired **or** deactivated.',
          },
          {
            name: 'is_active',
            in: 'query',
            required: false,
            schema: { type: 'boolean' },
            description:
              'The manual switch on its own — the question `status` cannot answer, since it folds ' +
              'expiry in. `is_active=false` lists what has been suspended; ' +
              '`is_active=true&status=unregistered` lists what merely lapsed.',
          },
          {
            name: 'registered_by',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
            description: 'Only vehicles added by this user — "what did this operator enter?".',
          },
          {
            name: 'device_name',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'entry1' },
            description:
              'Registrations that count at this gate, matched case-insensitively — "who may come ' +
              'through this entrance?". Unrestricted registrations (an empty `device_names`, ' +
              'meaning every gate in the project) are included, because they are valid there too.',
          },
          {
            name: 'valid_from',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '2026-09-01' },
            description:
              'Passes expiring at or after this instant. A window on `valid_till` itself — ' +
              '"which passes run out this month?" — independent of `status`, which only asks ' +
              'whether that date has already gone by.',
          },
          {
            name: 'valid_to',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '2026-09-30' },
            description:
              'Passes expiring at or before this instant. A bare date covers the **whole** day, ' +
              'so a pass expiring on the evening of the 30th is included.',
          },
          {
            name: 'expiring_in_days',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, maximum: 730, example: 30 },
            description:
              'The renewals queue in one parameter: still switched on, and lapsing within this ' +
              'many days. Excludes the already expired and the deactivated — a suspended vehicle ' +
              'is waiting on a decision, not on a renewal. `GET /api/vehicles/filters` reports the ' +
              'count for the default window.',
          },
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: REGISTRY_MAX_LIMIT,
              default: REGISTRY_DEFAULT_LIMIT,
            },
          },
        ],
        responses: {
          200: {
            description: 'Registry page, newest registration first',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleList' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    '/api/vehicles/filters': {
      get: {
        tags: ['Vehicles'],
        summary: 'Filter options for the registry table',
        description:
          'What the filter bar above `GET /api/vehicles` can offer: the caller’s projects and ' +
          'their gates, the statuses, the operators who have actually registered something, and ' +
          'the row count behind each chip. Fetch it once when the screen opens and send the ' +
          'chosen values back to the list endpoint.\n\n' +
          'Scoped exactly like the table it drives, so a dropdown can never offer a project the ' +
          'caller would then get a 403 for. `?group_id=` narrows the options **and** the counts ' +
          'to one project.\n\n' +
          'The counts partition the registry exactly — `registered + expired + deactivated = ' +
          'total` — so a chip’s number always matches the table it opens. `expired` and ' +
          '`deactivated` are reported apart because they are fixed differently: one needs ' +
          'renewing, the other switching back on.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'group_id',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'ACME_MALL' },
            description:
              'Narrow the options and counts to one project. Omit for every project the caller ' +
              'can access.',
          },
        ],
        responses: {
          200: {
            description: 'Filter options and counts',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VehicleFilters' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    // The single-record routes scope by folding the caller's projects into the
    // query, so a vehicle in another customer's project is a 404, not a 403 —
    // an object id is opaque and guessable in bulk, and "exists, but not yours"
    // would confirm which ids are real.
    '/api/vehicles/{id}': {
      get: {
        tags: ['Vehicles'],
        summary: 'One registration',
        security: [{ BearerAuth: [] }],
        parameters: [vehicleIdParam],
        responses: {
          200: {
            description: 'Registration',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleSaved' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      patch: {
        tags: ['Vehicles'],
        summary: 'Edit a registration',
        description:
          'Only the fields sent change — omitting `device_names` leaves the gate list alone, while ' +
          'sending an explicit `[]` widens a restricted registration back to every gate.\n\n' +
          '`group_id` and `vehicle_number` cannot be edited: together they are the row’s identity, ' +
          'and changing either is registering a different vehicle. A body that changes nothing is ' +
          'a 400, so a mistyped field name cannot look like a successful edit.',
        security: [{ BearerAuth: [] }],
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateVehicleRequest' } } },
        },
        responses: {
          200: {
            description: 'Updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleSaved' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      delete: {
        tags: ['Vehicles'],
        summary: 'Delete a registration',
        description:
          '**Prefer deactivating.** A deleted row loses who registered it and when, and the plate ' +
          'becomes indistinguishable from one never registered. Deleting is right for a record ' +
          'entered by mistake, not for a resident who moved out.\n\n' +
          'Detections already logged are untouched — `VehicleLog` stores the status as judged at ' +
          'detection time, not a reference to this row.',
        security: [{ BearerAuth: [] }],
        parameters: [vehicleIdParam],
        responses: {
          200: {
            description: 'Deleted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VehicleDeleted' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    '/api/vehicles/{id}/status': {
      patch: {
        tags: ['Vehicles'],
        summary: 'Mark a vehicle registered or unregistered',
        description:
          'The manual half of the status. `is_active: false` reports the plate as **unregistered** ' +
          'at every gate immediately, whatever `valid_till` says — for a resident who moved out, or ' +
          'a pass suspended pending payment. `true` restores it.\n\n' +
          'Stored on the record and live on Intozi’s next poll: the feed, the ingestion-time ' +
          'decision and this table all derive status from the same two fields, so there is nothing ' +
          'to synchronise and nothing that can drift.\n\n' +
          'The other half is `valid_till`, and time owns that — expiry needs no cron job, and no ' +
          'stored `status` column exists that could disagree with either.',
        security: [{ BearerAuth: [] }],
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SetVehicleStatusRequest' } } },
        },
        responses: {
          200: {
            description: 'Status changed',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisteredVehicleSaved' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness probe',
        responses: {
          200: {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string', example: 'UP' } } },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness probe (includes database state)',
        responses: {
          200: { description: 'Service and database are ready' },
          503: { description: 'Database unavailable' },
        },
      },
    },
  },
};

module.exports = swaggerSpec;
