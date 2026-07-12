'use strict';

// benchmarkAggregation.js — ENG-012 §1.3 / §2 item 1 (T3.3, ENG-013 WP3).
//
// The single, canonical aggregation over legacy scans/prospects benchmark
// data. Before this change, backend/api/routes/benchmarks.js and
// backend/api/routes/prospects.js's own GET /benchmarks each independently
// re-implemented this same aggregation over the same source rows — an
// accidental duplicate (ENG-011 §4), not a deliberate legacy/canonical
// split. Both routes now call this one function; neither re-derives.
//
// NOT the canonical, Trust-Profile-based benchmark direction
// (backend/observatory/baseline/benchmarks.js) — that remains a distinct,
// forward-looking implementation over canonical signal_quality_* data,
// wired only to an offline script today. This module only de-duplicates the
// two LEGACY implementations that already coexisted; it does not migrate
// either route onto the canonical path (ENG-012 §2 item 4 — separately
// gated, net-new work, not part of this de-duplication).

function aggregateGroup(group) {
  return Object.entries(group)
    .map(([label, { scores }]) => ({
      label,
      count: scores.length,
      avgScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0,
      minScore: scores.length ? Math.min(...scores) : 0,
      maxScore: scores.length ? Math.max(...scores) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * @param {Array<Object>} scans - rows as returned by getBenchmarkData()
 *   (scans joined to prospects)
 * @returns {{
 *   totalScans: number,
 *   bySector: Array, byLocation: Array, bandDistribution: Object,
 *   topFailedChecks: Array, signalAdoption: Array,
 * }}
 */
function computeBenchmarkAggregates(scans) {
  const bySector = {};
  const byLocation = {};
  const bandCounts = {};
  const failedChecks = {};
  const signalCounts = {}; // { checkName -> { pass, total } }

  for (const scan of scans) {
    const prospect = scan.prospects;
    if (!prospect) continue;

    const score = Number(scan.overall_score);
    const band = scan.risk_band || 'Unknown';
    const sector = prospect.sector || 'Unknown';
    const loc = prospect.location || 'Unknown';

    if (!bySector[sector]) bySector[sector] = { scores: [] };
    if (!byLocation[loc]) byLocation[loc] = { scores: [] };
    bySector[sector].scores.push(score);
    byLocation[loc].scores.push(score);

    bandCounts[band] = (bandCounts[band] || 0) + 1;

    for (const scanner of (scan.scanner_results || [])) {
      for (const check of (scanner.checks || [])) {
        if (!signalCounts[check.name]) signalCounts[check.name] = { pass: 0, total: 0 };
        signalCounts[check.name].total += 1;
        if (check.status === 'PASS') signalCounts[check.name].pass += 1;
        if (check.status === 'FAIL') {
          failedChecks[check.name] = (failedChecks[check.name] || 0) + 1;
        }
      }
    }
  }

  const topFailedChecks = Object.entries(failedChecks)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const signalAdoption = Object.entries(signalCounts)
    .map(([name, { pass, total }]) => ({
      name,
      passPercent: total > 0 ? Math.round((pass / total) * 100) : 0,
    }))
    .sort((a, b) => b.passPercent - a.passPercent);

  return {
    totalScans: scans.length,
    bySector: aggregateGroup(bySector),
    byLocation: aggregateGroup(byLocation),
    bandDistribution: bandCounts,
    topFailedChecks,
    signalAdoption,
  };
}

module.exports = { computeBenchmarkAggregates, aggregateGroup };
