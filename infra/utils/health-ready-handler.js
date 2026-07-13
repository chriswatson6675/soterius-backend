'use strict';

// /health/ready handler factory — Operational Deployment Sprint (ENG-044,
// 2026-07-13). Separated from server.js (mirrors crash-handlers.js's own
// reasoning) so it's unit-testable without server.js's side-effecting
// httpServer.listen() at require-time, and follows this codebase's existing
// route-handler-factory convention (api/routes/trust-profile.js).
//
// Liveness (/health) vs. readiness (/health/ready) — /health stays process-
// alive-only, since railway.json's healthcheckPath/restartPolicy depend on
// it and a slow/down database must never restart an otherwise-healthy
// process. This is the separate, additive endpoint for monitoring tools that
// specifically want database reachability.

function createHealthReadyHandler(deps = {}) {
  const getClient = deps.getClient || require('../database').getClient;
  const timeoutMs = deps.timeoutMs ?? 3000;

  return async function healthReady(req, res) {
    try {
      const client = getClient();
      const dbCheck = client.from('schema_migrations').select('version').limit(1);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('database check timed out')), timeoutMs));
      const { error } = await Promise.race([dbCheck, timeout]);
      if (error) throw new Error(error.message);
      res.status(200).json({ status: 'ok', database: 'reachable', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message, timestamp: new Date().toISOString() });
    }
  };
}

module.exports = { createHealthReadyHandler };
