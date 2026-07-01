'use strict';

// snapshot-run-model.js — build a read-only reporting model from a Collection Package.
//
// SRA Snapshot Collector v0.1 — Reporting layer (read-only).
//
// Reads the package's persisted artefacts (manifest, raw index, structured
// evidence, provenance lineage, the SEALED marker) and assembles a generic run
// model the report builders consume. It NEVER modifies, regenerates, or repairs any
// artefact, NEVER recomputes provenance or integrity, and knows nothing about
// Railway. Integrity results are READ (from the SEALED marker, or supplied by the
// caller via opts.integrity) — never recomputed here.
//
// The model is source-agnostic; SRA-specific metadata is injected separately via a
// report profile.

const fs = require('node:fs');
const path = require('node:path');

const { manifestPath, rawIndexPath, structuredDir, provenanceDir, sealPath } = require('./evidence-path');
const { STRUCTURED_FILE } = require('./extract');

const LINEAGE_FILE = 'lineage.ndjson';

function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }

// Iterate an NDJSON file line-by-line via a Buffer (not one utf8 string), so files
// larger than V8's max string length (~512 MB) are handled at production scale.
// Returns true if the file existed. The collector terminates lines with '\n'.
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
function readLines(file) {
  if (!fs.existsSync(file)) return null;
  const out = [];
  eachLine(file, (l) => { try { out.push(JSON.parse(l)); } catch { /* skip unparseable */ } });
  return out;
}

/**
 * Build the read-only reporting model for a collection package.
 *
 * @param {string} runDir
 * @param {Object} [opts] - { integrity } (a fresh verification result; otherwise the
 *                          SEALED marker's embedded summary is used, else null)
 * @returns {Object} the run model
 */
function loadRunModel(runDir, opts = {}) {
  const manifest = readJson(manifestPath(runDir));

  const rawIndex = readLines(rawIndexPath(runDir));
  const rawIndexPresent = rawIndex !== null;

  // Structured evidence — single read pass for counts (no record values copied out).
  const sFile = path.join(structuredDir(runDir), STRUCTURED_FILE);
  let recordCount = 0;
  const byObjectType = {};
  const anchors = new Set();
  const unrecognised = [];
  const structuredPresent = eachLine(sFile, (line) => {
    let rec; try { rec = JSON.parse(line); } catch { return; }
    recordCount++;
    byObjectType[rec.objectType] = (byObjectType[rec.objectType] || 0) + 1;
    if (rec.anchor != null) anchors.add(rec.anchor);
    if (rec.unrecognised) unrecognised.push({ objectType: rec.objectType, jsonPath: rec.jsonPath, rawArtefact: rec.rawArtefact, anchor: rec.anchor ?? null });
  });

  // Lineage — count lines without building an array or a giant string.
  let lineageCount = 0;
  const provenancePresent = eachLine(path.join(provenanceDir(runDir), LINEAGE_FILE), () => { lineageCount++; });

  const seal = readJson(sealPath(runDir));
  const sealed = seal !== null;

  const integrity = opts.integrity ?? (seal && seal.details && seal.details.integrity) ?? null;

  return {
    runDir,
    manifest,
    rawIndex: rawIndex || [],
    rawIndexPresent,
    structured: { present: structuredPresent, recordCount, byObjectType, distinctAnchors: anchors.size, unrecognised },
    provenance: { present: provenancePresent, lineageCount },
    sealed,
    seal,
    integrity,
    artefacts: { manifest: !!manifest, rawIndex: rawIndexPresent, structured: structuredPresent, provenance: provenancePresent, sealed },
  };
}

module.exports = { loadRunModel };
