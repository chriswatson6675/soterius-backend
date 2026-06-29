'use strict';

// worker-health.js — operational health state for the SRA worker.
//
// Exposes ONLY operational state: worker status, uptime, last successful
// collection, last snapshot production timestamp, last error, current polling
// state, cycle count. It NEVER exposes evidence, reports, or organisational data —
// it reads none of the Collection Package contents.
//
// State can be persisted to a status file (on the volume, survives restarts for
// inspection) and/or served over a minimal HTTP endpoint. Both are optional and
// operational; this module is not part of the Collection Layer.

const fs = require('node:fs');
const http = require('node:http');

const STATUS = Object.freeze({
  STARTING: 'starting',
  IDLE: 'idle',
  CHECKING: 'checking',
  COLLECTING: 'collecting',
  SLEEPING: 'sleeping',
  STOPPED: 'stopped',
});

/**
 * @param {Object} [opts] - { clock: () => Date, statusFile: string }
 */
function createHealth(opts = {}) {
  const clock = opts.clock ?? (() => new Date());
  const statusFile = opts.statusFile ?? null;
  const startedAt = clock();

  const s = {
    status: STATUS.STARTING,
    cyclesCompleted: 0,
    lastCheckAt: null,
    lastCollectionRunId: null,
    lastCollectionAt: null,
    lastSnapshotProductionTimestamp: null,
    lastSkipReason: null,
    lastError: null,
  };

  function snapshot() {
    const t = clock();
    return {
      worker: 'sra-worker',
      status: s.status,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.round((t - startedAt) / 1000)),
      cyclesCompleted: s.cyclesCompleted,
      polling: s.status === STATUS.CHECKING || s.status === STATUS.COLLECTING,
      lastCheckAt: s.lastCheckAt,
      lastCollectionRunId: s.lastCollectionRunId,
      lastCollectionAt: s.lastCollectionAt,
      lastSnapshotProductionTimestamp: s.lastSnapshotProductionTimestamp,
      lastSkipReason: s.lastSkipReason,
      lastError: s.lastError,
    };
  }

  function writeStatusFile() {
    if (!statusFile) return;
    try { fs.writeFileSync(statusFile, JSON.stringify(snapshot(), null, 2)); } catch { /* operational; ignore */ }
  }

  return {
    STATUS,
    setStatus(v) { s.status = v; },
    markCheck() { s.lastCheckAt = clock().toISOString(); },
    markSkipped(reason) { s.lastSkipReason = reason; },
    markCollected(runId, productionTimestamp) {
      s.lastCollectionRunId = runId ?? null;
      s.lastCollectionAt = clock().toISOString();
      if (productionTimestamp) s.lastSnapshotProductionTimestamp = productionTimestamp;
      s.lastSkipReason = null;
    },
    markError(message) { s.lastError = { message: String(message), at: clock().toISOString() }; },
    /** Called once per completed poll cycle: count it and persist the status file. */
    afterCycle() { s.cyclesCompleted++; writeStatusFile(); },
    snapshot,
    writeStatusFile,
    /** Optional minimal HTTP endpoint exposing the operational snapshot as JSON. */
    serve(port) {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot()));
      });
      server.listen(port);
      return server;
    },
  };
}

module.exports = { createHealth, STATUS };
