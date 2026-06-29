'use strict';

// report.js — GENERIC operational collection reporting (source-agnostic core).
//
// Reference Collector v0.1 — PHASE 8 (IMP-FCA-001 §8; CCS-FCA-001 §14, §15).
//
// Reports describe the COLLECTION PROCESS, never the evidence. They are computed
// from the platform-standard run artefacts (manifest + raw/*.ndjson +
// structured/*.ndjson + provenance/lineage.ndjson) — the SAME shapes every source
// collector emits — so this core is reusable by future sources (Companies House,
// ICO, NCSC, Charity Commission, …). Source-specific behaviour is injected via a
// `profile` (see fca-report-profile.js); the GENERIC_PROFILE below needs no source
// knowledge. Reporting is additive: it writes only under `<runDir>/reports/` and
// never modifies evidence [CR-FCA-01/03].
//
// Authority: CCS-FCA-001 §14, §15; CCD-FCA-001 CR-FCA-01/03; IMP-FCA-001 §8.

const fs = require('node:fs');
const path = require('node:path');

const { rawDir, manifestPath } = require('./evidence-path');
const { buildCoverage } = require('./coverage');
const { buildHealth } = require('./health');

function reportsDir(runDir) { return path.join(runDir, 'reports'); }
function structuredDir(runDir) { return path.join(runDir, 'structured'); }
function lineagePath(runDir) { return path.join(runDir, 'provenance', 'lineage.ndjson'); }

// A source-agnostic profile: classifies a preserved line purely from the platform
// collection schema (transport + Data presence) and finds no source anomalies.
const GENERIC_PROFILE = {
  sourceId: 'generic',
  classify(summary) { return summary.outcome; },     // 'data' | 'absence' | 'failure'
  anomalies() { return []; },                         // override per source
};

// ── load a source-agnostic run model (single I/O + parse pass) ────────────────────

function _summariseLine(ln) {
  const transport = ln.transport ?? null;
  let outcome = 'failure';
  let next = null;
  if (transport === 'NONE') {
    let data;
    try { data = ln.rawBody != null ? JSON.parse(ln.rawBody).Data : undefined; } catch { data = undefined; }
    outcome = (data === null || data === undefined) ? 'absence' : 'data';
    try { const ri = JSON.parse(ln.rawBody).ResultInfo; next = ri ? (ri.Next ?? null) : null; } catch { next = null; }
  }
  const attempts = Array.isArray(ln.attempts) ? ln.attempts : null;
  return {
    endpointId: ln.endpointId, dependencyId: ln.dependencyId ?? null,
    transport, fcaStatus: ln.fcaEnvelope ? (ln.fcaEnvelope.status ?? null) : null,
    outcome, next, anchor: ln.anchor ?? null,
    attemptCount: attempts ? attempts.length : 1,
    attemptOutcomes: attempts ? attempts.map((a) => a.outcome) : ['success'],
  };
}

function loadRunModel(runDir) {
  const manifest = fs.existsSync(manifestPath(runDir)) ? JSON.parse(fs.readFileSync(manifestPath(runDir), 'utf8')) : null;

  const rawByEndpoint = {};
  const rDir = rawDir(runDir);
  if (fs.existsSync(rDir)) {
    for (const file of fs.readdirSync(rDir).filter((f) => f.endsWith('.ndjson'))) {
      const id = file.replace(/\.ndjson$/, '');
      rawByEndpoint[id] = fs.readFileSync(path.join(rDir, file), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return _summariseLine(JSON.parse(l)); } catch { return null; } }).filter(Boolean);
    }
  }

  const structuredByEndpoint = {};
  const structuredUnrecognised = [];
  let structuredCount = 0;
  const sDir = structuredDir(runDir);
  if (fs.existsSync(sDir)) {
    for (const file of fs.readdirSync(sDir).filter((f) => f.endsWith('.ndjson'))) {
      const id = file.replace(/\.ndjson$/, '');
      const lines = fs.readFileSync(path.join(sDir, file), 'utf8').split('\n').filter(Boolean);
      structuredByEndpoint[id] = lines.length;
      structuredCount += lines.length;
      for (const l of lines) { try { const r = JSON.parse(l); if (r.unrecognised) structuredUnrecognised.push({ endpointId: r.endpointId, anchor: r.anchor, jsonPath: r.jsonPath }); } catch { /* ignore */ } }
    }
  }

  let provenanceCount = 0;
  if (fs.existsSync(lineagePath(runDir))) provenanceCount = fs.readFileSync(lineagePath(runDir), 'utf8').split('\n').filter(Boolean).length;

  return { manifest, rawByEndpoint, structuredByEndpoint, structuredCount, structuredUnrecognised, provenanceCount };
}

// ── generic collection (process) report ──────────────────────────────────────────

function buildCollectionReport(model, profile = GENERIC_PROFILE) {
  const m = model.manifest || {};
  const allLines = Object.values(model.rawByEndpoint).flat();
  const byTransport = {};
  let attemptsTotal = 0; let retriedPages = 0; let transientRetries = 0; let totalPages = 0; let multiPage = 0; let maxPages = 0;
  for (const id of Object.keys(model.rawByEndpoint)) {
    const lines = model.rawByEndpoint[id];
    totalPages += lines.length;
    if (lines.length > 1) multiPage++;
    if (lines.length > maxPages) maxPages = lines.length;
  }
  for (const l of allLines) {
    byTransport[l.transport] = (byTransport[l.transport] ?? 0) + 1;
    attemptsTotal += l.attemptCount;
    if (l.attemptCount > 1) retriedPages++;
    transientRetries += l.attemptOutcomes.filter((o) => o === 'transient').length;
  }
  const resumeHistory = Array.isArray(m.resumeHistory) ? m.resumeHistory : [];
  const resumed = resumeHistory.reduce((n, r) => n + (r.continued ?? 0) + (r.observed ?? 0), 0);
  const skipped = resumeHistory.reduce((n, r) => n + (r.skipped ?? 0), 0);

  return {
    reportType: 'collection-report',
    note: 'Describes the collection PROCESS. Does NOT summarise organisational evidence.',
    sourceId: profile.sourceId,
    runId: m.runId ?? null,
    collectorVersion: m.collectorVersion ?? null,
    apiVersion: m.apiVersion ?? null,
    anchor: m.anchor ?? null,
    scope: m.scope ?? null,
    timing: { start: m.executionStart ?? null, finish: m.executionEnd ?? null },
    endpoints: {
      expected: Array.isArray(m.scope) ? m.scope.length : null,
      observed: Object.keys(model.rawByEndpoint).length,
      resumed, skipped, resumeEvents: resumeHistory.length,
    },
    pagination: { totalPages, multiPageEndpoints: multiPage, maxPagesOnAnEndpoint: maxPages },
    retry: { attemptsTotal, retriedPages, transientRetries },
    failures: { transportErrors: allLines.filter((l) => l.transport !== 'NONE').length },
    transportClassifications: byTransport,
    artefacts: { rawFiles: Object.keys(model.rawByEndpoint).length, rawLines: totalPages },
    structuredRecords: model.structuredCount,
    provenanceRecords: model.provenanceCount,
  };
}

// ── discoveries (auto: unrecognised structures + source-profile anomalies) ────────

function scanDiscoveries(model, profile = GENERIC_PROFILE) {
  const out = [];
  const seen = new Set();
  const src = (profile.sourceId || 'generic').toUpperCase();
  let i = 0;
  for (const u of model.structuredUnrecognised) {
    if (seen.has(u.endpointId)) continue;
    seen.add(u.endpointId);
    out.push({
      discoveryId: `${src}-DISC-${String(++i).padStart(3, '0')}`,
      endpoint: u.endpointId, exampleAnchor: u.anchor ?? null,
      description: `unrecognised structure at ${u.jsonPath} (extraction used the lossless fallback)`,
      impact: 'evidence preserved verbatim; structured extraction emitted a fallback record — no data loss',
      suggestedGovernanceReview: `review the EOI inventory entry for ${u.endpointId}`,
    });
  }
  // Source profiles may contribute further anomalies as discoveries.
  for (const l of Object.values(model.rawByEndpoint).flat()) {
    for (const a of profile.anomalies(l)) {
      const key = `${l.endpointId}|${a.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        discoveryId: `${src}-DISC-${String(++i).padStart(3, '0')}`,
        endpoint: l.endpointId, exampleAnchor: l.anchor ?? null,
        description: a.detail, impact: a.impact ?? 'operational anomaly noted',
        suggestedGovernanceReview: a.review ?? 'engineering review',
      });
    }
  }
  return out;
}

// ── orchestrator: build + write all reports (additive) ────────────────────────────

function writeReports(runDir, opts = {}) {
  const profile = opts.profile || GENERIC_PROFILE;
  const model = loadRunModel(runDir);
  const family = (model.manifest && model.manifest.family) || 'firm';
  const scope = (model.manifest && model.manifest.scope) || Object.keys(model.rawByEndpoint);

  const collection = buildCollectionReport(model, profile);
  const coverage = buildCoverage(model, profile, { family, scope, notApplicable: opts.notApplicable || [] });
  const discoveries = scanDiscoveries(model, profile);
  const health = buildHealth(model, profile, { integrity: opts.integrity ?? null, discoveries });

  fs.mkdirSync(reportsDir(runDir), { recursive: true });
  fs.writeFileSync(path.join(reportsDir(runDir), 'collection-report.json'), JSON.stringify(collection, null, 2));
  fs.writeFileSync(path.join(reportsDir(runDir), 'coverage-report.json'), JSON.stringify(coverage, null, 2));
  fs.writeFileSync(path.join(reportsDir(runDir), 'health-report.json'), JSON.stringify(health, null, 2));
  if (discoveries.length) fs.writeFileSync(path.join(reportsDir(runDir), 'discoveries.json'), JSON.stringify(discoveries, null, 2));

  return { collection, coverage, health, discoveries };
}

module.exports = { loadRunModel, buildCollectionReport, scanDiscoveries, writeReports, reportsDir, GENERIC_PROFILE };
