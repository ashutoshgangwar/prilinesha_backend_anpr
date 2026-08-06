const {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  REGISTRY_DEFAULT_LIMIT,
  REGISTRY_MAX_LIMIT,
} = require('../utils/constants');

/** OpenAPI 3.0 description of the public surface, served at /api-docs. */
const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Prilinesha ANPR Ingestion API',
    version: '2.0.0',
    description:
      'Receives ANPR (Automatic Number Plate Recognition) detection events from cameras, ' +
      'stores the base64 event/plate images on disk and persists the event metadata in MongoDB.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'ANPR', description: 'Event ingestion' },
    { name: 'Vehicles', description: 'Registered-vehicle registry (internal dashboard)' },
    { name: 'System', description: 'Health probes' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Shared secret, sent raw (`Authorization: <API_KEY>`) or as `Bearer <API_KEY>`.',
      },
    },
    schemas: {
      AnprEvent: {
        type: 'object',
        required: [
          'application_name',
          'application_id',
          'device_name',
          'device_unique_key',
          'cam_id',
          'transaction_id',
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
          group_id: { type: 'string', nullable: true, example: 'Gate-A' },
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
          vehicle_number: { type: 'string', nullable: true, example: 'UP32AB1234' },
          vehicle_type: {
            type: 'string',
            nullable: true,
            enum: VEHICLE_TYPES,
            default: 'unregistered',
            description: 'Registration status. Omitted means "unregistered".',
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
              transaction_id: { type: 'integer', example: 108 },
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
          'One event on the Intozi feed. Only vehicle_number and vehicle_type carry data — ' +
          'every other field is returned as null by contract, even when the database holds a value.',
        properties: {
          owner_name: { type: 'string', nullable: true, example: null },
          created_datetime: { type: 'string', nullable: true, example: null },
          contact_no: { type: 'string', nullable: true, example: null },
          email: { type: 'string', nullable: true, example: null },
          driver_name: { type: 'string', nullable: true, example: null },
          vehicle_model: { type: 'string', nullable: true, example: null },
          vehicle_type: { type: 'string', enum: VEHICLE_TYPES, example: 'registered' },
          vehicle_number: { type: 'string', nullable: true, example: 'UP32AB1234' },
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
          vehicle_number: {
            type: 'string',
            minLength: 3,
            maxLength: 20,
            description: 'Stored uppercase. Re-sending an existing plate renews it instead of creating a duplicate.',
            example: 'MH12AB1234',
          },
          name: { type: 'string', maxLength: 150, example: 'Ramesh Kumar' },
          phone_number: { type: 'string', example: '+91 9876543210' },
          valid_till: {
            type: 'string',
            description:
              'Date (YYYY-MM-DD) or ISO 8601 datetime. A plain date covers the whole day — it is ' +
              'stored as 23:59:59.999 UTC. Once it passes, every later detection of this plate is ' +
              'reported to Intozi as "unregistered".',
            example: '2027-03-31',
          },
        },
      },
      RegisteredVehicle: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
          vehicle_number: { type: 'string', example: 'MH12AB1234' },
          name: { type: 'string', example: 'Ramesh Kumar' },
          phone_number: { type: 'string', example: '+91 9876543210' },
          valid_till: { type: 'string', format: 'date-time', example: '2027-03-31T23:59:59.999Z' },
          status: {
            type: 'string',
            enum: VEHICLE_TYPES,
            description: 'Derived from valid_till at read time — never stored, so it cannot go stale.',
            example: 'registered',
          },
          days_remaining: {
            type: 'integer',
            description: 'Negative once expired (e.g. -185 means it lapsed 185 days ago).',
            example: 239,
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
        description: 'Missing or invalid API key',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Conflict: {
        description: 'transaction_id already ingested',
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
    '/api/anpr': {
      post: {
        tags: ['ANPR'],
        summary: 'Ingest an ANPR detection event',
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
          409: { $ref: '#/components/responses/Conflict' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/anpr/feed': {
      get: {
        tags: ['ANPR'],
        summary: 'Vehicle feed polled by the Intozi server',
        description:
          'Designed to be polled every 5-10 seconds. Returns the vehicle number and its ' +
          'registered/unregistered status; all other fields are null by contract.\n\n' +
          '**Polling loop:** call once without parameters (returns the newest page), then send the ' +
          '`next_cursor` from every response back as `cursor`. Each event is delivered exactly once. ' +
          'While `has_more` is true, poll again immediately rather than waiting for the next interval.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
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
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    '/api/vehicles': {
      post: {
        tags: ['Vehicles'],
        summary: 'Register a vehicle from the internal dashboard (or renew it)',
        description:
          'Adds a vehicle to the registry that decides what `GET /api/anpr/feed` reports.\n\n' +
          'A plate is unique: submitting one that is already registered updates the holder and ' +
          'extends `valid_till` (200, `created: false`) instead of failing — that is how an expired ' +
          'vehicle is renewed. A brand-new plate returns 201.',
        security: [{ ApiKeyAuth: [] }],
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
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      get: {
        tags: ['Vehicles'],
        summary: 'List registered vehicles for the dashboard table',
        description:
          'Offset paging with a total row count, plus search and status filtering. ' +
          '`status` is evaluated against `valid_till` at request time, so expiry needs no cron job.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
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
            description: '`registered` = still inside valid_till; `unregistered` = expired.',
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
          429: { $ref: '#/components/responses/TooManyRequests' },
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
