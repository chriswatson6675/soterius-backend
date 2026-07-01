'use strict';

// benchmark-report.test.js — unit tests for the Generic Cohort Benchmark Report
// Generator's PURE functions (parsing Analysis Reports, signal/distribution comparison,
// findings, reconciliation, rendering). No filesystem beyond inline fixtures, no DB,
// no network — proving the comparison is deterministic and population-agnostic.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseAnalysisReport, shortCodeOf, compareSignals, compareDistributions,
  buildBenchmarkFindings, reconcile, renderBenchmark,
} = require('./benchmark-report');

// Two minimal Analysis Reports in the exact format the Analysis generator emits.
function analysisFixture(cohortId, name, spfPct, dmarcPct, tlsPct) {
  return `# X_ANALYSIS_REPORT

**Cohort:** ${cohortId} — ${name}
**Selection ID:** sel-${cohortId}

## 1. Cohort Summary

| Metric | Value |
|---|---|
| Population | ${name} (${cohortId}) |
| Organisations scanned | 1000 |
| Observations collected | 8981 |
| Completion rate | **99.8%** |

## 2. Signal Adoption

| Signal | Observed | Present | Absent | Retrieval failures | Adoption |
|---|---|---|---|---|---|
| SPF | 1000 | ${spfPct * 10} | ${1000 - spfPct * 10} | 0 | **${spfPct}%** |
| DMARC | 1000 | ${dmarcPct * 10} | ${1000 - dmarcPct * 10} | 0 | **${dmarcPct}%** |
| TLS-RPT | 1000 | ${tlsPct * 10} | ${1000 - tlsPct * 10} | 0 | **${tlsPct}%** |

## 3. Distribution

### DMARC policy

| Category | Count | Share |
|---|---|---|
| reject | 219 | 21.9% |
| quarantine | 152 | 15.2% |
| none | 246 | 24.6% |
| missing (no DMARC) | 383 | 38.3% |

### DNSSEC

| Category | Count | Share |
|---|---|---|
| signed (DS present) | 33 | 3.3% |
| unsigned | 967 | 96.7% |

## 4. Benchmark Findings
`;
}

const FCA = analysisFixture('FCA-REG-001', 'FCA Organisation Registry', 91, 59, 0);
const SRA = analysisFixture('SRA-REG-001', 'SRA Organisation Registry', 91.9, 61.7, 0);

test('shortCodeOf takes the leading id segment', () => {
  assert.equal(shortCodeOf('FCA-REG-001'), 'FCA');
  assert.equal(shortCodeOf('SRA-REG-001'), 'SRA');
  assert.equal(shortCodeOf('IF-001'), 'IF');
});

test('parseAnalysisReport extracts meta, signals and distributions', () => {
  const r = parseAnalysisReport(FCA);
  assert.equal(r.meta.cohortId, 'FCA-REG-001');
  assert.equal(r.meta.shortCode, 'FCA');
  assert.equal(r.meta.organisations, 1000);
  assert.equal(r.meta.observations, 8981);
  assert.equal(r.meta.completionRate, 99.8);
  assert.equal(r.signals['SPF'].adoptionPct, 91);
  assert.equal(r.signals['DMARC'].adoptionPct, 59);
  assert.equal(r.signals['TLS-RPT'].adoptionPct, 0);
  assert.deepEqual(r.signalOrder, ['SPF', 'DMARC', 'TLS-RPT']);
  assert.equal(r.distributions['DMARC policy'].length, 4);
  assert.equal(r.distributions['DMARC policy'][0].category, 'reject');
  assert.equal(r.distributions['DMARC policy'][0].share, 21.9);
});

test('compareSignals computes spread, higher and lower cohort', () => {
  const cmp = compareSignals([parseAnalysisReport(FCA), parseAnalysisReport(SRA)]);
  const spf = cmp.find(s => s.label === 'SPF');
  assert.equal(spf.spread, 0.9);          // 91.9 - 91.0
  assert.equal(spf.highest, 'SRA');
  assert.equal(spf.lowest, 'FCA');
  const tls = cmp.find(s => s.label === 'TLS-RPT');
  assert.equal(tls.spread, 0);
  assert.equal(tls.tie, true);
});

test('compareDistributions aligns categories across cohorts', () => {
  const cmp = compareDistributions([parseAnalysisReport(FCA), parseAnalysisReport(SRA)]);
  const dmarc = cmp.find(d => d.title === 'DMARC policy');
  assert.ok(dmarc);
  assert.equal(dmarc.rows[0].category, 'reject');
  assert.equal(dmarc.rows[0].perCohort.length, 2);
  assert.equal(dmarc.rows[0].perCohort[0].share, 21.9);
});

test('buildBenchmarkFindings reports extremes deterministically', () => {
  const cmp = compareSignals([parseAnalysisReport(FCA), parseAnalysisReport(SRA)]);
  const f = buildBenchmarkFindings(cmp);
  assert.ok(f.some(l => /Highest observed adoption.*SPF/.test(l)));
  assert.ok(f.some(l => /Lowest observed adoption.*TLS-RPT 0%/.test(l)));
  assert.ok(f.some(l => /Largest difference.*DMARC/.test(l)));      // DMARC spread 2.7 > SPF 0.9
  assert.ok(f.some(l => /identically across all cohorts.*TLS-RPT/.test(l)));
});

test('reconcile flags adoption that disagrees with present/observed', () => {
  const good = reconcile([parseAnalysisReport(FCA)]);
  assert.equal(good.consistent, true);

  const broken = parseAnalysisReport(FCA);
  broken.signals['SPF'].present = 100;     // 100/1000 = 10% but stated 91%
  const bad = reconcile([broken]);
  assert.equal(bad.consistent, false);
  assert.equal(bad.mismatches[0].label, 'SPF');
});

test('renderBenchmark is deterministic and names the output A_vs_B', () => {
  const reports = [parseAnalysisReport(FCA, 'FCAREG001_ANALYSIS_REPORT.md'), parseAnalysisReport(SRA, 'SRAREG001_ANALYSIS_REPORT.md')];
  const a = renderBenchmark(reports, 'FIXED');
  const b = renderBenchmark(reports, 'FIXED');
  assert.equal(a.markdown, b.markdown);
  assert.equal(a.title, 'FCA_vs_SRA_BENCHMARK_REPORT');
  assert.equal(a.reconcileOk, true);
  assert.match(a.markdown, /## 2\. Signal Comparison/);
  assert.match(a.markdown, /Δ \(max−min\)/);
  assert.match(a.markdown, /no rescanning/);
});

test('benchmark supports three or more cohorts (N-way)', () => {
  const HE = analysisFixture('HE-001', 'Higher Education', 80, 40, 5);
  const cmp = compareSignals([parseAnalysisReport(FCA), parseAnalysisReport(SRA), parseAnalysisReport(HE)]);
  const spf = cmp.find(s => s.label === 'SPF');
  assert.equal(spf.max, 91.9);
  assert.equal(spf.min, 80);
  assert.equal(spf.spread, 11.9);
  assert.equal(spf.highest, 'SRA');
  assert.equal(spf.lowest, 'HE');
});
