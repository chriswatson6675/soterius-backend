'use strict';

// health.js — GENERIC collector health summary (engineering operations only).
//
// Reference Collector v0.1 — PHASE 8 (IMP-FCA-001 §8; CCS-FCA-001 §14).
//
// Summarises the COLLECTOR's operational health: retry/resume activity, failure
// counts, source anomalies, newly-observed structures, manifest consistency, and
// integrity-verification status. It says nothing about organisational trust. Pure
// function over the run model; reusable by any source.
//
// Authority: CCS-FCA-001 §14; CCD-FCA-001 CR-FCA-01; IMP-FCA-001 §8.

function buildHealth(model, profile, extras = {}) {
  const allLines = Object.values(model.rawByEndpoint).flat();
  const totalPages = allLines.length;
  const retriedPages = allLines.filter((l) => l.attemptCount > 1).length;
  const transientFailures = allLines.reduce((n, l) => n + l.attemptOutcomes.filter((o) => o === 'transient').length, 0);
  const permanentFailures = allLines.filter((l) => l.outcome === 'failure').length;

  // Source-specific anomalies (e.g. unexpected status codes) via the profile.
  const apiAnomalies = [];
  for (const l of allLines) for (const a of profile.anomalies(l)) apiAnomalies.push({ endpoint: l.endpointId, ...a });

  // Manifest consistency: the meaningful invariant is that every preserved page is
  // accounted for (declared pagesPreserved === lines on disk). NOTE: endpoint counts
  // are reported for transparency but NOT used to gate consistency — the Phase 4
  // preserve tally counts endpointsPreserved per EXECUTION (a grandchild observed
  // per-dependency counts many), whereas a recompute counts distinct endpoint files;
  // the two are legitimately different definitions, so only pages gate the flag.
  const m = model.manifest || {};
  const recomputed = {
    endpointFiles: Object.keys(model.rawByEndpoint).filter((id) => model.rawByEndpoint[id].some((l) => l.outcome !== 'failure')).length,
    pagesPreserved: totalPages,
  };
  const consistent = (m.pagesPreserved == null || m.pagesPreserved === recomputed.pagesPreserved);

  const resumeHistory = Array.isArray(m.resumeHistory) ? m.resumeHistory : [];

  return {
    reportType: 'health-report',
    note: 'Engineering operations only. Says nothing about organisational trust.',
    sourceId: profile.sourceId,
    runId: m.runId ?? null,
    retry: { totalPages, retriedPages, retryRate: totalPages ? +(retriedPages / totalPages).toFixed(4) : 0, transientFailures },
    permanentFailures,
    resumeEvents: resumeHistory.length,
    apiAnomalies,
    newlyObservedStructures: (extras.discoveries || []).length,
    manifestConsistency: { consistent, declared: { endpointsPreserved: m.endpointsPreserved ?? null, pagesPreserved: m.pagesPreserved ?? null }, recomputed },
    integrity: extras.integrity ? { verified: extras.integrity.verified, total: extras.integrity.total, ok: extras.integrity.verified === extras.integrity.total } : null,
  };
}

module.exports = { buildHealth };
