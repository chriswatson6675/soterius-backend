'use strict';

// coverage.js — GENERIC collection-completeness reporting (source-agnostic).
//
// Reference Collector v0.1 — PHASE 8 (IMP-FCA-001 §8; CCS-FCA-001 §14).
//
// Describes OBSERVATION completeness only — what was observed vs the declared
// scope. It NEVER estimates missing EVIDENCE; "not-observed" means "we did not
// observe this endpoint", not "the firm lacks this". Pure function over the run
// model (report.loadRunModel); reusable by any source [CR-FCA-12].
//
// Authority: CCS-FCA-001 §14; CCD-FCA-001 CR-FCA-11/12; IMP-FCA-001 §8.

/**
 * @param {Object} model - from report.loadRunModel
 * @param {Object} profile
 * @param {Object} extras - { family, scope, notApplicable }
 */
function buildCoverage(model, profile, extras = {}) {
  const scope = extras.scope || Object.keys(model.rawByEndpoint);
  const notApplicable = new Set(extras.notApplicable || []);

  const perEndpoint = [];
  const totals = { expected: scope.length, observed: 0, withData: 0, empty: 0, failed: 0, notObserved: 0, notApplicable: 0, partial: 0 };

  for (const id of scope) {
    const lines = model.rawByEndpoint[id] || [];
    if (lines.length === 0) {
      if (notApplicable.has(id)) { perEndpoint.push({ endpointId: id, observed: false, state: 'not-applicable' }); totals.notApplicable++; }
      else { perEndpoint.push({ endpointId: id, observed: false, state: 'not-observed' }); totals.notObserved++; }
      continue;
    }
    totals.observed++;

    const anyData = lines.some((l) => l.outcome === 'data');
    const anySuccess = lines.some((l) => l.outcome !== 'failure');
    const state = anyData ? 'data' : anySuccess ? 'empty' : 'failed';
    if (state === 'data') totals.withData++; else if (state === 'empty') totals.empty++; else totals.failed++;

    // pagination completeness: within each dependency group the last successful page has no Next.
    const groups = {};
    for (const l of lines) (groups[l.dependencyId ?? '-'] = groups[l.dependencyId ?? '-'] || []).push(l);
    let paginationComplete = true;
    for (const g of Object.values(groups)) {
      const successes = g.filter((l) => l.outcome !== 'failure');
      if (successes.length === 0) { paginationComplete = false; continue; }
      if (successes[successes.length - 1].next) paginationComplete = false;
    }
    if (!paginationComplete) totals.partial++;

    const depKeys = Object.keys(groups).filter((k) => k !== '-');
    perEndpoint.push({
      endpointId: id, observed: true, state, pages: lines.length, paginationComplete,
      ...(depKeys.length ? { dependencies: { observed: depKeys.length } } : {}),
    });
  }

  const coverageComplete = perEndpoint.every((e) => e.state === 'data' || e.state === 'empty' || e.state === 'not-applicable')
    && perEndpoint.every((e) => e.paginationComplete !== false);

  return {
    reportType: 'coverage-report',
    note: 'Describes OBSERVATION completeness only. Does NOT estimate missing evidence.',
    sourceId: profile.sourceId,
    runId: model.manifest ? model.manifest.runId : null,
    anchor: model.manifest ? model.manifest.anchor : null,
    expectedEndpoints: scope,
    totals,
    coverageComplete,
    perEndpoint,
  };
}

module.exports = { buildCoverage };
