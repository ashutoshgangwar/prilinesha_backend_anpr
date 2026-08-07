/**
 * OpenAPI path definitions for the authentication, project and user endpoints.
 *
 * Split out of docs/swagger.js for size only; merged back in with a spread, so
 * these behave exactly as if they were declared inline. Schemas for everything
 * referenced here live in docs/swaggerAuthSchemas.js.
 */

/** Standard error responses, referenced by nearly every operation. */
const errors = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
  429: { $ref: '#/components/responses/TooManyRequests' },
  500: { $ref: '#/components/responses/ServerError' },
};

const json = (schema) => ({ 'application/json': { schema: { $ref: schema } } });

const groupIdParam = {
  name: 'group_id',
  in: 'path',
  required: true,
  schema: { type: 'string', example: 'ACME_MALL' },
  description: 'The project identifier.',
};

const deviceNameParam = {
  name: 'device_name',
  in: 'path',
  required: true,
  schema: { type: 'string', example: 'exit2' },
  description: 'The gate identifier, matched case-insensitively.',
};

const userIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', example: '6a7378aa86d8e0aa080d4f95' },
};

const pagingParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
];

// ---------------------------------------------------------------------- auth
const authPaths = {
  '/api/auth/signup': {
    post: {
      tags: ['Auth'],
      summary: 'Register a dashboard user',
      description:
        'Creates a customer **admin** with NO project access — they can log in, but every scoped ' +
        'query returns nothing until a super admin assigns them a `group_id` via ' +
        '`PUT /api/users/{id}/projects`. A `role` field in the body is ignored, so this endpoint ' +
        'cannot be used to mint a super admin.\n\n' +
        'Rate limited far more tightly than the rest of the API, and disabled entirely when ' +
        '`SIGNUP_ENABLED=false`.',
      requestBody: { required: true, content: json('#/components/schemas/SignupRequest') },
      responses: {
        201: { description: 'Account created', content: json('#/components/schemas/AuthResponse') },
        400: errors[400],
        403: { description: 'Public signup is disabled', content: json('#/components/schemas/ErrorResponse') },
        409: { description: 'Email already registered', content: json('#/components/schemas/ErrorResponse') },
        429: errors[429],
        500: errors[500],
      },
    },
  },

  '/api/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Log in and receive an access + refresh token pair',
      description:
        'The same endpoint for both roles — the role is never sent, it is looked up. What differs ' +
        'is the response: a super admin gets `"group_ids": "ALL"` and every permission, a customer ' +
        'admin gets their assigned `group_ids` and a shorter permission list.\n\n' +
        'A wrong email and a wrong password return the identical 401, and take comparable time, ' +
        'so the endpoint cannot be used to discover which addresses are registered.',
      requestBody: { required: true, content: json('#/components/schemas/LoginRequest') },
      responses: {
        200: { description: 'Logged in', content: json('#/components/schemas/AuthResponse') },
        400: errors[400],
        401: { description: 'Invalid email or password', content: json('#/components/schemas/ErrorResponse') },
        403: { description: 'Account deactivated', content: json('#/components/schemas/ErrorResponse') },
        429: errors[429],
        500: errors[500],
      },
    },
  },

  '/api/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Exchange a refresh token for a new pair',
      description:
        'Takes no `Authorization` header — the refresh token in the body **is** the credential, ' +
        'which is what lets it work after the access token has expired.\n\n' +
        '**Rotating and single-use.** Every call returns a new refresh token and kills the one ' +
        'presented. Presenting a token that was already spent means two parties hold it, so the ' +
        'server assumes theft and revokes *every* session on the account — both parties must then ' +
        'log in with the password.\n\n' +
        'Also rejects tokens that predate a password change, role change or deactivation, and ' +
        'returns the refreshed `user` so a dashboard resuming a session need not also call ' +
        '`/api/auth/me`.',
      requestBody: { required: true, content: json('#/components/schemas/RefreshRequest') },
      responses: {
        200: { description: 'New token pair', content: json('#/components/schemas/AuthResponse') },
        400: errors[400],
        401: {
          description: 'Invalid, expired, revoked or already-used refresh token',
          content: json('#/components/schemas/ErrorResponse'),
        },
        429: errors[429],
        500: errors[500],
      },
    },
  },

  '/api/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke a refresh token',
      description:
        'Send `refresh_token` to end that one session; send `all: true` to end every session on ' +
        'the account.\n\n' +
        'Ending one session does **not** invalidate its access token — access tokens are stateless ' +
        'and simply expire, which is the cost of not hitting the database on every request. ' +
        '`all: true` does retire them, so that is the option for a lost device.\n\n' +
        'Revoking an already-revoked token is not an error; it reports `sessions_revoked: 0`.',
      security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: json('#/components/schemas/LogoutRequest') },
      responses: {
        200: { description: 'Signed out', content: json('#/components/schemas/LogoutResponse') },
        400: errors[400],
        401: errors[401],
        500: errors[500],
      },
    },
  },

  '/api/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'The current user, their role, permissions and projects',
      description:
        'Read fresh from the database on every call, so a role change or a revoked project is ' +
        'reflected immediately rather than when the token expires.',
      security: [{ BearerAuth: [] }],
      responses: {
        200: { description: 'Profile', content: json('#/components/schemas/ProfileResponse') },
        401: errors[401],
        500: errors[500],
      },
    },
  },

  '/api/auth/change-password': {
    post: {
      tags: ['Auth'],
      summary: 'Change your own password',
      description:
        'Retires every access token issued before now and drops every refresh session — including ' +
        'any an attacker may already hold — then returns a fresh pair so the current session is ' +
        'not signed out. Every other device has to log in again.',
      security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: json('#/components/schemas/ChangePasswordRequest') },
      responses: {
        200: {
          description: 'Password changed; use the returned tokens from now on',
          content: json('#/components/schemas/ChangePasswordResponse'),
        },
        400: errors[400],
        401: { description: 'Current password is incorrect', content: json('#/components/schemas/ErrorResponse') },
        500: errors[500],
      },
    },
  },
};

// ------------------------------------------------------------------ projects
const projectPaths = {
  '/api/projects': {
    post: {
      tags: ['Projects'],
      summary: 'Create a project and issue its Intozi API key',
      description:
        '**Super admin only.** Returns the plaintext `api_key` exactly once — only its SHA-256 is ' +
        'stored, so a lost key must be rotated, not recovered.\n\n' +
        'The `group_id` chosen here is what the customer configures in Intozi and what arrives on ' +
        'every event. It cannot be changed afterwards.',
      security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: json('#/components/schemas/CreateProjectRequest') },
      responses: {
        201: { description: 'Project created', content: json('#/components/schemas/ProjectCreated') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: { description: 'group_id already in use', content: json('#/components/schemas/ErrorResponse') },
        500: errors[500],
      },
    },
    get: {
      tags: ['Projects'],
      summary: 'List projects',
      description:
        'A super admin sees every project; a customer admin sees only the ones assigned to them.',
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'search',
          in: 'query',
          schema: { type: 'string', maxLength: 100 },
          description: 'Partial, case-insensitive match on group_id, project name or customer name.',
        },
        { name: 'is_active', in: 'query', schema: { type: 'boolean' } },
        ...pagingParams,
      ],
      responses: {
        200: { description: 'Projects', content: json('#/components/schemas/ProjectList') },
        400: errors[400],
        401: errors[401],
        500: errors[500],
      },
    },
  },

  '/api/projects/{group_id}': {
    get: {
      tags: ['Projects'],
      summary: 'One project, its gates and live counts',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam],
      responses: {
        200: { description: 'Project', content: json('#/components/schemas/ProjectResponse') },
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
    patch: {
      tags: ['Projects'],
      summary: 'Update a project',
      description:
        '**Super admin only.** `group_id` is immutable — it is stamped on every event already ' +
        'ingested and configured on the cameras themselves.',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam],
      requestBody: { required: true, content: json('#/components/schemas/UpdateProjectRequest') },
      responses: {
        200: { description: 'Updated', content: json('#/components/schemas/ProjectResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/projects/{group_id}/rotate-key': {
    post: {
      tags: ['Projects'],
      summary: 'Issue a new Intozi API key',
      description:
        '**Super admin only.** The previous key stops working immediately, so the cameras for this ' +
        'project will fail until the new key reaches the site. The new key is shown once.',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam],
      responses: {
        200: { description: 'Rotated', content: json('#/components/schemas/ProjectCreated') },
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/projects/{group_id}/devices': {
    post: {
      tags: ['Projects'],
      summary: 'Add a gate to the project',
      description:
        'Gates are the `device_name` values Intozi sends: entry1, exit1, exit2 and so on. Names are ' +
        'unique within a project, case-insensitively.\n\n' +
        'A gate that was auto-registered by an incoming event is *completed* by this call rather ' +
        'than rejected as a duplicate.',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam],
      requestBody: { required: true, content: json('#/components/schemas/AddDeviceRequest') },
      responses: {
        201: { description: 'Device added', content: json('#/components/schemas/ProjectResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        409: { description: 'Device already exists', content: json('#/components/schemas/ErrorResponse') },
        500: errors[500],
      },
    },
  },

  '/api/projects/{group_id}/devices/{device_name}': {
    patch: {
      tags: ['Projects'],
      summary: 'Update a gate',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam, deviceNameParam],
      requestBody: { required: true, content: json('#/components/schemas/UpdateDeviceRequest') },
      responses: {
        200: { description: 'Device updated', content: json('#/components/schemas/ProjectResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove a gate',
      description:
        'Events already ingested from this gate are untouched — they record the device name as ' +
        'sent, not a reference to this list.',
      security: [{ BearerAuth: [] }],
      parameters: [groupIdParam, deviceNameParam],
      responses: {
        200: { description: 'Device removed', content: json('#/components/schemas/ProjectResponse') },
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },
};

// --------------------------------------------------------------------- users
const userPaths = {
  '/api/users': {
    post: {
      tags: ['Users'],
      summary: 'Create a user',
      description:
        '**Super admin only.** Unlike signup, this can set the role and assign projects up front, ' +
        'and it is the only way to create another super admin.',
      security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: json('#/components/schemas/CreateUserRequest') },
      responses: {
        201: { description: 'User created', content: json('#/components/schemas/UserResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: { description: 'Email already registered', content: json('#/components/schemas/ErrorResponse') },
        500: errors[500],
      },
    },
    get: {
      tags: ['Users'],
      summary: 'List dashboard users',
      description: '**Super admin only.** Filter by `group_id` to answer "who can see this project?".',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
        { name: 'role', in: 'query', schema: { type: 'string', enum: ['super_admin', 'admin'] } },
        {
          name: 'group_id',
          in: 'query',
          schema: { type: 'string', example: 'ACME_MALL' },
          description: 'Only users assigned to this project.',
        },
        { name: 'is_active', in: 'query', schema: { type: 'boolean' } },
        ...pagingParams,
      ],
      responses: {
        200: { description: 'Users', content: json('#/components/schemas/UserList') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        500: errors[500],
      },
    },
  },

  '/api/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'One user',
      security: [{ BearerAuth: [] }],
      parameters: [userIdParam],
      responses: {
        200: { description: 'User', content: json('#/components/schemas/UserResponse') },
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/users/{id}/projects': {
    put: {
      tags: ['Users'],
      summary: 'Grant or revoke project access',
      description:
        '**Super admin only — this is the access grant itself.** A signed-up user sees nothing ' +
        'until a `group_id` lands here.\n\n' +
        'Takes effect on the user\'s very next request: the auth layer reloads the user rather ' +
        'than trusting their token, so no re-login is needed and a revocation is immediate.\n\n' +
        'Assigning a `group_id` that does not exist is rejected, because a typo would silently ' +
        'grant access to nothing and look like a bug.',
      security: [{ BearerAuth: [] }],
      parameters: [userIdParam],
      requestBody: { required: true, content: json('#/components/schemas/AssignProjectsRequest') },
      responses: {
        200: { description: 'Access updated', content: json('#/components/schemas/UserResponse') },
        400: { description: 'Unknown group_id, or the target is a super admin', content: json('#/components/schemas/ErrorResponse') },
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/users/{id}/role': {
    patch: {
      tags: ['Users'],
      summary: 'Change a user’s role',
      description:
        '**Super admin only.** Signs the user out, since a role change is an authorisation change. ' +
        'Refuses to change your own role, or to demote the last active super admin.',
      security: [{ BearerAuth: [] }],
      parameters: [userIdParam],
      requestBody: { required: true, content: json('#/components/schemas/SetRoleRequest') },
      responses: {
        200: { description: 'Role changed', content: json('#/components/schemas/UserResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/users/{id}/status': {
    patch: {
      tags: ['Users'],
      summary: 'Activate or deactivate a user',
      description:
        '**Super admin only.** Deactivating retires their outstanding tokens, so access ends on ' +
        'their next request. Refuses to deactivate yourself or the last active super admin.',
      security: [{ BearerAuth: [] }],
      parameters: [userIdParam],
      requestBody: { required: true, content: json('#/components/schemas/SetStatusRequest') },
      responses: {
        200: { description: 'Status changed', content: json('#/components/schemas/UserResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },

  '/api/users/{id}/reset-password': {
    post: {
      tags: ['Users'],
      summary: 'Set a user’s password',
      description:
        '**Super admin only.** For the "customer forgot their password" case. Signs them out of ' +
        'every session.',
      security: [{ BearerAuth: [] }],
      parameters: [userIdParam],
      requestBody: { required: true, content: json('#/components/schemas/ResetPasswordRequest') },
      responses: {
        200: { description: 'Password reset', content: json('#/components/schemas/UserResponse') },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        500: errors[500],
      },
    },
  },
};

// ---------------------------------------------------------------------- logs
const logPaths = {
  '/api/logs': {
    get: {
      tags: ['Logs'],
      summary: 'Detection log for the internal dashboard',
      description:
        'The ANPR events themselves, with the owner resolved — **dashboard only**. A dashboard JWT ' +
        'is the only credential accepted, so a camera or Intozi API key cannot read this. That is ' +
        'the separation that matters: `GET /api/feed` reads the *registry* and discloses three ' +
        'fields, while this reads the *events* and names the owner.\n\n' +
        'Scoped to the caller. A super admin reads every project; a customer admin reads only the ' +
        'projects assigned to them; an account with no assignments sees nothing at all rather than ' +
        'everything. Omit `group_id` for all of the caller’s projects, or name one to narrow — ' +
        'naming a project outside the caller’s scope is a 403, not an empty list.\n\n' +
        '`owner_name` comes from the event when the camera sent one, and otherwise from the ' +
        'registered-vehicle registry matched on `(group_id, vehicle_number)`; `owner_name_source` ' +
        'says which, or is null when the plate is unknown. `vehicle_type` is the status as judged ' +
        'at detection time, so a registration expiring today cannot rewrite last week’s rows.',
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'group_id',
          in: 'query',
          schema: { type: 'string', example: 'ACME_MALL' },
          description: 'Narrow to one project. Omit for every project the caller can see.',
        },
        {
          name: 'search',
          in: 'query',
          schema: { type: 'string', maxLength: 100 },
          description:
            'Partial, case-insensitive match on vehicle number, owner name or vehicle model — the ' +
            'three columns this table shows.',
        },
        {
          name: 'vehicle_type',
          in: 'query',
          schema: { type: 'string', enum: ['registered', 'unregistered'] },
        },
        {
          name: 'device_name',
          in: 'query',
          schema: { type: 'string', example: 'entry1' },
          description: 'Exact gate, matched case-insensitively.',
        },
        {
          name: 'from',
          in: 'query',
          schema: { type: 'string', example: '2026-08-01' },
          description:
            'Detections at or after this instant. A bare date starts at 00:00:00 UTC of that day; ' +
            'a timestamp with no offset is read as UTC.',
        },
        {
          name: 'to',
          in: 'query',
          schema: { type: 'string', example: '2026-08-07' },
          description:
            'Detections at or before this instant. A bare date covers the **whole** day — ' +
            '`to=2026-08-07` includes the 7th.',
        },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        },
      ],
      responses: {
        200: { description: 'Detections', content: json('#/components/schemas/VehicleLogList') },
        400: errors[400],
        401: errors[401],
        403: { description: 'group_id is outside your scope', content: json('#/components/schemas/ErrorResponse') },
        500: errors[500],
      },
    },
  },
};

module.exports = { authPaths, projectPaths, userPaths, logPaths };
