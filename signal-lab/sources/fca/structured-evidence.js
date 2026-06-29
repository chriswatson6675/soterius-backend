'use strict';

// structured-evidence.js — builder for a traceable structured evidence record.
//
// Reference Collector v0.1 — PHASE 5 (IMP-FCA-001 §5; CCS-FCA-001 §7).
//
// A structured evidence record is a VIEW of a value already present in a preserved
// raw artefact, carrying enough provenance to answer "exactly where in the
// preserved evidence did this value originate?" — run, endpoint, raw artefact +
// line, and the JSON path within that artefact's body. The `value` is the verbatim
// parsed sub-tree; it adds no facts and is never richer than the raw [CR-FCA-02].
//
// Authority: CCS-FCA-001 §7 (extraction), §8 (provenance foundation);
//   CCD-FCA-001 CR-FCA-02/06.

/**
 * Build a structured evidence record from a preserved raw line + an enumerated item.
 * @param {Object} rawLine - a parsed line from raw/<endpointId>.ndjson (Phase 4)
 * @param {Object} meta - { artefact: filename, lineNumber }
 * @param {Object} it - an enumerated item { objectType, path, jsonPath, value, key, unrecognised? }
 */
function buildStructured(rawLine, meta, it) {
  const rec = {
    // ── traceability (CCS-FCA-001 §7 + §8) ──
    runId: rawLine.runId ?? null,
    family: rawLine.family ?? null,
    anchor: rawLine.anchor ?? null,
    endpointId: rawLine.endpointId ?? null,
    dependencyId: rawLine.dependencyId ?? null,
    fcaStatus: rawLine.fcaEnvelope ? (rawLine.fcaEnvelope.status ?? null) : null,
    rawArtefact: meta.artefact,        // e.g. "firm.address.ndjson"
    rawLine: meta.lineNumber,          // 1-based line within that artefact
    pageSequence: rawLine.pageSequence ?? null,
    // ── location within the preserved body ──
    objectType: it.objectType,
    key: it.key ?? null,
    jsonPath: it.jsonPath,
    path: it.path,
    // ── the evidence value, VERBATIM ──
    value: it.value,
  };
  if (it.unrecognised) rec.unrecognised = true;
  return rec;
}

module.exports = { buildStructured };
