'use strict';

// extract.js — structured evidence extraction from preserved raw artefacts.
//
// Reference Collector v0.1 — PHASE 5 (IMP-FCA-001 §5; CCS-FCA-001 §7).
//
// Reads the immutable raw evidence preserved in a run (Phase 4), and produces
// structured evidence objects that MIRROR the FCA Evidence Inventory granularity,
// each fully traceable to its raw artefact + JSON path. Extraction operates ONLY
// on preserved raw artefacts; it never re-fetches, interprets, enriches,
// validates-against-truth, canonicalises, normalises, reformats, resolves
// references, or joins [CR-FCA-01/06/13/15].
//
// Output is written to `<runDir>/structured/<endpointId>.ndjson` (append-only,
// additive — the raw/ artefacts are NOT modified, so run immutability holds
// [CR-FCA-03/09]). No database (CCS-FCA-001 §0.2).
//
// Unknown structures (new fields, newly-populated bodies, unrecognised shapes) are
// preserved verbatim and recorded as DISCOVERY CANDIDATES; extraction continues
// without code changes and without data loss (CCS-FCA-001 §13).
//
// Authority: CCS-FCA-001 §7, §13; CCD-FCA-001 CR-FCA-01/02/03/04/06/15; IMP §5.

const fs = require('node:fs');
const path = require('node:path');
const { def } = require('./endpoint-map');
const { enumerate } = require('./extract-map');
const { buildStructured } = require('./structured-evidence');
const { rawDir } = require('./evidence-path');

function structuredDir(runDir) { return path.join(runDir, 'structured'); }

/**
 * Extract structured evidence for an entire preserved run directory.
 *
 * @param {string} runDir
 * @returns {{ tally: Object, discoveries: Object[] }}
 */
function extractRun(runDir) {
  const rDir = rawDir(runDir);
  if (!fs.existsSync(rDir)) throw new Error(`no raw evidence at ${rDir}`);
  const sDir = structuredDir(runDir);
  fs.mkdirSync(sDir, { recursive: true });

  const tally = { rawLines: 0, skipped: 0, structuredRecords: 0, byEndpoint: {} };
  const discoveries = [];
  const seenDiscovery = new Set();

  function recordDiscovery(endpointId, anchor, description, sample) {
    const sig = `${endpointId}|${description}`;
    if (seenDiscovery.has(sig)) return;
    seenDiscovery.add(sig);
    discoveries.push({
      discoveryId: `FCA-DISC-${String(discoveries.length + 1).padStart(3, '0')}`,
      endpoint: endpointId, exampleAnchor: anchor ?? null, description, sample: sample ?? null,
    });
  }

  for (const file of fs.readdirSync(rDir).filter((f) => f.endsWith('.ndjson'))) {
    const endpointId = file.replace(/\.ndjson$/, '');
    const responseType = def(endpointId) ? def(endpointId).responseType : null;
    const lines = fs.readFileSync(path.join(rDir, file), 'utf8').split('\n').filter(Boolean);

    let lineNumber = 0;
    for (const line of lines) {
      lineNumber++;
      tally.rawLines++;
      let rawLine;
      try { rawLine = JSON.parse(line); } catch { tally.skipped++; recordDiscovery(endpointId, null, 'unparseable preserved line'); continue; }

      // Only successful, content-bearing responses yield structured evidence.
      // Failed observations / absences stay in raw; their handling is Phase 7.
      if (rawLine.transport !== 'NONE' || rawLine.rawBody == null) { tally.skipped++; continue; }

      let body;
      try { body = JSON.parse(rawLine.rawBody); }
      catch { tally.skipped++; recordDiscovery(endpointId, rawLine.anchor, 'preserved rawBody not JSON-parseable'); continue; }

      const { items, unrecognised, reason } = enumerate(responseType, body, endpointId);
      if (unrecognised) recordDiscovery(endpointId, rawLine.anchor, `unrecognised shape: ${reason}`, summarise(body));

      const out = [];
      for (const it of items) out.push(buildStructured(rawLine, { artefact: file, lineNumber }, it));
      if (out.length) {
        fs.appendFileSync(path.join(sDir, file), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
        tally.structuredRecords += out.length;
        tally.byEndpoint[endpointId] = (tally.byEndpoint[endpointId] ?? 0) + out.length;
      }
    }
  }

  return { tally, discoveries };
}

/** A tiny, non-interpretive shape summary for a discovery sample (no evidence values). */
function summarise(body) {
  const data = body ? body.Data : undefined;
  if (Array.isArray(data)) return { dataType: 'array', length: data.length };
  if (data !== null && typeof data === 'object') return { dataType: 'object', keys: Object.keys(data).length };
  return { dataType: data === null ? 'null' : typeof data };
}

module.exports = { extractRun, structuredDir };
