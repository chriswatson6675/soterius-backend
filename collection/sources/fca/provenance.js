'use strict';

// provenance.js — additive provenance + integrity verification for FCA evidence.
//
// Reference Collector v0.1 — PHASE 6 (IMP-FCA-001 §6; CCS-FCA-001 §8).
//
// Provenance is ADDITIVE: this module never modifies preserved raw evidence or
// structured evidence. It composes the COMPLETE reproducibility envelope by
// REUSING information already present (run manifest + preserved raw line +
// structured record) — it does not duplicate evidence values. It writes only a
// regenerable provenance INDEX under `<runDir>/provenance/lineage.ndjson`, leaving
// raw/ and structured/ byte-identical [CR-FCA-03/07/08].
//
// The envelope satisfies CCS-FCA-001 §8 (run id, collector version, API version,
// endpoint, request URI, anchor, observation + preservation timestamps, source
// authority, raw artefact id, structured artefact id) and CARRIES NO CREDENTIAL
// [CR-FCA-07].
//
// The integrity verifier walks the lineage chain
//   Run → Endpoint → Request → Raw Artefact → JSON Path → Structured Evidence
// using ONLY the preserved raw artefact and the recorded path — never derived data.
//
// Authority: CCS-FCA-001 §8; CCD-FCA-001 CR-FCA-03/07/08; IMP-FCA-001 §6.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { SOURCE_AUTHORITY } = require('./collection-run');
const { getByPath } = require('./extract-map');
const { rawDir } = require('./evidence-path');

function provenanceDir(runDir) { return path.join(runDir, 'provenance'); }
function lineagePath(runDir) { return path.join(provenanceDir(runDir), 'lineage.ndjson'); }
function structuredDir(runDir) { return path.join(runDir, 'structured'); }

/**
 * Compose the complete provenance envelope for one structured record.
 * Pure: combines run-level (manifest), observation-level (rawLine), and
 * artefact-level (structured record) provenance. NO credential, NO evidence value.
 */
function composeEnvelope(manifest, rec, rawLine) {
  const obsTs = rawLine ? (rawLine.collectionTimestamp ?? null) : null;
  return {
    // ── run level (reused from the manifest / run constants) ──
    runId: rec.runId ?? (manifest && manifest.runId) ?? null,
    collectorVersion: manifest ? (manifest.collectorVersion ?? null) : null,
    apiVersion: manifest ? (manifest.apiVersion ?? null) : null,
    sourceAuthority: SOURCE_AUTHORITY,
    // ── observation level (reused from the preserved raw line) ──
    endpointId: rec.endpointId,
    anchor: rec.anchor,
    dependencyId: rec.dependencyId ?? null,
    requestUri: rawLine ? (rawLine.requestUri ?? null) : null,
    httpStatus: rawLine ? (rawLine.httpStatus ?? null) : null,
    fcaStatus: rec.fcaStatus ?? (rawLine && rawLine.fcaEnvelope ? rawLine.fcaEnvelope.status : null),
    observationTimestamp: obsTs,
    preservationTimestamp: obsTs,
    // v0.1 stamps a single moment at preservation (the fetch precedes it by ms);
    // a distinct fetch timestamp is a future engine enhancement (see Phase 6 notes).
    timestampsDistinct: false,
    // ── artefact level (the navigable lineage pointers) ──
    rawArtefact: rec.rawArtefact,
    rawLine: rec.rawLine,
    pageSequence: rec.pageSequence ?? null,
    structuredArtefact: rec.rawArtefact, // same basename under structured/
    objectType: rec.objectType,
    key: rec.key ?? null,
    jsonPath: rec.jsonPath,
    path: rec.path,
    // ── the explicit, navigable chain ──
    chain: [
      `run:${rec.runId ?? (manifest && manifest.runId) ?? '?'}`,
      `endpoint:${rec.endpointId}`,
      `request:${rawLine ? (rawLine.requestUri ?? '?') : '?'}`,
      `raw:raw/${rec.rawArtefact}#L${rec.rawLine}`,
      `jsonPath:${rec.jsonPath}`,
      `structured:structured/${rec.rawArtefact}`,
    ],
  };
}

/** Read a specific 1-based line of a preserved raw artefact (cached). */
function _readRawLine(cache, runDir, rawArtefact, lineNumber) {
  if (!cache[rawArtefact]) {
    const file = path.join(rawDir(runDir), rawArtefact);
    cache[rawArtefact] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : null;
  }
  const lines = cache[rawArtefact];
  if (!lines || lineNumber < 1 || lineNumber > lines.length) return null;
  try { return JSON.parse(lines[lineNumber - 1]); } catch { return null; }
}

/**
 * Verify the integrity of one structured record by walking its lineage to the
 * preserved raw artefact and recovering the value at the recorded JSON path.
 * Relies on NOTHING derived. Never throws.
 *
 * @returns {{ ok: boolean, located: boolean, equal: boolean, reason?: string, requestUri?: string|null }}
 */
function verifyIntegrity(runDir, rec, cache = {}) {
  const rawLine = _readRawLine(cache, runDir, rec.rawArtefact, rec.rawLine);
  if (!rawLine) return { ok: false, located: false, equal: false, reason: 'raw artefact/line not found' };
  if (rawLine.rawBody == null) return { ok: false, located: true, equal: false, reason: 'raw body is null' };
  let body;
  try { body = JSON.parse(rawLine.rawBody); }
  catch { return { ok: false, located: true, equal: false, reason: 'raw body not JSON-parseable' }; }
  const recovered = getByPath(body, rec.path);
  const equal = util.isDeepStrictEqual(recovered, rec.value);
  return { ok: equal, located: true, equal, requestUri: rawLine.requestUri ?? null, reason: equal ? undefined : 'value mismatch at path' };
}

/** Verify every structured record in a run. */
function verifyRun(runDir) {
  const sDir = structuredDir(runDir);
  if (!fs.existsSync(sDir)) throw new Error(`no structured evidence at ${sDir}`);
  const cache = {};
  let total = 0; let verified = 0; const failures = [];
  for (const file of fs.readdirSync(sDir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(sDir, file), 'utf8').split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      total++;
      const v = verifyIntegrity(runDir, rec, cache);
      if (v.ok) verified++; else failures.push({ endpointId: rec.endpointId, jsonPath: rec.jsonPath, reason: v.reason });
    }
  }
  return { total, verified, failures };
}

/**
 * Write the additive provenance lineage index for a run. Composes the full
 * envelope for every structured record (no value duplicated). Does NOT touch
 * raw/ or structured/. Regenerable.
 *
 * @returns {{ lineageRecords: number, lineagePath: string }}
 */
function writeLineage(runDir, manifest) {
  const sDir = structuredDir(runDir);
  if (!fs.existsSync(sDir)) throw new Error(`no structured evidence at ${sDir}`);
  fs.mkdirSync(provenanceDir(runDir), { recursive: true });
  const cache = {};
  const out = [];
  for (const file of fs.readdirSync(sDir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(sDir, file), 'utf8').split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      const rawLine = _readRawLine(cache, runDir, rec.rawArtefact, rec.rawLine);
      out.push(composeEnvelope(manifest, rec, rawLine));
    }
  }
  fs.writeFileSync(lineagePath(runDir), out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : ''));
  return { lineageRecords: out.length, lineagePath: lineagePath(runDir) };
}

module.exports = { composeEnvelope, verifyIntegrity, verifyRun, writeLineage, provenanceDir, lineagePath };
