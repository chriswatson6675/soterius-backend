'use strict';

// analysis-report.test.js — unit tests for the Generic Cohort Analysis Report
// Generator's PURE functions (parsing, per-signal analysers, findings, rendering,
// reconciliation). No Supabase / no network: analysers are exercised against
// synthetic row arrays, so the tests prove the calculations are deterministic and
// population-agnostic without touching persisted data.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseCollectionReport, SPEC_BY_ID, buildFindings, adoptionBand,
  renderReport, reportStem, pct,
} = require('./analysis-report');

// A minimal but structurally faithful Collection Report (matches run-all.js output).
const SAMPLE_REPORT = `# SRAREG001_COLLECTION_REPORT

**Cohort:** SRA-REG-001 — SRA Organisation Registry
**Selection ID:** sra-registry-39191e65b5fa
**Collection started:** 2026-06-30T12:41:06.918Z
**Collection completed:** 2026-06-30T12:45:51.620Z
**Total elapsed:** 285s

## 1. Cohort Summary

| Metric | Value |
|---|---|
| Cohort | SRA-REG-001 |
| Domains in cohort | 1000 |
| Signals executed | 9 |
| Total observations attempted | 9000 |
| Total observations stored | 8981 |

## 6. Run UUID Register

| Signal | Run UUID | Schema | Started At | Completed At | Storage |
|---|---|---|---|---|---|
| SOT-SPF-001 | \`95bdf49c-f573-4037-9ea2-c435e1a7e0d6\` | v0 | 2026-06-30T12:41:07.188Z | 2026-06-30T12:41:26.850Z | x |
| SOT-SECURITYTXT-001 | \`fbbbc865-dcff-4485-b494-4b1185a245b2\` | v1 | 2026-06-30T12:41:07.266Z | 2026-06-30T12:45:01.987Z | y |
`;

test('parseCollectionReport extracts cohort identity, sizes and signal register', () => {
  const m = parseCollectionReport(SAMPLE_REPORT);
  assert.equal(m.cohortId, 'SRA-REG-001');
  assert.equal(m.cohortName, 'SRA Organisation Registry');
  assert.equal(m.selectionId, 'sra-registry-39191e65b5fa');
  assert.equal(m.n, 1000);
  assert.equal(m.attempted, 9000);
  assert.equal(m.stored, 8981);
  assert.equal(m.signals.length, 2);
  assert.deepEqual(m.signals[0], {
    signalId: 'SOT-SPF-001', runId: '95bdf49c-f573-4037-9ea2-c435e1a7e0d6',
    schema: 'v0', startedAt: '2026-06-30T12:41:07.188Z', completedAt: '2026-06-30T12:41:26.850Z',
  });
  assert.equal(m.signals[1].schema, 'v1');
});

test('reportStem strips separators (population-agnostic)', () => {
  assert.equal(reportStem('SRA-REG-001'), 'SRAREG001');
  assert.equal(reportStem('FCA-REG-001'), 'FCAREG001');
  assert.equal(reportStem('IF-001'), 'IF001');
});

test('pct is deterministic and rounds to one decimal', () => {
  assert.equal(pct(919, 1000), 91.9);
  assert.equal(pct(0, 1000), 0);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(5, 0), 0);
});

test('SPF analyser counts present/absent and present/missing distribution', () => {
  const rows = [
    { spf_present: true, spf_collection_error: null },
    { spf_present: true, spf_collection_error: null },
    { spf_present: false, spf_collection_error: null },
    { spf_present: false, spf_collection_error: 'SERVFAIL' },
  ];
  const r = SPEC_BY_ID['SOT-SPF-001'].analyse(rows);
  assert.equal(r.observed, 4);
  assert.equal(r.present, 2);
  assert.equal(r.absent, 2);
  assert.equal(r.failures, 1);
  assert.equal(r.adoptionPct, 50);
  assert.deepEqual(r.distribution.buckets, [['Present', 2], ['Missing', 2]]);
});

test('DKIM treats NOT_DETECTED as clean absent, not a failure', () => {
  const rows = [
    { dkim_present: true, dkim_collection_status: null },
    { dkim_present: false, dkim_collection_status: 'NOT_DETECTED' },
    { dkim_present: false, dkim_collection_status: 'NOT_DETECTED' },
    { dkim_present: false, dkim_collection_status: 'TIMEOUT' },
  ];
  const r = SPEC_BY_ID['SOT-DKIM-001'].analyse(rows);
  assert.equal(r.present, 1);
  assert.equal(r.absent, 3);
  assert.equal(r.failures, 1); // only TIMEOUT counts
});

test('DMARC policy distribution buckets reject/quarantine/none/missing', () => {
  const rows = [
    { dmarc_present: true, dmarc_policy: 'reject' },
    { dmarc_present: true, dmarc_policy: 'quarantine' },
    { dmarc_present: true, dmarc_policy: 'none' },
    { dmarc_present: true, dmarc_policy: null },   // present, unspecified → none bucket
    { dmarc_present: false, dmarc_policy: null },
  ];
  const r = SPEC_BY_ID['SOT-DMARC-001'].analyse(rows);
  assert.equal(r.present, 4);
  assert.equal(r.absent, 1);
  assert.deepEqual(r.distribution.buckets, [
    ['reject', 1], ['quarantine', 1], ['none', 2], ['missing (no DMARC)', 1],
  ]);
});

test('Security Headers tiers + present require a served response and >=1 core', () => {
  const mk = (state, present) => ({
    endpoint_state: state,
    header_inventory: Object.fromEntries(
      ['strict_transport_security','content_security_policy','x_content_type_options',
       'x_frame_options','referrer_policy','permissions_policy','x_xss_protection']
        .map((h, i) => [h, { present: i < present }])),
  });
  const rows = [
    mk('RESPONSE_OBSERVED', 6),  // complete
    mk('RESPONSE_OBSERVED', 3),  // partial
    mk('RESPONSE_OBSERVED', 1),  // minimal
    mk('RESPONSE_OBSERVED', 0),  // served, 0 core → absent, not present
    mk('CONNECTION_ERROR', 5),   // not served → absent + failure (inventory ignored for serve)
  ];
  const r = SPEC_BY_ID['SOT-SECURITYHEADERS-001'].analyse(rows);
  assert.equal(r.observed, 5);
  assert.equal(r.served, 4);
  assert.equal(r.present, 3);          // complete+partial+minimal served rows
  assert.equal(r.failures, 1);         // the not-served row
  const tiers = Object.fromEntries(r.distribution.buckets.map(([k, v]) => [k, v]));
  assert.equal(tiers['complete (5–6 core)'], 1);
  assert.equal(tiers['partial (3–4 core)'], 1);
  assert.equal(tiers['minimal (1–2 core)'], 1);
  assert.equal(tiers['absent (0 core / not served)'], 2);
});

test('security.txt present = PRESENT_*; INDETERMINATE is neither present nor absent', () => {
  const rows = [
    { file_state: 'PRESENT_BOTH' },
    { file_state: 'PRESENT_CANONICAL' },
    { file_state: 'ABSENT' },
    { file_state: 'ABSENT' },
    { file_state: 'INDETERMINATE' },
  ];
  const r = SPEC_BY_ID['SOT-SECURITYTXT-001'].analyse(rows);
  assert.equal(r.present, 2);
  assert.equal(r.failures, 1);  // indeterminate
  assert.equal(r.absent, 2);
  assert.equal(r.adoptionPct, 40);
});

test('adoptionBand maps percentages to observational phrases', () => {
  assert.match(adoptionBand(0), /not observed/);
  assert.match(adoptionBand(3), /rare/);
  assert.match(adoptionBand(9), /uncommon/);
  assert.match(adoptionBand(30), /partially/);
  assert.match(adoptionBand(60), /majority/);
  assert.match(adoptionBand(91), /widely/);
});

test('buildFindings yields one line per signal plus grouped observations', () => {
  const analyses = [
    { signalId: 'SOT-SPF-001', label: 'SPF', present: 919, observed: 1000, adoptionPct: 91.9 },
    { signalId: 'SOT-DKIM-001', label: 'DKIM', present: 546, observed: 1000, adoptionPct: 54.6 },
    { signalId: 'SOT-DMARC-001', label: 'DMARC', present: 617, observed: 1000, adoptionPct: 61.7 },
    { signalId: 'SOT-MTASTS-001', label: 'MTA-STS', present: 46, observed: 1000, adoptionPct: 4.6 },
    { signalId: 'SOT-TLSRPT-001', label: 'TLS-RPT', present: 0, observed: 1000, adoptionPct: 0 },
  ];
  const f = buildFindings(analyses);
  assert.equal(f.perSignal.length, 5);
  assert.ok(f.grouped.some(g => /Email authentication/.test(g)));
  assert.ok(f.grouped.some(g => /transport-security/.test(g)));
});

test('renderReport reconciles Σ observed against stored and is deterministic', () => {
  const meta = { cohortId: 'SRA-REG-001', cohortName: 'SRA Organisation Registry',
    selectionId: 'sra-registry-39191e65b5fa', started: 'A', completed: 'B', n: 10, stored: 18 };
  const analyses = [
    { signalId: 'SOT-SPF-001', label: 'SPF', observed: 10, present: 9, absent: 1, failures: 0, adoptionPct: 90 },
    { signalId: 'SOT-SECURITYTXT-001', label: 'security.txt', observed: 8, present: 1, absent: 6, failures: 1, adoptionPct: 12.5 },
  ];
  const findings = buildFindings(analyses);
  const a = renderReport(meta, analyses, findings, 'FIXED');
  const b = renderReport(meta, analyses, findings, 'FIXED');
  assert.equal(a.markdown, b.markdown);          // deterministic
  assert.equal(a.observationsCollected, 18);
  assert.equal(a.reconcileOk, true);
  assert.equal(a.delta, 0);
  assert.match(a.markdown, /# SRAREG001_ANALYSIS_REPORT/);
  assert.match(a.markdown, /✓ MATCH/);
});

test('reconciliation: positive delta is benign (DB ≥ reported), negative is a shortfall', () => {
  const base = { cohortId: 'X-001', cohortName: 'X', selectionId: 's', started: 'A', completed: 'B', n: 10 };
  const analyses = [{ signalId: 'SOT-SPF-001', label: 'SPF', observed: 10, present: 9, absent: 1, failures: 0, adoptionPct: 90 }];
  const f = buildFindings(analyses);

  const over = renderReport({ ...base, stored: 9 }, analyses, f, 'FIXED');   // DB has 10, reported 9
  assert.equal(over.delta, 1);
  assert.equal(over.reconcileOk, true);
  assert.match(over.markdown, /MATCH \(\+1/);

  const under = renderReport({ ...base, stored: 11 }, analyses, f, 'FIXED');  // DB has 10, reported 11
  assert.equal(under.delta, -1);
  assert.equal(under.reconcileOk, false);
  assert.match(under.markdown, /SHORTFALL/);
});
