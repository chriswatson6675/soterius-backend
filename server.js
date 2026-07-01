require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
const scanRouter             = require('./api/routes/scan');
const reportRouter           = require('./api/routes/report');
const gateRouter             = require('./api/routes/gate');
const prospectsRouter        = require('./api/routes/prospects');
const organisationsRouter    = require('./api/routes/organisations');
const scansRouter            = require('./api/routes/scans');
const benchmarksRouter       = require('./api/routes/benchmarks');
const improvementQueueRouter = require('./api/routes/improvement-queue');
const logger = require('./infra/utils/logger');
const { AppError } = require('./infra/utils/errors');


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

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // explicit preflight handler for all routes
app.use(express.json());
app.use((req, _res, next) => { logger.info(`${req.method} ${req.path} — origin: ${req.headers.origin ?? 'none'}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.use('/api/scan',              scanRouter);
app.use('/api/gate',              gateRouter);
app.use('/api/prospects',         prospectsRouter);
app.use('/api/organisations',     organisationsRouter);
app.use('/api/scans',             scansRouter);
app.use('/api/benchmarks',        benchmarksRouter);
app.use('/api/improvement-queue', improvementQueueRouter);
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
