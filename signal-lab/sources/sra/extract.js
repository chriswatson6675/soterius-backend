'use strict';

// extract.js — structured evidence extraction from preserved raw snapshot segments.
//
// SRA Snapshot Collector v0.1 — Extract layer.
//
// Reads the IMMUTABLE raw snapshot preserved in a collection package, enumerates
// organisational evidence (sra-extract-map.js), and writes traceable structured
// evidence records to `structured/firm.ndjson` (append-only). Extraction operates
// ONLY on preserved raw artefacts; it NEVER re-fetches, modifies raw evidence,
// infers missing values, derives observations, or scores organisations.
//
// Determinism + repeatability: segments are processed in raw-index order, firms in
// array order, fields in key order — the same raw always yields the same structured
// output. The structured view is regenerable from the immutable raw; this stage is
// strictly append-only and refuses to append onto a package that already has
// structured evidence (use a fresh package to re-extract).
//
// Unparseable segments are left untouched in raw/ and recorded as discovery
// candidates; no data is lost. This module does NOT generate provenance, verify
// integrity, or write reports.

const fs = require('node:fs');
const path = require('node:path');

const { rawDir, rawIndexPath, structuredDir } = require('./evidence-path');
const { SRA_SNAPSHOT_SOURCE } = require('./snapshot-source');
const { enumerate } = require('./sra-extract-map');
const { buildStructured } = require('./structured-evidence');

const STRUCTURED_FILE = 'firm.ndjson';

/** Read the append-only raw index, or null if absent. */
function readRawIndex(runDir) {
  const p = rawIndexPath(runDir);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Authoritative list of preserved segments (raw-index first; raw/*.json as a fallback). */
function listSegments(runDir) {
  const idx = readRawIndex(runDir);
  if (idx) return idx.map((r) => ({ file: r.file, runId: r.runId ?? null, segment: r.segment ?? null, productionTimestamp: r.productionTimestamp ?? null }));
  const rdir = rawDir(runDir);
  if (!fs.existsSync(rdir)) return [];
  return fs.readdirSync(rdir).filter((f) => f.endsWith('.json'))
    .map((f, i) => ({ file: f, runId: null, segment: i, productionTimestamp: null }));
}

/**
 * Extract structured evidence for a preserved collection package.
 *
 * @param {string} runDir - the collection package directory
 * @param {Object} [opts] - { source }
 * @returns {{ tally: Object, discoveries: Object[], records: Object[], structuredFile: string }}
 */
function extractRun(runDir, opts = {}) {
  const source = opts.source || SRA_SNAPSHOT_SOURCE;
  const rdir = rawDir(runDir);
  if (!fs.existsSync(rdir)) throw new Error(`no raw evidence at ${rdir}`);

  const sdir = structuredDir(runDir);
  fs.mkdirSync(sdir, { recursive: true });
  const outFile = path.join(sdir, STRUCTURED_FILE);
  if (fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').trim().length > 0) {
    throw new Error('structured evidence already present; extraction is append-only (use a fresh package to re-extract)');
  }

  const tally = { segments: 0, segmentsParsed: 0, segmentsUnparseable: 0, records: 0, byObjectType: {} };
  const discoveries = [];
  const records = [];

  for (const seg of listSegments(runDir)) {
    tally.segments++;
    const file = path.join(rdir, seg.file);

    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { tally.segmentsUnparseable++; discoveries.push({ type: 'segment-unreadable', file: seg.file }); continue; }

    let body;
    try { body = JSON.parse(raw); }
    catch { tally.segmentsUnparseable++; discoveries.push({ type: 'segment-unparseable', file: seg.file }); continue; }
    tally.segmentsParsed++;

    const ctx = { runId: seg.runId, sourceId: source.sourceId, productionTimestamp: seg.productionTimestamp };
    const { items, discoveries: d } = enumerate(body, source);
    for (const dd of d) discoveries.push({ ...dd, file: seg.file });

    // Write in batches so a single segment's output is never materialised as one
    // string (a >512 MB join exceeds V8's max string length at production scale).
    const WRITE_BATCH = 5000;
    let buf = [];
    for (const it of items) {
      const rec = buildStructured(ctx, { artefact: seg.file, segment: seg.segment }, it);
      records.push(rec);
      buf.push(JSON.stringify(rec));
      tally.records++;
      tally.byObjectType[it.objectType] = (tally.byObjectType[it.objectType] || 0) + 1;
      if (buf.length >= WRITE_BATCH) { fs.appendFileSync(outFile, buf.join('\n') + '\n'); buf = []; } // append-only; never rewrite
    }
    if (buf.length) fs.appendFileSync(outFile, buf.join('\n') + '\n');
  }

  return { tally, discoveries, records, structuredFile: outFile };
}

module.exports = { extractRun, listSegments, STRUCTURED_FILE };
