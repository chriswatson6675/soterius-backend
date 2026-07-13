require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
const scanRouter             = require('./api/routes/scan');
const reportRouter           = require('./api/routes/report');
const gateRouter             = require('./api/routes/gate');
const prospectsRouter        = require('./api/routes/prospects');
const scansRouter            = require('./api/routes/scans');
const benchmarksRouter       = require('./api/routes/benchmarks');
const improvementQueueRouter = require('./api/routes/improvement-queue');
const meRouter               = require('./api/routes/me');
const portfolioRouter        = require('./api/routes/portfolio');
const organisationRouter     = require('./api/routes/organisation');
const renewalRouter          = require('./api/routes/renewal');
const observationSessionsRouter = require('./api/routes/observation-sessions');
const publicScanRouter       = require('./api/routes/public-scan');
const populationImportsRouter = require('./api/routes/population-imports');
const trustProfileRouter     = require('./api/routes/trust-profile');
const logger = require('./infra/utils/logger');
const { AppError } = require('./infra/utils/errors');
const { registerCrashHandlers } = require('./infra/utils/crash-handlers');
const { createHealthReadyHandler } = require('./infra/utils/health-ready-handler');

// Production Readiness Audit (2026-07-13, ENG-043): make an otherwise-fatal
// uncaughtException/unhandledRejection diagnosable in the logs before the
// process exits and Railway's own restartPolicy (railway.json: ON_FAILURE,
// max 10 retries) recovers it — see infra/utils/crash-handlers.js.
registerCrashHandlers({ logger });


// ── CORS origin whitelist ─────────────────────────────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list of exact origins or glob patterns.
// Use '*' as a wildcard for a single domain segment, e.g.:
//   https://soterius-*.vercel.app  → matches any Vercel preview deployment
const DEFAULT_ORIGINS = [
  'http://localhost:3000',  // Next.js dev (Phase 2A+)
  'http://localhost:5173',  // legacy Vite dev
  'https://soterius-frontend.vercel.app',
  'https://soterius-*.vercel.app',
];

const CORS_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser: health checks, Postman, server-to-server
  return CORS_ORIGINS.some(pattern => {
    if (pattern === origin) return true;
    if (!pattern.includes('*')) return false;
    // Convert glob pattern → regex: escape specials, then replace * with [^.]+
    const re = new RegExp(
      '^' +
      pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') +
      '$'
    );
    return re.test(origin);
  });
}

const corsOptions = {
  // cb(null, false) → cors package returns 403; cb(new Error) → leaks as 500
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
};

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// ENG-010 §2.3/§8 (T1.1, ENG-013 WP1): Railway terminates the public
// connection and forwards to this container behind its own edge — without
// this setting, req.ip reflects Railway's internal forwarding address, not
// the real client, which would silently defeat every IP-keyed control the
// public scan protection layer (backend/api/middleware/publicScan*.js)
// depends on. Configurable via TRUST_PROXY (default: 1 hop) because the
// exact proxy depth must be verified against Railway's live topology, not
// guessed (ENG-010 §10 open question 2 — carried forward, not resolved by
// this default; confirm before relying on IP-keyed limits in production).
const trustProxyDepth = process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', trustProxyDepth);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // explicit preflight handler for all routes
app.use(express.json());
app.use((req, _res, next) => { logger.info(`${req.method} ${req.path} — origin: ${req.headers.origin ?? 'none'}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Operational Deployment Sprint (ENG-044, 2026-07-13): /health is process-
// alive-only (ENG-043's own finding) and stays that way — it's what
// railway.json's healthcheckPath/restartPolicy depend on, and a slow or
// down database must never cause Railway to restart an otherwise-healthy
// process in a crash-restart loop. /health/ready is a SEPARATE, additive
// endpoint (liveness vs. readiness — standard practice, not a redesign of
// the existing healthcheck) for monitoring tools that specifically want to
// know whether the database is reachable. See infra/utils/health-ready-handler.js.
app.get('/health/ready', createHealthReadyHandler());


app.use('/api/scan',              scanRouter);
app.use('/api/gate',              gateRouter);
app.use('/api/prospects',         prospectsRouter);
app.use('/api/scans',             scansRouter);
app.use('/api/benchmarks',        benchmarksRouter);
app.use('/api/improvement-queue', improvementQueueRouter);
app.use('/api/me',                meRouter);
app.use('/api/portfolio',         portfolioRouter);
app.use('/api/organisation',      organisationRouter);
app.use('/api/renewal',           renewalRouter);
app.use('/api/observation-sessions', observationSessionsRouter);
app.use('/api/trust-profile',     trustProfileRouter);
app.use('/api/public-scan',       publicScanRouter);
app.use('/api/ops/acquisition',   populationImportsRouter);
app.use('/api',                   reportRouter);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
  const status  = err instanceof AppError ? err.statusCode : 500;
  const message = err instanceof AppError ? err.message    : 'Internal server error';
  if (status >= 500) {
    logger.error(`${status} — ${err.stack || err.message}`);
  } else {
    logger.error(`${status} — ${message}`);
  }
  res.status(status).json({ success: false, error: message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  logger.info(`Soterius backend running on port ${PORT}`);
  logger.info(`CORS allowed origins: ${CORS_ORIGINS.join(', ')}`);
});

module.exports = { app };
