/**
 * OpenAPI schemas for the authentication, project and user endpoints.
 *
 * Split out of docs/swagger.js purely for size — that file already carries the
 * ANPR and vehicle contracts, and one 1,000-line object is nobody's friend.
 * Merged back in via a spread, so `$ref: '#/components/schemas/…'` works exactly
 * as if these were declared inline.
 *
 * @param {object} constants Domain constants, passed in rather than re-required
 *                           so the enum values in the docs can never drift from
 *                           the ones the validators enforce.
 */
const authSchemas = ({ ROLE_VALUES, PERMISSIONS, LIST_MAX_LIMIT }) => ({
  // ---------------------------------------------------------------- requests
  SignupRequest: {
    type: 'object',
    required: ['name', 'email', 'password'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100, example: 'Ravi Sharma' },
      email: { type: 'string', format: 'email', example: 'ravi@acmemall.com' },
      password: {
        type: 'string',
        minLength: 8,
        maxLength: 128,
        description: 'At least 8 characters, containing a letter and a number.',
        example: 'AcmePass123',
      },
      phone_number: { type: 'string', nullable: true, example: '+91 9876543210' },
    },
  },

  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', example: 'ravi@acmemall.com' },
      password: { type: 'string', example: 'AcmePass123' },
    },
  },

  RefreshRequest: {
    type: 'object',
    required: ['refresh_token'],
    properties: {
      refresh_token: {
        type: 'string',
        description: 'The refresh token from the last login or refresh. Single-use.',
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
      },
    },
  },

  LogoutRequest: {
    type: 'object',
    description: 'Send `refresh_token` to end this session, or `all: true` to end every session.',
    properties: {
      refresh_token: {
        type: 'string',
        description: 'Required unless `all` is true.',
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
      },
      all: {
        type: 'boolean',
        default: false,
        description:
          'true also retires outstanding access tokens, so every device is signed out at once. ' +
          'This is the option for a lost or stolen laptop.',
      },
    },
  },

  ChangePasswordRequest: {
    type: 'object',
    required: ['current_password', 'new_password'],
    properties: {
      current_password: { type: 'string', example: 'AcmePass123' },
      new_password: { type: 'string', minLength: 8, maxLength: 128, example: 'AcmeNewPass456' },
    },
  },

  // ----------------------------------------------------------------- results
  AuthUser: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
      name: { type: 'string', example: 'Ravi Sharma' },
      email: { type: 'string', format: 'email', example: 'ravi@acmemall.com' },
      phone_number: { type: 'string', nullable: true },
      role: { type: 'string', enum: ROLE_VALUES, example: 'admin' },
      is_super_admin: { type: 'boolean', example: false },
      group_ids: {
        oneOf: [
          { type: 'array', items: { type: 'string' }, example: ['ACME_MALL'] },
          { type: 'string', enum: ['ALL'] },
        ],
        description:
          'Projects this user may access. The literal string "ALL" for a super admin, who is ' +
          'scoped to every project including ones created later. An empty array means the ' +
          'account exists but has not been granted any data yet.',
      },
      projects: {
        type: 'array',
        nullable: true,
        description: 'Names of the assigned projects, for a project switcher.',
        items: {
          type: 'object',
          properties: {
            group_id: { type: 'string', example: 'ACME_MALL' },
            project_name: { type: 'string', example: 'Acme Mall Parking' },
            is_active: { type: 'boolean', example: true },
          },
        },
      },
      permissions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What this role may do. Provided so the dashboard can hide actions it cannot perform — ' +
          'never the enforcement point, which is always server-side.',
        example: [
          PERMISSIONS.PROJECT_READ,
          PERMISSIONS.PROJECT_DEVICE_MANAGE,
          PERMISSIONS.VEHICLE_READ,
          PERMISSIONS.VEHICLE_WRITE,
          PERMISSIONS.EVENT_READ,
        ],
      },
      is_active: { type: 'boolean', example: true },
      last_login_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  /** The token pair, identical in shape wherever tokens are handed out. */
  TokenPair: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Access token. Send as `Authorization: Bearer <token>` on every request.',
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
      },
      token_type: { type: 'string', example: 'Bearer' },
      expires_in: {
        type: 'string',
        description: 'Lifetime of the access token (JWT_EXPIRES_IN).',
        example: '12h',
      },
      refresh_token: {
        type: 'string',
        description:
          'Send to `POST /api/auth/refresh` to get a new pair once the access token expires. ' +
          '**Single-use** — each refresh returns a new one and invalidates the old one, and ' +
          'presenting a spent token revokes every session on the account. Store it where the ' +
          'access token is not: an httpOnly cookie or the OS keychain, never localStorage.',
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
      },
      refresh_expires_in: {
        type: 'string',
        description: 'Lifetime of the refresh token (JWT_REFRESH_EXPIRES_IN).',
        example: '30d',
      },
    },
  },

  AuthResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Logged in successfully.' },
      data: {
        allOf: [
          { $ref: '#/components/schemas/TokenPair' },
          {
            type: 'object',
            properties: { user: { $ref: '#/components/schemas/AuthUser' } },
          },
        ],
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  LogoutResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Signed out of every device.' },
      data: {
        type: 'object',
        properties: {
          sessions_revoked: { type: 'integer', example: 1 },
          scope: { type: 'string', enum: ['session', 'all'], example: 'session' },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  ChangePasswordResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Password changed. Other sessions have been signed out.' },
      data: { $ref: '#/components/schemas/TokenPair' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  ProfileResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Profile fetched successfully.' },
      data: { $ref: '#/components/schemas/AuthUser' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  // ---------------------------------------------------------------- projects
  ProjectDevice: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      device_name: {
        type: 'string',
        description: 'The gate identifier Intozi sends on every event.',
        example: 'entry1',
      },
      label: { type: 'string', nullable: true, example: 'Main gate — north side' },
      direction: { type: 'string', enum: ['entry', 'exit', 'both'], nullable: true },
      auto_registered: {
        type: 'boolean',
        description:
          'true when this gate was created by an incoming event rather than from the dashboard — ' +
          'a camera nobody configured is posting to us. The event is kept either way.',
        example: false,
      },
      last_seen_at: { type: 'string', format: 'date-time', nullable: true },
      is_active: { type: 'boolean', example: true },
    },
  },

  CreateProjectRequest: {
    type: 'object',
    required: ['project_name', 'address', 'project_type'],
    properties: {
      group_id: {
        type: 'string',
        pattern: '^[A-Z0-9][A-Z0-9_-]{1,49}$',
        description:
          'The tenant identifier the customer configures in Intozi. Uppercased on save. ' +
          'Immutable once created — it is stamped on every event already ingested.\n\n' +
          '**Optional.** Omit it and one is derived from `project_name` ' +
          '("Acme Mall Parking" → `ACME_MALL_PARKING`), with `_2`, `_3`… appended on collision. ' +
          'Send it explicitly only when the cameras are already configured for a given id.',
        example: 'ACME_MALL',
      },
      project_name: { type: 'string', minLength: 2, maxLength: 150, example: 'Acme Mall Parking' },
      address: {
        type: 'string',
        minLength: 5,
        maxLength: 300,
        description: 'Where the site physically is.',
        example: '12 MG Road, Sector 14, Gurugram, Haryana 122001',
      },
      project_type: {
        type: 'string',
        enum: ['parking', 'society'],
        description: 'What kind of site this is.',
        example: 'parking',
      },
      description: { type: 'string', nullable: true },
      customer_name: { type: 'string', nullable: true, example: 'Acme Retail Pvt Ltd' },
      contact_email: { type: 'string', format: 'email', nullable: true },
      contact_phone: { type: 'string', nullable: true },
      devices: {
        type: 'array',
        description: 'Gates, addable now or later.',
        items: {
          type: 'object',
          required: ['device_name'],
          properties: {
            device_name: { type: 'string', example: 'entry1' },
            label: { type: 'string', nullable: true },
            direction: { type: 'string', enum: ['entry', 'exit', 'both'], nullable: true },
          },
        },
        example: [
          { device_name: 'entry1', direction: 'entry' },
          { device_name: 'exit1', direction: 'exit' },
          { device_name: 'exit2', direction: 'exit' },
        ],
      },
    },
  },

  UpdateProjectRequest: {
    type: 'object',
    description: '`group_id` is deliberately absent — it cannot be changed.',
    properties: {
      project_name: { type: 'string', minLength: 2, maxLength: 150 },
      address: { type: 'string', maxLength: 300, nullable: true },
      project_type: { type: 'string', enum: ['parking', 'society'], nullable: true },
      description: { type: 'string', nullable: true },
      customer_name: { type: 'string', nullable: true },
      contact_email: { type: 'string', format: 'email', nullable: true },
      contact_phone: { type: 'string', nullable: true },
      is_active: {
        type: 'boolean',
        description:
          'false stops this project’s cameras from posting and its feed from being read, without ' +
          'deleting anything.',
      },
    },
  },

  Project: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      group_id: { type: 'string', example: 'ACME_MALL' },
      project_name: { type: 'string', example: 'Acme Mall Parking' },
      address: {
        type: 'string',
        nullable: true,
        example: '12 MG Road, Sector 14, Gurugram, Haryana 122001',
      },
      project_type: {
        type: 'string',
        enum: ['parking', 'society'],
        nullable: true,
        description: 'Null on projects created before this field existed.',
        example: 'parking',
      },
      description: { type: 'string', nullable: true },
      customer_name: { type: 'string', nullable: true },
      contact_email: { type: 'string', nullable: true },
      contact_phone: { type: 'string', nullable: true },
      devices: { type: 'array', items: { $ref: '#/components/schemas/ProjectDevice' } },
      device_count: { type: 'integer', example: 3 },
      api_key_last4: {
        type: 'string',
        nullable: true,
        description: 'Identifies which key is installed on site. The key itself is stored only as a hash.',
        example: 'a91c',
      },
      api_key_rotated_at: { type: 'string', format: 'date-time', nullable: true },
      is_active: { type: 'boolean', example: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      stats: {
        type: 'object',
        description: 'Returned by GET /api/projects/{group_id} only.',
        properties: {
          registered_vehicles: { type: 'integer', example: 128 },
          total_events: { type: 'integer', example: 45210 },
          assigned_users: { type: 'integer', example: 3 },
        },
      },
    },
  },

  ProjectCreated: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Project created successfully.' },
      warning: {
        type: 'string',
        example: 'Store this api_key now — it is shown once and cannot be retrieved later.',
      },
      data: {
        type: 'object',
        properties: {
          project: { $ref: '#/components/schemas/Project' },
          api_key: {
            type: 'string',
            description: 'The Intozi credential. Shown ONCE — only its SHA-256 is stored.',
            example: 'pk_ACMEMALL_9f2c1e8a4b7d0c3e6f5a2b9d8c7e4f1a0b3c6d9e2f5a8b1c',
          },
          intozi_setup: {
            type: 'object',
            description: 'The three values to hand the customer for their Intozi configuration.',
            properties: {
              group_id: { type: 'string', example: 'ACME_MALL' },
              post_url: { type: 'string', example: '/api' },
              feed_url: { type: 'string', example: '/api/feed' },
              authorization_header: { type: 'string', example: 'Bearer pk_ACMEMALL_9f2c…' },
            },
          },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  ProjectResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: '#/components/schemas/Project' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  ProjectList: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Projects fetched successfully.' },
      count: { type: 'integer', example: 2 },
      pagination: { $ref: '#/components/schemas/Pagination' },
      data: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  AddDeviceRequest: {
    type: 'object',
    required: ['device_name'],
    properties: {
      device_name: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$',
        description: 'Unique within the project, case-insensitively.',
        example: 'exit2',
      },
      label: { type: 'string', nullable: true, example: 'Basement exit' },
      direction: { type: 'string', enum: ['entry', 'exit', 'both'], nullable: true, example: 'exit' },
    },
  },

  UpdateDeviceRequest: {
    type: 'object',
    properties: {
      label: { type: 'string', nullable: true },
      direction: { type: 'string', enum: ['entry', 'exit', 'both'], nullable: true },
      is_active: { type: 'boolean' },
    },
  },

  // ------------------------------------------------------------------- users
  CreateUserRequest: {
    type: 'object',
    required: ['name', 'email', 'password'],
    properties: {
      name: { type: 'string', example: 'Priya Nair' },
      email: { type: 'string', format: 'email', example: 'priya@acmemall.com' },
      password: { type: 'string', minLength: 8, maxLength: 128, example: 'PriyaPass123' },
      phone_number: { type: 'string', nullable: true },
      role: {
        type: 'string',
        enum: ROLE_VALUES,
        default: 'admin',
        description: 'This is the only endpoint that can create another super admin.',
      },
      group_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Which projects this admin runs — **required, and at least one**, when `role` is ' +
          '`admin` (the default). Creating the admin is where the super admin picks the ' +
          'project; an admin with no project sees no data at all.\n\n' +
          'Must be **omitted or empty** for a `super_admin`, who is scoped to every project by ' +
          'role. Unknown ids are rejected with 400.',
        example: ['ACME_MALL'],
      },
    },
  },

  AssignProjectsRequest: {
    type: 'object',
    required: ['group_ids'],
    properties: {
      group_ids: {
        type: 'array',
        maxItems: LIST_MAX_LIMIT * 2,
        items: { type: 'string' },
        description: 'Must all name existing projects — a typo is rejected, not silently ignored.',
        example: ['ACME_MALL', 'BLUE_FACTORY'],
      },
      mode: {
        type: 'string',
        enum: ['replace', 'add', 'remove'],
        default: 'replace',
        description: 'How to apply the list to what the user already has.',
      },
    },
  },

  SetRoleRequest: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: ROLE_VALUES, example: 'admin' } },
  },

  SetStatusRequest: {
    type: 'object',
    required: ['is_active'],
    properties: {
      is_active: {
        type: 'boolean',
        description: 'false revokes access on the user’s next request, without deleting anything.',
        example: false,
      },
    },
  },

  ResetPasswordRequest: {
    type: 'object',
    required: ['new_password'],
    properties: {
      new_password: { type: 'string', minLength: 8, maxLength: 128, example: 'TempPass1234' },
    },
  },

  User: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string', example: 'Priya Nair' },
      email: { type: 'string', format: 'email' },
      phone_number: { type: 'string', nullable: true },
      role: { type: 'string', enum: ROLE_VALUES },
      group_ids: {
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string', enum: ['ALL'] },
        ],
      },
      permissions: { type: 'array', items: { type: 'string' } },
      is_active: { type: 'boolean' },
      last_login_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  UserResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: '#/components/schemas/User' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  UserList: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Users fetched successfully.' },
      count: { type: 'integer', example: 3 },
      pagination: { $ref: '#/components/schemas/Pagination' },
      data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  // -------------------------------------------------------------------- logs
  VehicleLogRecord: {
    type: 'object',
    description:
      'One detection, as the internal dashboard shows it. Built field by field rather than by ' +
      'hiding columns, so contact details stored on the event — the driver’s phone number, their ' +
      'email — cannot appear here by default.',
    properties: {
      id: { type: 'string', example: '6b8f21c4d9e3a70f1c45b902' },
      group_id: {
        type: 'string',
        nullable: true,
        description: 'Null only on events ingested with the legacy unscoped API key.',
        example: 'ACME_MALL',
      },
      device_name: { type: 'string', nullable: true, example: 'entry1' },
      vehicle_number: { type: 'string', nullable: true, example: 'HR26DK8337' },
      vehicle_type: {
        type: 'string',
        enum: ['registered', 'unregistered'],
        description:
          'Status as judged when the vehicle was seen, not as it stands now — a registration ' +
          'expiring today cannot rewrite last week’s detections.',
        example: 'registered',
      },
      vehicle_model: { type: 'string', nullable: true, example: 'Swift Dzire' },
      owner_name: {
        type: 'string',
        nullable: true,
        description:
          'From the event when the camera sent one, otherwise from the registered-vehicle ' +
          'registry matched on (group_id, vehicle_number). Null when neither knows the plate.',
        example: 'Ravi Sharma',
      },
      owner_name_source: {
        type: 'string',
        nullable: true,
        enum: ['event', 'registry', null],
        description: 'Which source answered, so the UI can tell a match from a camera-supplied name.',
        example: 'registry',
      },
      detected_at: {
        type: 'string',
        format: 'date-time',
        description: 'When the camera saw the vehicle. This is the sort column.',
      },
      received_at: {
        type: 'string',
        format: 'date-time',
        description: 'When this API recorded it. Later than detected_at on a delayed delivery.',
      },
    },
  },

  VehicleLogList: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Vehicle logs fetched successfully.' },
      count: { type: 'integer', example: 25 },
      pagination: { $ref: '#/components/schemas/Pagination' },
      data: { type: 'array', items: { $ref: '#/components/schemas/VehicleLogRecord' } },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  // Shared by every offset-paged list.
  Pagination: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 25 },
      total: { type: 'integer', example: 3 },
      total_pages: { type: 'integer', example: 1 },
      has_next: { type: 'boolean', example: false },
      has_previous: { type: 'boolean', example: false },
    },
  },
});

module.exports = { authSchemas };
