'use strict';

// provenance.js — additive provenance for SRA structured evidence.
//
// SRA Snapshot Collector v0.1 — Provenance layer. Adapted from the FCA Reference
// Collector's provenance.js (same philosophy; SRA snapshot field set).
//
// Provenance is ADDITIVE: this module never modifies preserved raw evidence or
// structured evidence. It composes the reproducibility envelope by REUSING
// information already present (run manifest + structured record), and writes ONLY a
// regenerable provenance INDEX at `<runDir>/provenance/lineage.ndjson`. It does NOT
// derive new observations and does NOT duplicate evidence VALUES — the envelope
// carries navigable POINTERS (raw artefact + path), never the value itself; the
// value lives once, in the structured record (which lives once, in the raw).
//
// The envelope preserves: source authority, snapshot production timestamp,
// collection run identity, organisational anchor, and the raw artefact references —
// everything the lineage chain needs.
//
// Integrity VERIFICATION lives in integrity.js (read-only). This module writes.

const fs = require('node:fs');
const path = require('node:path');

const { structuredDir, provenanceDir, manifestPath } = require('./evidence-path');
const { SOURCE_AUTHORITY } = require('./snapshot-source');
const { STRUCTURED_FILE } = require('./extract');

function lineagePath(runDir) { return path.join(provenanceDir(runDir), 'lineage.ndjson'); }
function structuredFilePath(runDir) { return path.join(structuredDir(runDir), STRUCTURED_FILE); }

/** Read the run manifest, or null if absent (run-level fields are reused, not required). */
function readManifest(runDir) {
  const p = manifestPath(runDir);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * Compose the provenance envelope for one structured evidence record. Pure.
 * Reuses run-level (manifest) + observation-level (record) provenance. Carries NO
 * evidence value and NO credential.
 *
 * @param {Object|null} manifest - the run manifest (run-level fields)
 * @param {Object} rec - a structured evidence record (from structured/firm.ndjson)
 * @returns {Object} the provenance envelope
 */
function composeEnvelope(manifest, rec) {
  const runId = rec.runId ?? (manifest && manifest.runId) ?? null;
  const sourceId = rec.sourceId ?? 'sra';
  return {
    // ── run level (reused from manifest / record) ──
    runId,
    collectorVersion: manifest ? (manifest.collectorVersion ?? null) : null,
    sourceId,
    sourceAuthority: (manifest && manifest.sourceAuthority) || SOURCE_AUTHORITY,
    snapshotProductionTimestamp: rec.snapshotProductionTimestamp
      ?? (manifest && manifest.snapshotProductionTimestamp) ?? null,
    // ── observation level (reused from the structured record) ──
    anchor: rec.anchor ?? null,                 // organisational anchor (SRA number)
    objectType: rec.objectType,
    key: rec.key ?? null,
    // ── artefact level (navigable POINTERS; NO value duplicated) ──
    rawArtefact: rec.rawArtefact,
    segment: rec.segment ?? null,
    jsonPath: rec.jsonPath,
    path: rec.path,
    structuredArtefact: STRUCTURED_FILE,
    // ── the explicit, navigable lineage chain ──
    chain: [
      `run:${runId ?? '?'}`,
      `source:${sourceId}`,
      `anchor:${rec.anchor ?? '?'}`,
      `raw:raw/${rec.rawArtefact}`,
      `jsonPath:${rec.jsonPath}`,
      `structured:structured/${STRUCTURED_FILE}`,
    ],
  };
}

// Iterate an NDJSON file line-by-line via a Buffer (not a single utf8 string), so
// the structured file is handled even when it exceeds V8's max string length
// (~512 MB) at production scale. The collector terminates lines with '\n'.
function eachLine(file, fn) {
  if (!fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > start) fn(buf.toString('utf8', start, i)); start = i + 1; }
  }
  if (start < buf.length) fn(buf.toString('utf8', start, buf.length));
  return true;
}

/** Read the structured evidence records (one per line). */
function readStructured(runDir) {
  const out = [];
  eachLine(structuredFilePath(runDir), (l) => { try { out.push(JSON.parse(l)); } catch { /* skip */ } });
  return out;
}

/**
 * Write the additive provenance lineage index for a run. Composes one envelope per
 * structured record (no value duplicated). Does NOT touch raw/ or structured/.
 * Regenerable and deterministic.
 *
 * @param {string} runDir
 * @returns {{ lineageRecords: number, lineagePath: string }}
 */
// Lineage is written in batches so the whole file is never materialised as a single
// in-memory string. At production scale (~1M records) a single join() exceeds V8's
// max string length ("Invalid string length"); batched appends keep the buffered
// string small. Same file content and ordering — regenerable and deterministic.
const LINEAGE_BATCH = 5000;

function writeLineage(runDir) {
  const f = structuredFilePath(runDir);
  if (!fs.existsSync(f)) throw new Error(`no structured evidence at ${f}`);
  const manifest = readManifest(runDir);
  fs.mkdirSync(provenanceDir(runDir), { recursive: true });

  const file = lineagePath(runDir);
  fs.writeFileSync(file, ''); // (re)create; lineage is a regenerable index, never evidence
  let count = 0;
  let buf = [];
  eachLine(structuredFilePath(runDir), (line) => {
    let rec; try { rec = JSON.parse(line); } catch { return; }
    buf.push(JSON.stringify(composeEnvelope(manifest, rec)));
    count++;
    if (buf.length >= LINEAGE_BATCH) { fs.appendFileSync(file, buf.join('\n') + '\n'); buf = []; }
  });
  if (buf.length) fs.appendFileSync(file, buf.join('\n') + '\n');
  return { lineageRecords: count, lineagePath: file };
}

module.exports = { composeEnvelope, writeLineage, readStructured, lineagePath };
