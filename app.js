const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const config = require('./config/env');
const swaggerSpec = require('./docs/swagger');

const anprRoutes = require('./routes/anpr');
const healthRoutes = require('./routes/health');

const sanitize = require('./middleware/sanitize');
const { apiLimiter } = require('./middleware/rateLimiter');
const { requestId, requestLogger, responseTime } = require('./middleware/requestContext');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

/**
 * Express application wiring. Kept free of side effects (no listen, no DB
 * connection) so it can be imported by tests as-is — server.js owns the runtime.
 */
const app = express();

// Required for correct req.ip / rate limiting behind a proxy or load balancer.
app.set('trust proxy', config.TRUST_PROXY);
app.disable('x-powered-by');

// ---- Observability (first, so every request is traceable) ----
app.use(requestId);
app.use(responseTime);
app.use(requestLogger);

// ---- Security ----
app.use(
  helmet({
    // Swagger UI needs inline styles/scripts; keep the rest of the defaults.
    contentSecurityPolicy: config.SWAGGER_ENABLED ? false : undefined,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin: config.CORS_ORIGIN === '*' ? '*' : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Request-Id'],
    maxAge: 86400,
  })
);

// ---- Body parsing (base64 images make these payloads large) ----
app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: config.JSON_BODY_LIMIT }));
app.use(sanitize);

// ---- Static access to stored images (optional) ----
if (config.SERVE_UPLOADS) {
  app.use(
    config.UPLOAD_PUBLIC_PATH,
    express.static(config.UPLOAD_DIR, { maxAge: '7d', index: false, dotfiles: 'ignore' })
  );
}

// ---- API documentation ----
if (config.SWAGGER_ENABLED) {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, { customSiteTitle: 'ANPR API Docs' })
  );
  app.get('/api-docs.json', (_req, res) => res.json(swaggerSpec));
}

// ---- Routes ----
app.use('/health', healthRoutes);
app.use('/api', apiLimiter);
app.use('/api/anpr', anprRoutes);

app.get('/', (_req, res) => {
  res.json({
    name: 'Prilinesha ANPR Ingestion API',
    version: require(path.join(__dirname, 'package.json')).version,
    docs: config.SWAGGER_ENABLED ? '/api-docs' : null,
    health: '/health',
  });
});

// ---- Error pipeline (must stay last) ----
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
