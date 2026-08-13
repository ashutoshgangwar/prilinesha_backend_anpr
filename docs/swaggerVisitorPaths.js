const {
  VEHICLE_TYPES,
  RESIDENT_OCCUPANT_TYPES,
  MAX_VISITOR_PASS_DAYS,
  VISITOR_DEFAULT_LIMIT,
  VISITOR_MAX_LIMIT,
} = require('../utils/constants');

/**
 * OpenAPI description of the visitor-pass endpoints, kept out of swagger.js for
 * the same reason the auth and analytics paths are: that file is already the
 * longest thing in the repo, and a feature's documentation is easier to keep
 * honest when it sits in one piece next to nothing else.
 */

const visitorIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', example: '6a7378aa86d8e0aa080d4f96' },
  description: 'The pass id returned by POST or GET /api/visitors.',
};

const hostProperties = {
  host_vehicle_id: {
    type: 'string',
    nullable: true,
    description:
      'The host’s own registration, from `GET /api/vehicles`. Preferred: their name, phone and ' +
      'unit number are copied onto the pass from it, rather than re-typed at the gate. Must be a ' +
      'registration in **this** project.\n\n' +
      'On PATCH, `null` unlinks it while leaving the copied details on the pass.',
    example: '6a7378aa86d8e0aa080d4f95',
  },
  host_name: {
    type: 'string',
    maxLength: 150,
    description:
      'The host, for one who has no vehicle on the registry — plenty of flats own no car. ' +
      'Required unless `host_vehicle_id` is sent, and it overrides the copied name when both are.',
    example: 'Ramesh Kumar',
  },
  host_phone: { type: 'string', nullable: true, example: '+91 9876543210' },
  host_unit: {
    type: 'string',
    nullable: true,
    maxLength: 50,
    description: 'Flat, shop, bay or office number — how a guard actually identifies a host.',
    example: 'A-402',
  },
};

const windowProperties = {
  valid_from: {
    type: 'string',
    description:
      'When the pass opens. Date (YYYY-MM-DD) or ISO 8601 datetime; a bare date is 00:00:00.000 ' +
      'UTC of that day, and a timestamp with no offset is UTC.\n\n' +
      'Before this instant the plate reads as `unregistered`, so a visitor booked in for tomorrow ' +
      'cannot come through today.',
    example: '2026-08-14T10:00:00Z',
  },
  valid_till: {
    type: 'string',
    description:
      'When it closes. Same formats, but a bare date expands to 23:59:59.999 — so sending the ' +
      'same date to both ends means "all day", not a zero-length pass.\n\n' +
      'After this instant every detection of the plate is reported as `unregistered` again, with ' +
      `nothing to run and nothing to switch off. A pass may not span more than ${MAX_VISITOR_PASS_DAYS} days.`,
    example: '2026-08-14T18:00:00Z',
  },
};

const deviceProperties = {
  device_names: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Restricts the pass to specific gates, validated against the project exactly as on ' +
      '`POST /api/vehicles`. Empty or omitted means every gate.',
    example: ['entry1'],
  },
  all_devices: {
    type: 'boolean',
    description:
      '"All gates" as an explicit choice: stores every active gate of the project by name. Takes ' +
      'precedence over `device_names` when both are sent.',
    example: true,
  },
};

const visitorSchemas = {
  CreateVisitor: {
    type: 'object',
    required: ['vehicle_number', 'name', 'valid_from', 'valid_till'],
    properties: {
      group_id: {
        type: 'string',
        description:
          'The project to issue the pass in. Optional for a user assigned to exactly one project ' +
          '— theirs is used. Required for anyone with access to several.',
        example: 'ACME_MALL',
      },
      vehicle_number: {
        type: 'string',
        minLength: 3,
        maxLength: 20,
        description:
          'Stored uppercase. Unlike the registry, re-sending a plate does **not** renew anything: ' +
          'a plate visiting again is a new visit with its own host and window, and the earlier ' +
          'pass stays on record.',
        example: 'MH12AB1234',
      },
      name: { type: 'string', maxLength: 150, description: 'The visitor.', example: 'Suresh Yadav' },
      phone_number: { type: 'string', nullable: true, example: '+91 9812345678' },
      vehicle_model: { type: 'string', nullable: true, maxLength: 100, example: 'Swift VXI' },
      purpose: {
        type: 'string',
        nullable: true,
        maxLength: 200,
        description: 'Free text for the gate log a human reads — "delivery", "guest of A-402".',
        example: 'Guest of A-402',
      },
      ...hostProperties,
      ...windowProperties,
      ...deviceProperties,
    },
  },

  UpdateVisitor: {
    type: 'object',
    description:
      'Every field is optional — only what is sent changes — but a body that changes nothing is a ' +
      '400, so a mistyped field name cannot look like a successful edit. `group_id` and ' +
      '`vehicle_number` are absent on purpose: a different plate is a different visit.',
    properties: {
      name: { type: 'string', maxLength: 150 },
      phone_number: { type: 'string', nullable: true },
      vehicle_model: { type: 'string', nullable: true, maxLength: 100 },
      purpose: { type: 'string', nullable: true, maxLength: 200 },
      ...hostProperties,
      ...windowProperties,
      ...deviceProperties,
      is_active: {
        type: 'boolean',
        description: 'Also settable on its own via `PATCH /api/visitors/{id}/status`.',
      },
    },
  },

  SetVisitorStatusRequest: {
    type: 'object',
    required: ['is_active'],
    properties: {
      is_active: {
        type: 'boolean',
        description: 'false revokes the pass, true reinstates it for whatever remains of its window.',
        example: false,
      },
    },
  },

  VisitorPass: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6a7378aa86d8e0aa080d4f96' },
      group_id: { type: 'string', example: 'ACME_MALL' },
      vehicle_number: { type: 'string', example: 'MH12AB1234' },
      name: { type: 'string', example: 'Suresh Yadav' },
      phone_number: { type: 'string', nullable: true, example: '+91 9812345678' },
      vehicle_model: { type: 'string', nullable: true, example: 'Swift VXI' },
      purpose: { type: 'string', nullable: true, example: 'Guest of A-402' },
      host: {
        type: 'object',
        description:
          'Who the visitor is here to see. The name, phone and unit are **stored on the pass**, ' +
          'not read through the link, so the record still says who admitted this vehicle after ' +
          'the host’s registration is renamed or deleted.',
        properties: {
          type: {
            type: 'string',
            nullable: true,
            enum: [...RESIDENT_OCCUPANT_TYPES, null],
            description:
              'Stamped from the project’s own type: `resident` in a society, `tenant` in a ' +
              'parking project. Null on a project whose type was never set.',
            example: 'resident',
          },
          vehicle_id: { type: 'string', nullable: true, example: '6a7378aa86d8e0aa080d4f95' },
          vehicle_number: { type: 'string', nullable: true, example: 'UP32AB1234' },
          name: { type: 'string', example: 'Ramesh Kumar' },
          phone_number: { type: 'string', nullable: true, example: '+91 9876543210' },
          unit_number: { type: 'string', nullable: true, example: 'A-402' },
        },
      },
      valid_from: { type: 'string', format: 'date-time', example: '2026-08-14T10:00:00.000Z' },
      valid_till: { type: 'string', format: 'date-time', example: '2026-08-14T18:00:00.000Z' },
      device_names: { type: 'array', items: { type: 'string' }, example: [] },
      is_active: {
        type: 'boolean',
        description: 'The manual switch. false reads as unregistered at every gate, whatever the window says.',
        example: true,
      },
      status: {
        type: 'string',
        enum: VEHICLE_TYPES,
        description:
          'What the barrier will actually do. Derived at read time from the window and the switch ' +
          'together — never stored, so it cannot go stale and needs no cron job.',
        example: 'registered',
      },
      inactive_reason: {
        type: 'string',
        nullable: true,
        enum: ['revoked', 'not_started', 'expired', null],
        description:
          'Why it is not currently valid — three distinct situations, because a pass that has not ' +
          'started is fine and simply early, an expired one did its job, and a revoked one was ' +
          'taken away by a person. Null while live.',
        example: null,
      },
      minutes_remaining: {
        type: 'integer',
        nullable: true,
        description:
          'Minutes, not days: a pass is usually an afternoon, and a countdown in days would read ' +
          '0 for its entire useful life. Negative once the window has closed. Null before it opens.',
        example: 240,
      },
      window_minutes: {
        type: 'integer',
        description: 'How long the whole pass runs for, so a table need not subtract two timestamps.',
        example: 480,
      },
      issued_by: {
        type: 'object',
        nullable: true,
        properties: {
          id: { type: 'string' },
          name: { type: 'string', nullable: true },
          email: { type: 'string', nullable: true },
        },
      },
      updated_by: {
        type: 'object',
        nullable: true,
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

  VisitorPassSaved: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Visitor pass issued successfully.' },
      data: { $ref: '#/components/schemas/VisitorPass' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  VisitorPassList: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Visitor passes fetched successfully.' },
      count: { type: 'integer', example: 2 },
      pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: VISITOR_DEFAULT_LIMIT },
          total: { type: 'integer', example: 2 },
          total_pages: { type: 'integer', example: 1 },
          has_next: { type: 'boolean', example: false },
          has_previous: { type: 'boolean', example: false },
        },
      },
      data: { type: 'array', items: { $ref: '#/components/schemas/VisitorPass' } },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  VisitorFilters: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Visitor filters fetched successfully.' },
      data: {
        type: 'object',
        properties: {
          statuses: { type: 'array', items: { type: 'string', enum: VEHICLE_TYPES }, example: VEHICLE_TYPES },
          issued_by: {
            type: 'array',
            description:
              'Only operators who have actually issued a pass in this scope. Send an `id` back as ' +
              '`issued_by`.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string', nullable: true },
                email: { type: 'string', nullable: true },
              },
            },
          },
          counts: {
            type: 'object',
            description:
              'The four states a pass can be in, partitioning the collection exactly: ' +
              '`on_site + upcoming + expired + revoked = total`. `revoked` is counted first — a ' +
              'revoked pass is revoked whether or not its window has also run out.',
            properties: {
              total: { type: 'integer', example: 42 },
              on_site: { type: 'integer', example: 3 },
              upcoming: { type: 'integer', example: 5 },
              expired: { type: 'integer', example: 33 },
              revoked: { type: 'integer', example: 1 },
            },
          },
          paging: {
            type: 'object',
            properties: {
              default_limit: { type: 'integer', example: VISITOR_DEFAULT_LIMIT },
              max_limit: { type: 'integer', example: VISITOR_MAX_LIMIT },
            },
          },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  VisitorDeleted: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Visitor pass deleted.' },
      data: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '6a7378aa86d8e0aa080d4f96' },
          group_id: { type: 'string', example: 'ACME_MALL' },
          vehicle_number: { type: 'string', example: 'MH12AB1234' },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },
};

const visitorPaths = {
  '/api/visitors': {
    post: {
      tags: ['Visitors'],
      summary: 'Issue a visitor pass',
      description:
        'Grants one plate entry for a stated window, on a named resident’s or tenant’s behalf. ' +
        'Inside that window `GET /api/feed` reports the plate as `registered`, exactly as it does ' +
        'for a permanent registration; once the window closes, or the pass is revoked, the same ' +
        'plate reads `unregistered` again — time enforces it, not a scheduled job.\n\n' +
        '**Which word the host gets** is decided by the project: a `society` has residents, a ' +
        '`parking` project has tenants. Both have visitors, and nothing else here branches on the ' +
        'site type.\n\n' +
        '**Always 201.** Re-sending a plate is a new visit, not a renewal — the earlier pass stays ' +
        'on record with its own host and window, which is the half of this collection that has any ' +
        'value after the visit is over.\n\n' +
        '**Two things are refused with a 409**, and for the same reason: either would put two live ' +
        'records for one plate in front of Intozi, at which point which answer the barrier acts on ' +
        'depends on the order two feed rows happen to arrive in. A plate with a *current* ' +
        'registration here does not need a pass (let it lapse, or edit the registration), and a ' +
        'plate already holding a pass whose window overlaps this one must have that pass edited or ' +
        'revoked instead. Consecutive, non-overlapping visits are always fine.',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateVisitor' } } },
      },
      responses: {
        201: {
          description: 'Pass issued',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorPassSaved' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
        409: { $ref: '#/components/responses/Conflict' },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
    get: {
      tags: ['Visitors'],
      summary: 'List visitor passes',
      description:
        'Offset paging with a total row count, newest pass first. Status is evaluated against the ' +
        'window at request time, so expiry needs no cron job.\n\n' +
        'Restricted to the caller’s projects: a super admin sees every project, a customer admin ' +
        'only their assigned ones, and an unassigned account an empty list.',
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'group_id',
          in: 'query',
          schema: { type: 'string', example: 'ACME_MALL' },
          description: 'Narrow to one project. Omit for every project the caller can access.',
        },
        {
          name: 'search',
          in: 'query',
          schema: { type: 'string', maxLength: 100 },
          description:
            'Partial, case-insensitive match on the visitor’s plate, name, phone or vehicle model, ' +
            'and on the host’s name and unit number — "who did Ramesh let in?" is typed into the ' +
            'same box.',
        },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: VEHICLE_TYPES },
          description:
            'The **effective** status. `registered` = switched on AND inside the window; ' +
            '`unregistered` = revoked, not started yet, or expired.',
        },
        {
          name: 'on_site',
          in: 'query',
          schema: { type: 'boolean' },
          description:
            'The gate desk’s question, selecting the same rows as `status=registered`. It exists ' +
            'because "who is on site right now?" is what somebody actually clicks, and a filter ' +
            'named after the question is one nobody has to translate.',
        },
        {
          name: 'is_active',
          in: 'query',
          schema: { type: 'boolean' },
          description:
            'The manual switch on its own — the question `status` cannot answer, since it folds ' +
            'the window in. `is_active=false` lists what has been revoked.',
        },
        {
          name: 'host_vehicle_id',
          in: 'query',
          schema: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
          description: 'Every pass issued for one resident or tenant — "who has this flat been letting in?".',
        },
        {
          name: 'issued_by',
          in: 'query',
          schema: { type: 'string' },
          description: 'Passes issued by one dashboard user.',
        },
        {
          name: 'device_name',
          in: 'query',
          schema: { type: 'string', example: 'entry1' },
          description:
            'Passes that count at this gate, matched case-insensitively. Unrestricted passes (an ' +
            'empty `device_names`) are included, because they are valid there too.',
        },
        {
          name: 'from',
          in: 'query',
          schema: { type: 'string', example: '2026-08-14' },
          description:
            'Together with `to`, every pass **overlapping** this period — not only those starting ' +
            'in it. A pass running 10:00-18:00 is part of the afternoon even though it did not ' +
            'start in it, and a report that dropped it would be wrong about the afternoon.',
        },
        {
          name: 'to',
          in: 'query',
          schema: { type: 'string', example: '2026-08-14' },
          description: 'The other end. A bare date covers the whole day.',
        },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: VISITOR_MAX_LIMIT,
            default: VISITOR_DEFAULT_LIMIT,
          },
        },
      ],
      responses: {
        200: {
          description: 'Visitor page, newest pass first',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorPassList' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
  },

  '/api/visitors/filters': {
    get: {
      tags: ['Visitors'],
      summary: 'Filter options for the visitor table',
      description:
        'What the filter bar above `GET /api/visitors` can offer, and the row count behind each ' +
        'chip. Scoped exactly like the table it drives, so a dropdown can never offer a project ' +
        'the caller would then get a 403 for.',
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'group_id',
          in: 'query',
          schema: { type: 'string', example: 'ACME_MALL' },
          description: 'Narrow the options and counts to one project.',
        },
      ],
      responses: {
        200: {
          description: 'Filter options and counts',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorFilters' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
  },

  '/api/visitors/{id}': {
    get: {
      tags: ['Visitors'],
      summary: 'One visitor pass',
      description:
        'Scoped by folding the caller’s projects into the query, so a pass in another customer’s ' +
        'project is a **404**, not a 403 — an object id is opaque and guessable in bulk.',
      security: [{ BearerAuth: [] }],
      parameters: [visitorIdParam],
      responses: {
        200: {
          description: 'Pass',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorPassSaved' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
    patch: {
      tags: ['Visitors'],
      summary: 'Edit a visitor pass',
      description:
        'Extends the window, corrects the host, restricts the gates. Only the fields sent change.\n\n' +
        'A widened window is re-checked against this plate’s other passes here, because an edit ' +
        'can create exactly the overlap a create would have been refused for — a 409 says which ' +
        'pass it clashes with.\n\n' +
        '`group_id` and `vehicle_number` cannot be edited: a different plate is a different visit.',
      security: [{ BearerAuth: [] }],
      parameters: [visitorIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateVisitor' } } },
      },
      responses: {
        200: {
          description: 'Updated',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorPassSaved' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
        409: { $ref: '#/components/responses/Conflict' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
    delete: {
      tags: ['Visitors'],
      summary: 'Delete a visitor pass',
      description:
        '**Prefer revoking.** A deleted pass takes with it who was admitted, by whom and on whose ' +
        'invitation — which is most of what the record is for once the visit is over. Deleting is ' +
        'right for a pass entered by mistake.\n\n' +
        'Detections already logged are untouched — they record the status as judged at the time.',
      security: [{ BearerAuth: [] }],
      parameters: [visitorIdParam],
      responses: {
        200: {
          description: 'Deleted',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorDeleted' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
  },

  '/api/visitors/{id}/status': {
    patch: {
      tags: ['Visitors'],
      summary: 'Revoke or reinstate a visitor pass',
      description:
        'The manual half of the status. `is_active: false` reports the plate as **unregistered** ' +
        'at every gate immediately, whatever the window says — for the visitor who left early, or ' +
        'the pass issued to the wrong plate. `true` reinstates it for whatever remains.\n\n' +
        'Live on Intozi’s next poll: the feed, the ingestion-time decision and the dashboard table ' +
        'all derive status from the same fields, so there is nothing to synchronise.\n\n' +
        'Reinstating is checked for overlaps, since a pass switched off is a pass another one was ' +
        'allowed to be issued around.',
      security: [{ BearerAuth: [] }],
      parameters: [visitorIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/SetVisitorStatusRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Status changed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VisitorPassSaved' } } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
        409: { $ref: '#/components/responses/Conflict' },
        500: { $ref: '#/components/responses/ServerError' },
      },
    },
  },
};

module.exports = { visitorPaths, visitorSchemas };
