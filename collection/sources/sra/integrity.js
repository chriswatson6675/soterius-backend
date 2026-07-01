'use strict';

// integrity.js — read-only integrity verification for an SRA collection package.
//
// SRA Snapshot Collector v0.1 — Integrity layer. Adapted from the FCA Reference
// Collector's integrity verifier (same chain-walk philosophy; SRA snapshot model:
// the raw artefact is a WHOLE preserved JSON segment, navigated by the recorded
// path, with hashes validated against the append-only raw index).
//
// It verifies that every structured observation can be RECONSTRUCTED from the
// immutable raw evidence, validates raw-segment hashes against the raw index, and
// checks package consistency. It relies on NOTHING derived. It is strictly
// READ-ONLY: it never repairs, modifies, or regenerates any evidence. Results are
// deterministic (stable file/line order; pure reads).

const fs = require('node:fs');
const util = require('node:util');
const path = require('node:path');

const { rawSegmentPath, rawIndexPath, structuredDir, manifestPath } = require('./evidence-path');
const { locate } = require('./snapshot-source');
const { sha256 } = require('./preserve-snapshot');
const { STRUCTURED_FILE } = require('./extract');

function structuredFilePath(runDir) { return path.join(structuredDir(runDir), STRUCTURED_FILE); }

// Iterate an NDJSON file line-by-line via a Buffer (not a single utf8 string), so
// the structured file is handled even when it exceeds V8's max string length
// (~512 MB) at production scale. The collector terminates lines with '\n'.
function eachLine(file, fn) {
  const buf = fs.readFileSync(file);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > start) fn(buf.toString('utf8', start, i)); start = i + 1; }
  }
  if (start < buf.length) fn(buf.toString('utf8', start, buf.length));
}

/** Load + parse a raw segment once (cached). status: 'ok' | 'missing' | 'unparseable'. */
function loadSegment(cache, runDir, rawArtefact) {
  if (!(rawArtefact in cache)) {
    const file = rawSegmentPath(runDir, rawArtefact);
    if (!fs.existsSync(file)) cache[rawArtefact] = { status: 'missing' };
    else {
      try { cache[rawArtefact] = { status: 'ok', body: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
      catch { cache[rawArtefact] = { status: 'unparseable' }; }
    }
  }
  return cache[rawArtefact];
}

/**
 * Verify one structured record: rawArtefact + path + value. Read-only; never throws.
 * @returns {{ ok, located, equal, reason? }}
 */
function verifyRecord(runDir, rec, cache = {}) {
  if (!rec || !rec.rawArtefact) return { ok: false, located: false, equal: false, reason: 'no rawArtefact reference' };
  if (!Array.isArray(rec.path)) return { ok: false, located: false, equal: false, reason: 'no path reference' };
  const seg = loadSegment(cache, runDir, rec.rawArtefact);
  if (seg.status === 'missing') return { ok: false, located: false, equal: false, reason: 'raw artefact missing' };
  if (seg.status === 'unparseable') return { ok: false, located: false, equal: false, reason: 'raw artefact not JSON-parseable' };
  const recovered = locate(seg.body, rec.path);
  const equal = util.isDeepStrictEqual(recovered, rec.value);
  return { ok: equal, located: true, equal, reason: equal ? undefined : 'value mismatch at path' };
}

/**
 * Validate every raw segment file against its recorded hash + byte length in the
 * append-only raw index. Read-only.
 * @returns {{ indexPresent, checked, verified, failures }}
 */
function verifyRawHashes(runDir) {
  const idxPath = rawIndexPath(runDir);
  if (!fs.existsSync(idxPath)) return { indexPresent: false, checked: 0, verified: 0, failures: [] };
  const lines = fs.readFileSync(idxPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  let verified = 0; const failures = [];
  for (const r of lines) {
    const file = rawSegmentPath(runDir, r.file);
    if (!fs.existsSync(file)) { failures.push({ file: r.file, reason: 'missing' }); continue; }
    const buf = fs.readFileSync(file);
    const digest = sha256(buf);
    if (digest !== r.sha256) failures.push({ file: r.file, reason: 'sha256 mismatch' });
    else if (r.byteLength != null && buf.length !== r.byteLength) failures.push({ file: r.file, reason: 'byteLength mismatch' });
    else verified++;
  }
  return { indexPresent: true, checked: lines.length, verified, failures };
}

/**
 * Verify every structured record reconstructs from the immutable raw. Read-only.
 * @returns {{ total, verified, failures, ok }}
 */
function verifyRun(runDir) {
  const f = structuredFilePath(runDir);
  if (!fs.existsSync(f)) throw new Error(`no structured evidence at ${f}`);
  const cache = {};
  let total = 0; let verified = 0; const failures = [];
  eachLine(f, (line) => {
    total++;
    let rec;
    try { rec = JSON.parse(line); }
    catch { failures.push({ reason: 'structured line not JSON-parseable' }); return; }
    const v = verifyRecord(runDir, rec, cache);
    if (v.ok) verified++;
    else failures.push({ objectType: rec.objectType, jsonPath: rec.jsonPath, rawArtefact: rec.rawArtefact, reason: v.reason });
  });
  return { total, verified, failures, ok: failures.length === 0 };
}

/**
 * Verify whole-package consistency: raw-segment hashes + structured reconstruction +
 * manifest/raw-index segment agreement. Read-only; deterministic.
 * @returns {Object} aggregate verification result
 */
function verifyPackage(runDir) {
  const rawHashes = verifyRawHashes(runDir);
  const records = verifyRun(runDir);

  const manifest = fs.existsSync(manifestPath(runDir)) ? JSON.parse(fs.readFileSync(manifestPath(runDir), 'utf8')) : null;
  const segmentsDeclared = manifest && Array.isArray(manifest.segments) ? manifest.segments.length : null;
  const segmentsIndexed = rawHashes.indexPresent ? rawHashes.checked : null;
  const manifestConsistent = segmentsDeclared == null || segmentsIndexed == null || segmentsDeclared === segmentsIndexed;

  const ok = rawHashes.failures.length === 0 && records.ok && manifestConsistent;
  return {
    ok,
    rawHashes,
    records: { total: records.total, verified: records.verified, failures: records.failures },
    manifest: { segmentsDeclared, segmentsIndexed, consistent: manifestConsistent },
  };
}

module.exports = { verifyRecord, verifyRawHashes, verifyRun, verifyPackage };
