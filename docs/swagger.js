const { VEHICLE_CLASSES, VEHICLE_COLORS } = require('../utils/constants');

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
