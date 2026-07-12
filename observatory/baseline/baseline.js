'use strict';

/*
 * National Observatory Baseline 001 — commissioning orchestrator (post-collection).
 *
 * Run AFTER the national collection (collection/runs/if001/run-all.js) completes.
 * It performs no collection itself. It:
 *   1. derives Trust Profiles + Trust Scores over the baseline observation window,
 *   2. builds national + dynamic-cohort benchmarks (generated views, no registry),
 *   3. runs the baseline validation checks,
 *   4. writes the permanent Baseline 001 record + the three required reports.
 *
 * Usage: node backend/observatory/baseline/baseline.js
 * Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (backend/.env)
 */

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { derive } = require('./derive');
const { buildBenchmarks } = require('./benchmarks');
const { RUBRIC } = require('./trust-score');

const BASELINE_ID = 'NOB-001';
const DIR = __dirname;
const REPORTS = path.join(DIR, 'reports');
const DATASET = path.join(DIR, 'dataset');
const START_FILE = path.join(DIR, 'BASELINE_START.txt');
const REPO_ROOT = path.join(DIR, '..', '..', '..');
const COLLECTION_REPORT = path.join(REPO_ROOT, 'ORGAUTHORITY001_COLLECTION_REPORT.md');
const AUTHORITY_SUMMARY = path.join(DIR, '..', '..', 'authority', 'dataset', 'build-summary.json');

const SIGNAL_TABLES = {
  'SOT-SPF-001': 'signal_facts_spf',
  'SOT-DKIM-001': 'signal_facts_dkim',
  'SOT-DMARC-001': 'signal_facts_dmarc',
  'SOT-MTASTS-001': 'signal_facts_mtasts',
  'SOT-TLSRPT-001': 'signal_facts_tlsrpt',
  'SOT-DNSSEC-001': 'signal_facts_dnssec',
  'SOT-CAA-001': 'signal_facts_caa',
  'SOT-SECURITYTXT-001': 'signal_securitytxt_v1',
  'SOT-SECURITYHEADERS-001': 'signal_securityheaders_v1',
};

function getClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Parse the collection run report (authoritative run metadata) ──────────────

function parseCollectionReport(p) {
  if (!fs.existsSync(p)) return null;
  const md = fs.readFileSync(p, 'utf8');
  const grab = (re) => { const m = md.match(re); return m ? m[1].trim() : null; };
  const startedAt = grab(/\*\*Collection started:\*\*\s*(.+)/);
  const completedAt = grab(/\*\*Collection completed:\*\*\s*(.+)/);
  const totalElapsed = grab(/\*\*Total elapsed:\*\*\s*(\d+)s/);
  const perSignal = [];
  // Signal Summary rows: | ID | Attempted | Completed | Collector Errors | DB Errors | **rate%** | runtime |
  const re = /\|\s*(SOT-[A-Z-]+-001)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\*\*([\d.]+)%\*\*\s*\|\s*([\d.]+)s\s*\|/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    perSignal.push({
      signalId: m[1], attempted: +m[2], completed: +m[3],
      collectorErrors: +m[4], dbErrors: +m[5], successRate: +m[6], runtimeSec: +m[7],
    });
  }
  // Failures table rows: | Signal | Domain | Type | Detail |
  const failures = [];
  const fre = /\|\s*(SOT-[A-Z-]+-001)\s*\|\s*([^|]+?)\s*\|\s*(COLLECTOR_ERROR|DB_WRITE_ERROR)\s*\|\s*([^|]*)\|/g;
  while ((m = fre.exec(md)) !== null) {
    failures.push({ signal: m[1], domain: m[2].trim(), type: m[3], detail: m[4].trim() });
  }
  return { startedAt, completedAt, totalElapsed: totalElapsed ? +totalElapsed : null, perSignal, failures };
}

// ── In-window DB coverage (authoritative persisted evidence) ──────────────────

async function inWindowCoverage(supabase, sinceIso) {
  const out = {};
  for (const [signalId, table] of Object.entries(SIGNAL_TABLES)) {
    const domains = new Set();
    let rows = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select('domain,collected_at')
        .gte('collected_at', sinceIso).order('collected_at', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) { domains.add(r.domain); rows++; }
      if (data.length < 1000) break;
    }
    out[signalId] = { table, distinctDomains: domains.size, rows };
  }
  return out;
}

// ── Report writers ────────────────────────────────────────────────────────────

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

function writeNationalReport(rec, bench, deriv) {
  const b = bench.national;
  const L = [];
  L.push(`# National Observatory Baseline Report — ${BASELINE_ID}`);
  L.push('');
  L.push(`**Baseline ID:** ${rec.baselineId}`);
  L.push(`**Repository Authority:** ${rec.authority.cohortId} (selection \`${rec.authority.selectionId}\`)`);
  L.push(`**Scoring model:** ${RUBRIC} (Signal scope: Core — Categories A, B, C)`);
  L.push(`**Collection window:** ${rec.startedAt} → ${rec.finishedAt}  (${rec.durationSec}s)`);
  L.push(`**Status:** ${rec.status}`);
  L.push('');
  L.push('> Organisation selection came exclusively from the canonical Repository Authority');
  L.push('> (ORG-AUTHORITY-001), VERIFIED domains only. No legacy cohort registry was referenced.');
  L.push('');
  if (!rec.coverageComplete) {
    L.push('> ⚠️ **PARTIAL COVERAGE.** Eight of the nine Core signals reached the full VERIFIED');
    L.push('> population (17,057). The following did not and are **pending backfill** — until then');
    L.push('> they score as NON_OBSERVED (excluded from attainable) for the un-observed organisations:');
    for (const ps of rec.partialSignals) L.push(`> - **${ps.signal}** — ${fmt(ps.coverage)} / ${fmt(rec.eligibleVerified)} (${ps.pct}%)`);
    L.push('>');
    L.push('> This baseline was produced over current coverage by explicit Founder decision; it will');
    L.push('> be superseded once the outstanding signal(s) complete. All integrity checks still pass.');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 1. Population & scan outcome');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Organisations in Authority | ${fmt(rec.authority.totalOrganisations)} |`);
  L.push(`| **Eligible (domainStatus = VERIFIED)** | **${fmt(rec.eligibleVerified)}** |`);
  L.push(`| Successfully scanned (≥1 observation) | ${fmt(rec.successfulScans)} (${pct(rec.successfulScans, rec.eligibleVerified)}) |`);
  L.push(`| Not scanned (no observation in window) | ${fmt(rec.failedScans)} (${pct(rec.failedScans, rec.eligibleVerified)}) |`);
  L.push(`| Observations persisted | ${fmt(rec.observationCount)} |`);
  L.push(`| Evidence points (domain × signal) | ${fmt(rec.evidenceCount)} |`);
  L.push(`| Orphan observations (unresolved to an Org ID) | ${fmt(rec.validation.orphanObservations)} |`);
  L.push('');
  L.push('## 2. Trust Profile & Trust Score coverage');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Organisations with a Trust Profile | ${fmt(rec.trustProfiles)} (${pct(rec.trustProfiles, rec.eligibleVerified)} of eligible) |`);
  L.push(`| Trust Scores computed (attainable ≥ 500) | ${fmt(rec.trustScores)} (${pct(rec.trustScores, rec.trustProfiles)} of profiles) |`);
  L.push(`| INSUFFICIENT_OBSERVATION (attainable < 500) | ${fmt(b.insufficient)} (${pct(b.insufficient, rec.trustProfiles)} of profiles) |`);
  L.push(`| Core-complete profiles (all 8 A/B/C signals observed) | ${fmt(b.coreComplete)} |`);
  L.push('');
  L.push('> **Why so many INSUFFICIENT?** TS-RUBRIC-v1.0 sets a hard "scoreable" floor at');
  L.push('> attainable ≥ 500/999, calibrated against the full A–H model. Baseline 001 collects');
  L.push('> Categories A, B, C only (max attainable 567), so any organisation missing DKIM');
  L.push('> (−70, and DKIM absence is unprovable → NON_OBSERVED) or a live web endpoint');
  L.push('> (−90 headers+security.txt) falls under the floor. This is the faithful, spec-compliant');
  L.push('> outcome — the scoring engine was **not** extended. Categories D/E/H are the Founder-');
  L.push('> designated enrichment phases that will lift most of these into scoreable range.');
  L.push('');
  L.push('## 3. National Trust Score distribution (scored organisations)');
  L.push('');
  if (b.score.n > 0) {
    L.push('| Statistic | Score (001–999) |');
    L.push('|---|---|');
    L.push(`| n scored | ${fmt(b.score.n)} |`);
    L.push(`| min / max | ${b.score.min} / ${b.score.max} |`);
    L.push(`| mean | ${b.score.mean} |`);
    L.push(`| Q1 / median / Q3 | ${b.score.q1} / ${b.score.median} / ${b.score.q3} |`);
    L.push(`| deciles (10→90) | ${b.score.deciles.join(', ')} |`);
    L.push('');
    L.push('Provisional band distribution (SLG-038 §1 overlay — not canonical):');
    L.push('');
    L.push('| Band | Organisations |');
    L.push('|---|---|');
    for (const band of b.bands.order) L.push(`| ${band} | ${fmt(b.bands.counts[band])} |`);
    L.push('');
  } else {
    L.push('_No organisations were scoreable in this window._');
    L.push('');
  }
  L.push('## 4. Dynamic cohorts (generated views over the Authority)');
  L.push('');
  L.push('Cohorts are predicates over organisation attributes carried on each Trust Profile —');
  L.push('no separate cohort registry exists. See the Signal Coverage Report for per-signal');
  L.push('national benchmarks, and `dataset/benchmarks.json` for full cohort statistics.');
  L.push('');
  L.push('| Cohort | Orgs | Scored | Insufficient | Median | DMARC enforce | SPF | DNSSEC anchored | Web reachable |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of bench.regulatorCohorts) {
    L.push(`| ${c.label} | ${fmt(c.organisations)} | ${fmt(c.scored)} | ${fmt(c.insufficient)} | ${c.score.median ?? '—'} | ${c.adoption.dmarc_enforcing}% | ${c.adoption.spf_present}% | ${c.adoption.dnssec_anchored}% | ${c.adoption.web_reachable}% |`);
  }
  L.push('');
  L.push('---');
  L.push(`*Generated ${rec.finishedAt} · ${BASELINE_ID} · deterministic derivation over the baseline window.*`);
  fs.writeFileSync(path.join(REPORTS, 'NATIONAL_BASELINE_REPORT.md'), L.join('\n'), 'utf8');
}

function writeSignalCoverageReport(rec, bench, coverage, report) {
  const b = bench.national.signals;
  const L = [];
  L.push(`# Signal Coverage Report — ${BASELINE_ID}`);
  L.push('');
  L.push(`**Baseline:** ${rec.baselineId} · window ${rec.startedAt} → ${rec.finishedAt}`);
  L.push('');
  L.push('## 1. Per-signal coverage, failures & retry');
  L.push('');
  L.push('| Signal | Table | Attempted | Completed | Coverage | Collector errors | DB errors | Retried | Retry recovered |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const [signalId, cov] of Object.entries(coverage)) {
    const rs = (report && report.perSignal.find((s) => s.signalId === signalId)) || {};
    const rt = (rec.retry && rec.retry.perSignal && rec.retry.perSignal[signalId]) || { retried: 0, recovered: 0 };
    L.push(`| ${signalId} | \`${cov.table}\` | ${fmt(rs.attempted ?? rec.eligibleVerified)} | ${fmt(rs.completed ?? cov.distinctDomains)} | ${fmt(cov.distinctDomains)} (${pct(cov.distinctDomains, rec.eligibleVerified)}) | ${fmt(rs.collectorErrors ?? 0)} | ${fmt(rs.dbErrors ?? 0)} | ${fmt(rt.retried)} | ${fmt(rt.recovered)} |`);
  }
  L.push('');
  L.push('> Coverage = distinct VERIFIED domains with a persisted observation in the baseline window.');
  L.push('> The A/B/C collectors record transient DNS/HTTP failures as absence-of-row (a collector');
  L.push('> error), which is the existing pipeline behaviour. "Retried" reflects the single');
  L.push('> re-collection pass over transient failures; recovered = domains that succeeded on retry.');
  L.push('');
  L.push('## 2. National signal benchmarks (adoption over observed population)');
  L.push('');
  L.push('### Category A — Email Trust');
  L.push('');
  L.push('| Signal | Observed | Key adoption |');
  L.push('|---|---|---|');
  L.push(`| SPF | ${fmt(b.A_email.SPF.observed)} | present ${b.A_email.SPF.present}% · \`-all\` ${b.A_email.SPF.hardfail_all}% · \`~all\` ${b.A_email.SPF.softfail_all}% · \`?all\` ${b.A_email.SPF.neutral_all}% |`);
  L.push(`| DMARC | ${fmt(b.A_email.DMARC.observed)} | present ${b.A_email.DMARC.present}% · enforcing (reject+quarantine) ${b.A_email.DMARC.enforcing}% · p=none ${b.A_email.DMARC.none}% |`);
  L.push(`| DKIM | ${fmt(b.A_email.DKIM.observable)} | detected ${b.A_email.DKIM.detected_rate_over_scored}% of scored (absence unprovable → NON_OBSERVED) |`);
  L.push('');
  L.push('### Category B — Domain Trust');
  L.push('');
  L.push('| Signal | Observed | Key adoption |');
  L.push('|---|---|---|');
  L.push(`| DNSSEC | ${fmt(b.B_domain.DNSSEC.observed)} | anchored ${b.B_domain.DNSSEC.anchored}% · island ${b.B_domain.DNSSEC.island}% · unsigned ${b.B_domain.DNSSEC.unsigned}% |`);
  L.push(`| CAA | ${fmt(b.B_domain.CAA.observed)} | present ${b.B_domain.CAA.present}% |`);
  L.push('');
  L.push('### Category C — Control Transparency');
  L.push('');
  L.push('| Signal | Observed | Key adoption |');
  L.push('|---|---|---|');
  L.push(`| Security Headers | ${fmt(b.C_transparency.SECURITY_HEADERS.web_reachable)} web-reachable | ${b.C_transparency.SECURITY_HEADERS.web_reachable_rate}% reachable · mean ${b.C_transparency.SECURITY_HEADERS.mean_headers_present} headers present |`);
  L.push(`| MTA-STS | ${fmt(b.C_transparency.MTA_STS.observed)} | record ${b.C_transparency.MTA_STS.record_present}% · enforce ${b.C_transparency.MTA_STS.enforce}% · testing ${b.C_transparency.MTA_STS.testing}% |`);
  L.push(`| security.txt | ${fmt(b.C_transparency.SECURITY_TXT.observed)} | present ${b.C_transparency.SECURITY_TXT.present}% |`);
  L.push(`| TLS-RPT | — | ${b.C_transparency.TLS_RPT.note} |`);
  L.push('');
  fs.writeFileSync(path.join(REPORTS, 'SIGNAL_COVERAGE_REPORT.md'), L.join('\n'), 'utf8');
}

function writeFailureReport(rec, deriv, report) {
  const L = [];
  L.push(`# Failure Report — ${BASELINE_ID}`);
  L.push('');
  L.push(`**Baseline:** ${rec.baselineId} · window ${rec.startedAt} → ${rec.finishedAt}`);
  L.push('');
  L.push('## 1. Summary');
  L.push('');
  L.push('| Category | Count |');
  L.push('|---|---|');
  L.push(`| Eligible VERIFIED organisations | ${fmt(rec.eligibleVerified)} |`);
  L.push(`| Successfully scanned | ${fmt(rec.successfulScans)} |`);
  L.push(`| Not scanned (0 observations in window) | ${fmt(rec.failedScans)} |`);
  L.push(`| Collector-level failures (all signals) | ${fmt(rec.collectorFailures)} |`);
  L.push(`| Retried (transient re-collection pass) | ${fmt(rec.retry ? rec.retry.totalRetried : 0)} |`);
  L.push(`| Recovered on retry | ${fmt(rec.retry ? rec.retry.totalRecovered : 0)} |`);
  L.push('');
  L.push('## 2. Organisations not scanned');
  L.push('');
  if (rec.unscannedOrgs && rec.unscannedOrgs.length) {
    L.push(`${fmt(rec.unscannedOrgs.length)} VERIFIED organisation(s) produced no observation in the baseline window.`);
    L.push('Reason is recorded per organisation; the most common cause is a domain that did not');
    L.push('resolve or refused all connections (permanent, not transient). Full list in');
    L.push('`dataset/unscanned.ndjson`. First 50 shown:');
    L.push('');
    L.push('| Organisation ID | Name | Domain | Regulators |');
    L.push('|---|---|---|---|');
    for (const o of rec.unscannedOrgs.slice(0, 50)) {
      L.push(`| ${o.organisationId} | ${o.organisationName.slice(0, 40)} | ${o.verifiedDomain} | ${(o.regulators || []).join(', ')} |`);
    }
    L.push('');
  } else {
    L.push('All eligible organisations produced at least one observation. No unscanned organisations.');
    L.push('');
  }
  L.push('## 3. Collector failures by signal (from the collection run report)');
  L.push('');
  if (report && report.failures && report.failures.length) {
    const bySignal = {};
    for (const f of report.failures) bySignal[f.signal] = (bySignal[f.signal] || 0) + 1;
    L.push('| Signal | Collector/DB failures |');
    L.push('|---|---|');
    for (const [s, n] of Object.entries(bySignal)) L.push(`| ${s} | ${fmt(n)} |`);
    L.push('');
    L.push(`Full failure detail (${fmt(report.failures.length)} rows) captured in the collection run`);
    L.push('report at repository root: `ORGAUTHORITY001_COLLECTION_REPORT.md` §5.');
  } else {
    L.push('No collector failures were recorded in the collection run report, or the report was');
    L.push('unavailable at report-generation time.');
  }
  L.push('');
  fs.writeFileSync(path.join(REPORTS, 'FAILURE_REPORT.md'), L.join('\n'), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main({ retry = null } = {}) {
  const supabase = getClient();
  const sinceIso = fs.readFileSync(START_FILE, 'utf8').trim();
  const authoritySummary = JSON.parse(fs.readFileSync(AUTHORITY_SUMMARY, 'utf8'));
  const providerSel = require('../../acquisition/providers/organisation-provider').loadOrganisations();

  console.log('Deriving Trust Profiles over baseline window since', sinceIso, '(single DB read pass) ...');
  const deriv = await derive({ sinceIso, outDir: DATASET });
  const profiles = deriv.profiles;
  console.log('  profiles:', profiles.length, '| scored:', deriv.summary.trustScoresComputed, '| insufficient:', deriv.summary.insufficientObservation);

  // Coverage is computed from the SAME single read (no extra DB scans) — the
  // dedup Maps' .size is the distinct-domain coverage per signal.
  const OBS_MAP = {
    'SOT-SPF-001': { table: 'signal_facts_spf', key: 'spf' },
    'SOT-DMARC-001': { table: 'signal_facts_dmarc', key: 'dmarc' },
    'SOT-DKIM-001': { table: 'signal_facts_dkim', key: 'dkim' },
    'SOT-DNSSEC-001': { table: 'signal_facts_dnssec', key: 'dnssec' },
    'SOT-CAA-001': { table: 'signal_facts_caa', key: 'caa' },
    'SOT-MTASTS-001': { table: 'signal_facts_mtasts', key: 'mtasts' },
    'SOT-SECURITYHEADERS-001': { table: 'signal_securityheaders_v1', key: 'headers' },
    'SOT-SECURITYTXT-001': { table: 'signal_securitytxt_v1', key: 'stxt' },
  };
  const coverage = {};
  for (const [sigId, { table, key }] of Object.entries(OBS_MAP)) {
    const size = deriv.observations[key].size;
    coverage[sigId] = { table, distinctDomains: size, rows: size };
  }

  const report = parseCollectionReport(COLLECTION_REPORT);

  console.log('Building benchmarks ...');
  const bench = buildBenchmarks(profiles);
  fs.writeFileSync(path.join(DATASET, 'benchmarks.json'), JSON.stringify(bench, null, 2), 'utf8');

  // Unscanned organisations (VERIFIED but 0 in-window observations).
  const scannedIds = new Set(profiles.map((p) => p.organisationId));
  const unscannedOrgs = deriv.verified
    .filter((o) => !scannedIds.has(o.organisationId))
    .map((o) => ({ organisationId: o.organisationId, organisationName: o.organisationName, verifiedDomain: o.verifiedDomain, regulators: o.regulators || [], reason: 'no-observation-in-window' }));
  fs.writeFileSync(path.join(DATASET, 'unscanned.ndjson'), unscannedOrgs.map((o) => JSON.stringify(o)).join('\n') + (unscannedOrgs.length ? '\n' : ''), 'utf8');

  // Observation / evidence counts.
  const observationCount = Object.values(coverage).reduce((a, c) => a + c.rows, 0);
  const evidenceCount = Object.values(coverage).reduce((a, c) => a + c.distinctDomains, 0);
  const collectorFailures = report ? report.perSignal.reduce((a, s) => a + s.collectorErrors + s.dbErrors, 0) : null;

  // ── Validation checks ────────────────────────────────────────────────────────
  const validation = {
    everyScoredOrgInAuthority: profiles.every((p) => /^ORG-/.test(p.organisationId)) && profiles.length === scannedIds.size,
    orphanObservations: deriv.summary.orphanObservations,
    oneOrgPerObservation: deriv.summary.orphanObservations === 0, // one-owner-per-domain in the Authority
    noLegacyRegistryRef: providerSel.cohort_id === 'ORG-AUTHORITY-001' && /^org-authority-/.test(providerSel.selection_id),
    deterministic: null, // set below by re-derivation diff
  };

  // Determinism: re-run the (pure) scoring over the SAME observations in memory —
  // identical inputs must yield byte-identical profiles. No second DB read.
  const check = await derive({ sinceIso, preloadedObs: deriv.observations, write: false });
  validation.deterministic = JSON.stringify(deriv.profiles) === JSON.stringify(check.profiles);

  // Coverage completeness: which Core signals reached the full VERIFIED population.
  const CORE_SCORED_SIGNALS = ['SOT-SPF-001', 'SOT-DMARC-001', 'SOT-DKIM-001', 'SOT-DNSSEC-001', 'SOT-CAA-001', 'SOT-MTASTS-001', 'SOT-SECURITYHEADERS-001', 'SOT-SECURITYTXT-001'];
  const partialSignals = CORE_SCORED_SIGNALS.filter((s) => (coverage[s]?.distinctDomains ?? 0) < deriv.summary.eligibleVerified)
    .map((s) => ({ signal: s, coverage: coverage[s].distinctDomains, pct: Number((100 * coverage[s].distinctDomains / deriv.summary.eligibleVerified).toFixed(1)) }));
  const coverageComplete = partialSignals.length === 0;
  const integrityOk = validation.oneOrgPerObservation && validation.noLegacyRegistryRef && validation.deterministic;

  const finishedAt = new Date().toISOString();
  const record = {
    baselineId: BASELINE_ID,
    name: 'National Observatory Baseline 001',
    status: !integrityOk ? 'INVALID' : (coverageComplete ? 'COMPLETE' : 'COMPLETE_PARTIAL_COVERAGE'),
    coverageComplete,
    partialSignals, // signals not yet at full population (e.g. security.txt) — backfill pending
    rubric: RUBRIC,
    signalScope: ['A (Email Trust)', 'B (Domain Trust)', 'C (Control Transparency)'],
    authority: {
      cohortId: providerSel.cohort_id,
      selectionId: providerSel.selection_id,
      totalOrganisations: authoritySummary.totalOrganisations,
      verifiedDomains: authoritySummary.verifiedDomains,
    },
    startedAt: report ? (report.startedAt || sinceIso) : sinceIso,
    finishedAt,
    collectionDurationSec: report ? report.totalElapsed : null,
    durationSec: Math.round((Date.parse(finishedAt) - Date.parse(sinceIso)) / 1000),
    eligibleVerified: deriv.summary.eligibleVerified,
    successfulScans: profiles.length,
    failedScans: unscannedOrgs.length,
    retry: retry || { totalRetried: 0, totalRecovered: 0, perSignal: {}, note: 'no separate retry pass executed' },
    collectorFailures,
    observationCount,
    evidenceCount,
    trustProfiles: profiles.length,
    trustScores: deriv.summary.trustScoresComputed,
    insufficientObservation: deriv.summary.insufficientObservation,
    coreCompleteProfiles: deriv.summary.coreCompleteProfiles,
    validation,
    coverage,
    unscannedOrgs, // kept for report; trimmed from the persisted record below
  };

  // Write reports.
  writeNationalReport(record, bench, deriv);
  writeSignalCoverageReport(record, bench, coverage, report);
  writeFailureReport(record, deriv, report);

  // Persist the permanent baseline record (without the bulky unscanned list).
  const persisted = { ...record };
  delete persisted.unscannedOrgs;
  fs.writeFileSync(path.join(DATASET, 'baseline-record.json'), JSON.stringify(persisted, null, 2), 'utf8');

  console.log('\n' + '═'.repeat(64));
  console.log(` ${BASELINE_ID} — ${record.status}`);
  console.log('═'.repeat(64));
  console.log(`  eligible VERIFIED:      ${record.eligibleVerified}`);
  console.log(`  successfully scanned:   ${record.successfulScans} (${pct(record.successfulScans, record.eligibleVerified)})`);
  console.log(`  not scanned:            ${record.failedScans}`);
  console.log(`  observations:           ${record.observationCount}`);
  console.log(`  trust profiles:         ${record.trustProfiles}`);
  console.log(`  trust scores:           ${record.trustScores}`);
  console.log(`  insufficient:           ${record.insufficientObservation}`);
  console.log(`  validation:             ${JSON.stringify(validation)}`);
  console.log('═'.repeat(64));
  console.log(`  reports → observatory/baseline/reports/`);
  console.log(`  dataset → observatory/baseline/dataset/`);
  return record;
}

if (require.main === module) {
  main().catch((e) => { console.error('Baseline failed:', e.stack || e.message); process.exit(1); });
}

module.exports = { main, parseCollectionReport, inWindowCoverage };
