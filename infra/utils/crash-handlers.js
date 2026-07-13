'use strict';

// crash-handlers.js — process-level uncaughtException/unhandledRejection
// safety net (Production Readiness Audit, 2026-07-13, ENG-043).
//
// Found during the audit: server.js had no handler for either event. Node
// already terminates the process on an uncaught exception, and (since Node
// 15) on an unhandled rejection too — so this isn't "prevent a crash", it's
// "make the crash diagnosable". Without this, the only trace of what killed
// the process is whatever Node's default handler happens to print to
// stderr, with no consistent format and no guarantee it reaches the same
// log pipeline as every other line the app emits via infra/utils/logger.js.
// Railway's own restartPolicy (railway.json: ON_FAILURE, max 10 retries)
// already recovers the process — this module only makes sure the reason
// for that restart is actually visible.
//
// Deliberately still exits after logging (never tries to keep running past
// an uncaught exception/unhandled rejection — that risks continuing in a
// corrupted state, the exact hazard these events exist to signal). Exit is
// injectable so tests can observe the call without killing the test runner.

function registerCrashHandlers({ logger = require('./logger'), exit = process.exit } = {}) {
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException — ${err && err.stack ? err.stack : err}`);
    exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    logger.error(`unhandledRejection — ${detail}`);
    exit(1);
  });
}

module.exports = { registerCrashHandlers };
