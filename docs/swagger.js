const {
  VEHICLE_CLASSES,
  VEHICLE_COLORS,
  VEHICLE_TYPES,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
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
