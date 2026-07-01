'use strict';

// worker-health.test.js — operational health-state tests (operational data only).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createHealth, STATUS } = require('./worker-health');

function fixedClock(seq) { let i = 0; return () => new Date(seq[Math.min(i++, seq.length - 1)]); }

test('snapshot exposes operational state only (no evidence/reports/org data)', () => {
  const h = createHealth({ clock: fixedClock(['2026-06-29T00:00:00Z', '2026-06-29T00:00:30Z']) });
  h.setStatus(STATUS.IDLE);
  const snap = h.snapshot();
  const keys = Object.keys(snap).sort();
  assert.deepStrictEqual(keys, [
    'cyclesCompleted', 'lastCheckAt', 'lastCollectionAt', 'lastCollectionRunId', 'lastError',
    'lastSkipReason', 'lastSnapshotProductionTimestamp', 'polling', 'startedAt', 'status', 'uptimeSeconds', 'worker',
  ]);
  assert.strictEqual(snap.worker, 'sra-worker');
  assert.strictEqual(snap.status, 'idle');
  assert.strictEqual(snap.uptimeSeconds, 30);
});

test('tracks check, collection, skip, error, and cycle count', () => {
  const h = createHealth({ clock: fixedClock(['2026-06-29T00:00:00Z']) });
  h.markCheck();
  h.markCollected('SNAP-1', '2026-06-28T23:00:00Z');
  h.afterCycle();
  let s = h.snapshot();
  assert.strictEqual(s.lastCollectionRunId, 'SNAP-1');
  assert.strictEqual(s.lastSnapshotProductionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(s.cyclesCompleted, 1);

  h.markSkipped('up-to-date'); h.afterCycle();
  h.markError('boom'); h.afterCycle();
  s = h.snapshot();
  assert.strictEqual(s.lastSkipReason, 'up-to-date');
  assert.strictEqual(s.lastError.message, 'boom');
  assert.strictEqual(s.cyclesCompleted, 3);
});

test('writeStatusFile persists the snapshot as JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-health-'));
  const file = path.join(dir, 'worker-status.json');
  const h = createHealth({ statusFile: file });
  h.setStatus(STATUS.COLLECTING);
  h.afterCycle();
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.status, 'collecting');
  assert.strictEqual(written.cyclesCompleted, 1);
});

test('serve exposes the snapshot over HTTP', async () => {
  const h = createHealth();
  h.setStatus(STATUS.SLEEPING);
  const server = h.serve(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  server.close();
  assert.strictEqual(JSON.parse(body).status, 'sleeping');
});
