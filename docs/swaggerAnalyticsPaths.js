/**
 * OpenAPI paths and schemas for the reporting endpoints (`/api/analytics/*`).
 *
 * Split out of docs/swagger.js for size only; merged back in with a spread, so
 * these behave exactly as if they were declared inline.
 */

const {
  VEHICLE_TYPES,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_MAX_BUCKETS,
  DEFAULT_REPORT_TIMEZONE,
} = require('../utils/constants');

const errors = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/ServerError' },
};

const json = (schema) => ({ 'application/json': { schema: { $ref: schema } } });

const forbidden = {
  description: 'group_id is outside your scope',
  content: json('#/components/schemas/ErrorResponse'),
};

/** The filters both reports accept, so the filter bar drives them identically. */
const reportParams = [
  {
    name: 'group_id',
    in: 'query',
    schema: { type: 'string', example: 'ACME_MALL' },
    description: 'Narrow to one project. Omit for every project the caller can see.',
  },
  {
    name: 'from',
    in: 'query',
    schema: { type: 'string', example: '2026-08-01' },
    description:
      'Start of the window. A bare date is the **whole local day** in `timezone`; a datetime ' +
      'without an offset is that wall-clock time in `timezone`; one with `Z` or an offset is ' +
      'taken as given. Omitted, it is the default span for the granularity (30 days for `day`).',
  },
  {
    name: 'to',
    in: 'query',
    schema: { type: 'string', example: '2026-08-13' },
    description:
      'End of the window, inclusive — `to=2026-08-13` includes the 13th. Defaults to the end ' +
      'of today, locally.',
  },
  {
    name: 'timezone',
    in: 'query',
    schema: { type: 'string', default: DEFAULT_REPORT_TIMEZONE, example: 'Asia/Kolkata' },
    description:
      'IANA zone the day boundaries are drawn in. This decides which day a detection counts ' +
      `on: at the default (${DEFAULT_REPORT_TIMEZONE}) a vehicle seen at 04:00 local belongs ` +
      'to that morning, where UTC would put it on the previous day.',
  },
  {
    name: 'direction',
    in: 'query',
    schema: { type: 'string', enum: ['entry', 'exit'] },
    description:
      'Count only the gates configured as entries, or only the exits. Omit for both plus the ' +
      'gates that could not be attributed either way.',
  },
  {
    name: 'device_name',
    in: 'query',
    schema: { type: 'string', example: 'Exit_Gate_1' },
    description: 'One exact gate, matched case-insensitively.',
  },
  {
    name: 'vehicle_type',
    in: 'query',
    schema: { type: 'string', enum: VEHICLE_TYPES },
    description: 'Registration status as judged at detection time.',
  },
  {
    name: 'vehicle_number',
    in: 'query',
    schema: { type: 'string', example: 'MH12AB1234' },
    description: 'One exact plate — that vehicle’s own crossings.',
  },
];

/**
 * How entries and exits are decided, stated once and referenced from all three
 * operations — it is the thing most likely to surprise someone reading a count.
 */
const DIRECTION_NOTE =
  '## How entry and exit are decided\n\n' +
  'A detection names the gate that saw it (`device_name`), not a direction. The direction is a ' +
  'property of the **gate**, set on the project with ' +
  '`PATCH /api/projects/{group_id}/devices/{device_name}` and a body of `{ "direction": "entry" }`. ' +
  'Every count here joins the event to that list.\n\n' +
  'A gate with no direction configured is not guessed at silently: its name is read for an ' +
  'unambiguous hint ("Exit_Gate_1", "Gate-1 Entry Camera"), and every gate in the response ' +
  'carries `direction_source` — `configured`, `inferred_from_name` or `unknown` — so a number ' +
  'that looks wrong can be traced to the gate behind it. Anything still unresolved, including a ' +
  'gate deliberately marked `both`, is counted under `unattributed` rather than being folded ' +
  'into entries or exits, and is listed in `unattributed_devices`. That is why ' +
  '`entries + exits` can be less than `total`.';

const countBlock = (description) => ({
  type: 'object',
  description,
  properties: {
    entries: { type: 'integer', example: 128 },
    exits: { type: 'integer', example: 121 },
    unattributed: {
      type: 'integer',
      example: 0,
      description: 'Detections at gates whose direction is unknown or `both`.',
    },
    registered: { type: 'integer', example: 190 },
    unregistered: { type: 'integer', example: 59 },
    total: { type: 'integer', example: 249 },
  },
});

const registryBlock = {
  type: 'object',
  description:
    'A **standing** count of the registered-vehicle register — not day-wise, and not affected ' +
    'by `from`/`to`. `total` is every row; the three below it are what those rows mean today.',
  properties: {
    total: { type: 'integer', example: 412 },
    active: {
      type: 'integer',
      example: 388,
      description: 'Switched on and still inside `valid_till` — these read as registered.',
    },
    expired: { type: 'integer', example: 20, description: 'Switched on, but past `valid_till`.' },
    deactivated: { type: 'integer', example: 4, description: 'Switched off from the dashboard.' },
  },
};

const deviceBreakdown = {
  type: 'array',
  description:
    'Which gate produced what, and on what authority. This is where a suspicious number gets ' +
    'diagnosed.',
  items: {
    type: 'object',
    properties: {
      group_id: { type: 'string', example: 'ACME_MALL' },
      device_name: { type: 'string', example: 'Exit_Gate_1' },
      direction: { type: 'string', enum: ['entry', 'exit', 'both'], nullable: true },
      direction_source: {
        type: 'string',
        enum: ['configured', 'inferred_from_name', 'unknown'],
        example: 'configured',
      },
      count: { type: 'integer', example: 121 },
    },
  },
};

const unattributedDevices = {
  type: 'array',
  description:
    'Gates that cost this report accuracy — no direction configured and no usable hint in the ' +
    'name, or configured as `both`. Setting a direction on each is the one-line fix.',
  items: {
    type: 'object',
    properties: {
      group_id: { type: 'string', example: 'NETRU_PRO' },
      device_name: { type: 'string', example: 'Netru Pro Ramp' },
      configured_direction: {
        type: 'string',
        enum: ['entry', 'exit', 'both'],
        nullable: true,
        example: null,
      },
    },
  },
};

const analyticsSchemas = {
  AnalyticsSummary: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Analytics summary fetched successfully.' },
      data: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            description: 'The window actually used, after defaults were applied.',
            properties: {
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
              timezone: { type: 'string', example: DEFAULT_REPORT_TIMEZONE },
            },
          },
          filters: {
            type: 'object',
            description: 'The filters echoed back, so a client can confirm what it asked for.',
            properties: {
              direction: { type: 'string', nullable: true },
              device_name: { type: 'string', nullable: true },
              vehicle_type: { type: 'string', nullable: true },
              vehicle_number: { type: 'string', nullable: true },
            },
          },
          registered_vehicles: registryBlock,
          traffic: countBlock('Detections inside the window.'),
          today: {
            allOf: [
              countBlock('The same counts for the local day in progress.'),
              {
                type: 'object',
                properties: {
                  date: {
                    type: 'string',
                    example: '2026-08-13',
                    description: 'The local calendar day these counts belong to.',
                  },
                },
              },
            ],
          },
          by_project: {
            type: 'array',
            description:
              'One row per project in scope, busiest first. Present even for a project with no ' +
              'detections, as a row of zeros.',
            items: {
              type: 'object',
              properties: {
                group_id: { type: 'string', example: 'ACME_MALL' },
                registered_vehicles: registryBlock,
                traffic: countBlock('This project, inside the window.'),
                today: countBlock('This project, today.'),
              },
            },
          },
          by_device: deviceBreakdown,
          unattributed_devices: unattributedDevices,
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  TrafficSeries: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Traffic series fetched successfully.' },
      count: { type: 'integer', example: 7, description: 'Number of points in `series`.' },
      data: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
              timezone: { type: 'string', example: DEFAULT_REPORT_TIMEZONE },
              granularity: { type: 'string', enum: ANALYTICS_GRANULARITIES },
            },
          },
          filters: {
            type: 'object',
            properties: {
              direction: { type: 'string', nullable: true },
              device_name: { type: 'string', nullable: true },
              vehicle_type: { type: 'string', nullable: true },
              vehicle_number: { type: 'string', nullable: true },
            },
          },
          series: {
            type: 'array',
            description:
              'One point per bucket, in order, **zero-filled** — a quiet day is a row of zeros ' +
              'rather than a missing point, so a line chart dips instead of interpolating ' +
              'across it. Plot `bucket` on the x-axis, `entries` and `exits` as the series.',
            items: {
              allOf: [
                {
                  type: 'object',
                  properties: {
                    bucket: {
                      type: 'string',
                      example: '2026-08-13',
                      description:
                        'The bucket label: `2026-08-13T14:00` (hour), `2026-08-13` (day), ' +
                        '`2026-W33` (ISO week) or `2026-08` (month).',
                    },
                    starts_at: {
                      type: 'string',
                      format: 'date-time',
                      description: 'The instant the bucket opens, for tooltips and axis ticks.',
                    },
                  },
                },
                countBlock('Counts inside this bucket.'),
              ],
            },
          },
          totals: countBlock('Every bucket added up — the same numbers the tiles show.'),
          by_project: {
            type: 'array',
            description: 'The window’s totals split by project, busiest first.',
            items: {
              allOf: [
                { type: 'object', properties: { group_id: { type: 'string', example: 'ACME_MALL' } } },
                countBlock(''),
              ],
            },
          },
          by_device: deviceBreakdown,
          unattributed_devices: unattributedDevices,
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  AnalyticsFilters: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Analytics filters fetched successfully.' },
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
            example: ['Entry_Gate_1', 'Exit_Gate_1'],
          },
          devices: {
            type: 'array',
            description:
              'Every gate with the direction the reports will use for it. A UI can say "3 gates ' +
              'have no direction set" from this alone.',
            items: {
              type: 'object',
              properties: {
                group_id: { type: 'string', example: 'ACME_MALL' },
                device_name: { type: 'string', example: 'Exit_Gate_1' },
                label: { type: 'string', nullable: true },
                configured_direction: {
                  type: 'string',
                  enum: ['entry', 'exit', 'both'],
                  nullable: true,
                  description: 'What is stored on the project — null when nobody has set one.',
                },
                direction: {
                  type: 'string',
                  enum: ['entry', 'exit', 'both'],
                  nullable: true,
                  description: 'What the reports will actually count it as.',
                },
                direction_source: {
                  type: 'string',
                  enum: ['configured', 'inferred_from_name', 'unknown'],
                },
                is_active: { type: 'boolean' },
              },
            },
          },
          directions: { type: 'array', items: { type: 'string' }, example: ['entry', 'exit'] },
          granularities: {
            type: 'array',
            items: { type: 'string', enum: ANALYTICS_GRANULARITIES },
            example: ANALYTICS_GRANULARITIES,
          },
          vehicle_types: { type: 'array', items: { type: 'string' }, example: VEHICLE_TYPES },
          detected_between: {
            type: 'object',
            description:
              'The span the caller’s detections actually cover, so a date picker can bound itself ' +
              'to it. Null on both ends when there are no detections at all.',
            properties: {
              from: { type: 'string', format: 'date-time', nullable: true },
              to: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          quick_ranges: {
            type: 'array',
            description:
              'The date chips above a chart, resolved in the report timezone rather than against ' +
              'whatever clock the browser is set to. Send `from`, `to` and `granularity` back ' +
              'verbatim.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', example: 'last_7_days' },
                label: { type: 'string', example: 'Last 7 days' },
                from: { type: 'string', example: '2026-08-07' },
                to: { type: 'string', example: '2026-08-13' },
                granularity: { type: 'string', enum: ANALYTICS_GRANULARITIES },
              },
            },
          },
          registered_vehicles: registryBlock,
          defaults: {
            type: 'object',
            properties: {
              timezone: { type: 'string', example: DEFAULT_REPORT_TIMEZONE },
              granularity: { type: 'string', example: 'day' },
              span_days: {
                type: 'object',
                description: 'How far back each granularity looks when no window is sent.',
                additionalProperties: { type: 'integer' },
              },
            },
          },
          limits: {
            type: 'object',
            properties: { max_buckets: { type: 'integer', example: ANALYTICS_MAX_BUCKETS } },
          },
          timezone: {
            type: 'string',
            example: DEFAULT_REPORT_TIMEZONE,
            description: 'The zone the quick ranges were resolved in — echo it back on the reports.',
          },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },
};

const analyticsPaths = {
  '/api/analytics/summary': {
    get: {
      tags: ['Analytics'],
      summary: 'Registry totals and entry/exit counts — the dashboard tiles',
      description:
        'The numbers above the chart, in one call — **dashboard only**, like the detection log.\n\n' +
        '`registered_vehicles` is a standing count of the register: how many vehicles are ' +
        'registered against the project right now. It is deliberately **not** day-wise and ' +
        'ignores `from`/`to`.\n\n' +
        '`traffic` is entries and exits inside the window, and `today` is the same for the local ' +
        'day in progress — so the tiles can show both without a second call and without assuming ' +
        'the window includes today.\n\n' +
        'Scoped to the caller: a super admin reads every project, a customer admin only their ' +
        'own. Naming a project outside that scope is a 403, not an empty result.\n\n' +
        DIRECTION_NOTE,
      security: [{ BearerAuth: [] }],
      parameters: reportParams,
      responses: {
        200: { description: 'Totals', content: json('#/components/schemas/AnalyticsSummary') },
        400: errors[400],
        401: errors[401],
        403: forbidden,
        500: errors[500],
      },
    },
  },

  '/api/analytics/traffic': {
    get: {
      tags: ['Analytics'],
      summary: 'Entries and exits over time — the chart',
      description:
        'One point per time bucket, ordered and zero-filled, so a chart can plot it without ' +
        'filling gaps client-side.\n\n' +
        `Windows wider than ${ANALYTICS_MAX_BUCKETS} points are a 400 telling you to coarsen ` +
        '`granularity` — `granularity=hour&from=2020-01-01` is a mistake, not a request.\n\n' +
        'Takes exactly the filters `/summary` does, plus `granularity`, so one filter bar drives ' +
        'both.\n\n' +
        DIRECTION_NOTE,
      security: [{ BearerAuth: [] }],
      parameters: [
        ...reportParams,
        {
          name: 'granularity',
          in: 'query',
          schema: { type: 'string', enum: ANALYTICS_GRANULARITIES, default: 'day' },
          description:
            'Bucket size. Weeks are ISO weeks (Monday-start, labelled `2026-W33`), matching the ' +
            'convention the rest of the system reports in.',
        },
      ],
      responses: {
        200: { description: 'Series', content: json('#/components/schemas/TrafficSeries') },
        400: {
          description: 'Validation failed, or the window is more than the bucket ceiling',
          content: json('#/components/schemas/ErrorResponse'),
        },
        401: errors[401],
        403: forbidden,
        500: errors[500],
      },
    },
  },

  '/api/analytics/filters': {
    get: {
      tags: ['Analytics'],
      summary: 'Filter options and date presets for the reports',
      description:
        'What the filter bar above the reports can offer: the caller’s projects and gates, each ' +
        'gate’s direction and where that direction came from, the granularities, and the ' +
        '`quick_ranges` behind the "Today / Last 7 days / This month" chips.\n\n' +
        'Fetch it once when the screen opens, then send the chosen values back to ' +
        '`/api/analytics/summary` and `/api/analytics/traffic`. Scoped exactly like the reports ' +
        'it drives, so a dropdown can never offer a project the caller would get a 403 for.\n\n' +
        '`registered_vehicles` is included so the registry tile can be painted from this call ' +
        'alone, before the heavier reports come back.',
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'group_id',
          in: 'query',
          schema: { type: 'string', example: 'ACME_MALL' },
          description: 'Narrow the options to one project.',
        },
        {
          name: 'timezone',
          in: 'query',
          schema: { type: 'string', default: DEFAULT_REPORT_TIMEZONE },
          description: 'The zone `quick_ranges` are resolved in. Echo it back on the reports.',
        },
      ],
      responses: {
        200: {
          description: 'Filter options',
          content: json('#/components/schemas/AnalyticsFilters'),
        },
        400: errors[400],
        401: errors[401],
        403: forbidden,
        500: errors[500],
      },
    },
  },
};

module.exports = { analyticsPaths, analyticsSchemas };
