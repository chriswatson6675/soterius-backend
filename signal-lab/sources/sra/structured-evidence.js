'use strict';

// structured-evidence.js — builder for a traceable SRA structured evidence record.
//
// SRA Snapshot Collector v0.1 — Extract layer. Adapted from the FCA Reference
// Collector's structured-evidence.js (same philosophy; SRA field set). Copied per
// the proven per-source replication pattern.
//
// A structured evidence record is a VIEW of a value already present in a preserved
// raw snapshot segment, carrying enough traceability to answer "exactly where in
// the preserved evidence did this value originate?" — run, source, the raw segment
// artefact, and the JSON path within that segment's parsed body. The `value` is the
// verbatim parsed sub-tree; it adds no facts, infers nothing, and is never richer
// than the raw.
//
// These fields are the FOUNDATION the future Provenance + Integrity layers build on
// (rawArtefact + path + value = the integrity triple; runId + anchor + objectType +
// jsonPath = the lineage chain). This module writes nothing and derives nothing.

/**
 * Build a structured evidence record from an extraction context + an enumerated item.
 *
 * @param {Object} context - { runId, sourceId, productionTimestamp }
 * @param {Object} meta    - { artefact: rawSegmentFileName, segment: segmentIndex }
 * @param {Object} item    - { objectType, path, jsonPath, value, key, anchor, unrecognised? }
 * @returns {Object} a structured evidence record
 */
function buildStructured(context, meta, item) {
  const rec = {
    // ── traceability (the basis for later provenance/integrity) ──
    runId: context.runId ?? null,
    sourceId: context.sourceId ?? null,
    anchor: item.anchor ?? null,               // organisational anchor (SRA number), verbatim
    rawArtefact: meta.artefact,                // preserved raw segment file (e.g. "snapshot.json")
    segment: meta.segment ?? null,             // segment index within the run
    snapshotProductionTimestamp: context.productionTimestamp ?? null,
    // ── location within the preserved segment body ──
    objectType: item.objectType,
    key: item.key ?? null,
    jsonPath: item.jsonPath,                   // human-readable, e.g. firms[0]["SRA number"]
    path: item.path,                           // navigable path array from the segment body root
    // ── the evidence value, VERBATIM ──
    value: item.value,
  };
  if (item.unrecognised) rec.unrecognised = true;
  return rec;
}

module.exports = { buildStructured };
