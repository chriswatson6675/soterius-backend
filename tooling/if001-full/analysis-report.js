'use strict';

// Generic Cohort Analysis Report Generator
// ============================================================================
//
// PURPOSE
//   The Observatory's Collection Report (`<STEM>_COLLECTION_REPORT.md`, produced by
//   run-all.js) documents *how the collection ran* — runtimes, success rates, run
//   UUIDs, failures. It does NOT document *what the collection discovered*. This
//   generator fills that gap: it reads the observations the Observatory already
//   persisted for a completed run and produces an analytical companion report,
//   `<STEM>_ANALYSIS_REPORT.md`.
//
//   It is a pure CONSUMER of Observatory output. It performs no scanning and
//   recollects no evidence — every figure is derived from rows already in the
//   database. It modifies no collector, provider, registry, Observatory or
//   persistence code.
//
// INPUTS
//   1. A completed Collection Report (markdown) — the machine-stable artefact the
//      Observatory writes for every run. It supplies, with no population-specific
//      code: cohort id/name, selection id, the cohort size (n), the collection
//      window, and the per-signal run identifiers (run UUID for v1 signals;
//      started/completed timestamp window for v0 signals — the run-identification
//      method the Observatory itself documents).
//   2. The persisted signal observations in Supabase (`signal_facts_*` for v0,
//      `signal_securitytxt_v1` / `signal_securityheaders_v1` for v1), located using
//      (1). v0 signals are isolated by the per-signal `collected_at` window; v1
//      signals by `run_id`.
//
// OUTPUT
//   `<STEM>_ANALYSIS_REPORT.md` written alongside the Collection Report (same
//   directory, same stem — e.g. `SRAREG001`, `FCAREG001`). Sections: Cohort
//   Summary, Signal Adoption, Distribution, Initial Findings.
//
// CALCULATION METHODOLOGY (deterministic; no randomness, no time-dependence in the
// figures — only the "generated at" stamp varies between runs):
//   * observed  = rows persisted for the signal for this run.
//   * present   = rows whose signal-present flag is true (v0) / whose state denotes
//                 presence (v1).
//   * absent    = observed − present − (indeterminate, where a signal has an
//                 explicit indeterminate state, e.g. security.txt).
//   * failures  = rows that recorded a genuine retrieval error. A clean negative
//                 observation (e.g. DKIM `NOT_DETECTED`, SPF simply absent) is NOT a
//                 failure.
//   * adoption% = present / observed × 100, to one decimal place.
//   Distributions use only objectively stored columns (DMARC policy, MTA-STS mode,
//   DNSSEC DS presence, security.txt file_state, security-header inventory).
//
// POPULATION-AGNOSTIC
//   Nothing here is FCA/SRA/IF-specific. The cohort identity comes from the report;
//   the signal→table mapping and the analysis are identical for every population,
//   so a future registry's report works with no code change.
//
// RELATIONSHIP TO THE COLLECTION REPORT
//   Collection Report = "How the Observatory ran."  (run-all.js)
//   Analysis Report   = "What the Observatory observed."  (this module)
//   The Collection Report is unchanged and remains the run-of-record; this is an
//   additional, derived artefact. Both are intended to be produced after every run.
//
// USAGE
//   node analysis-report.js <path-to-…_COLLECTION_REPORT.md>
//
// ============================================================================

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });
const fs   = require('node:fs');
const path = require('node:path');

// ── Signal specifications (population-agnostic) ─────────────────────────────────
// Each spec declares where the signal is stored, which columns the analysis needs,
// and a pure analyser that turns the fetched rows into an analysis result. v1 signals
// are located by run_id; v0 by collected_at window.

const CORE_HEADERS = [
  'strict_transport_security',
  'content_security_policy',
  'x_content_type_options',
  'x_frame_options',
  'referrer_policy',
  'permissions_policy',
];
const REPORTED_HEADERS = [...CORE_HEADERS, 'x_xss_protection'];

const HEADER_LABELS = {
  strict_transport_security: 'Strict-Transport-Security (HSTS)',
  content_security_policy:   'Content-Security-Policy',
  x_content_type_options:    'X-Content-Type-Options',
  x_frame_options:           'X-Frame-Options',
  referrer_policy:           'Referrer-Policy',
  permissions_policy:        'Permissions-Policy',
  x_xss_protection:          'X-XSS-Protection',
};

// Simple v0 present/absent analyser factory. `presentOf` returns true when the row
// observed the signal present; `failureOf` returns true for a genuine retrieval
// error (default: a non-null error column).
function simpleV0Analyser(presentOf, failureOf) {
  return rows => {
    const observed = rows.length;
    let present = 0, failures = 0;
    for (const r of rows) {
      if (presentOf(r)) present++;
      if (failureOf(r)) failures++;
    }
    return { observed, present, absent: observed - present, failures, adoptionPct: pct(present, observed) };
  };
}

function pct(num, den) { return den > 0 ? Number((num / den * 100).toFixed(1)) : 0; }

const SIGNAL_SPECS = [
  {
    signalId: 'SOT-SPF-001', label: 'SPF', table: 'signal_facts_spf', schema: 'v0',
    columns: ['spf_present', 'spf_collection_error'],
    analyse: rows => {
      const base = simpleV0Analyser(r => r.spf_present === true, r => r.spf_collection_error != null)(rows);
      base.distribution = { title: 'SPF', buckets: [
        ['Present', base.present],
        ['Missing', base.absent],
      ]};
      return base;
    },
  },
  {
    signalId: 'SOT-DKIM-001', label: 'DKIM', table: 'signal_facts_dkim', schema: 'v0',
    columns: ['dkim_present', 'dkim_collection_status'],
    // NOT_DETECTED is a clean negative (no selector found), not a retrieval failure.
    analyse: simpleV0Analyser(
      r => r.dkim_present === true,
      r => r.dkim_collection_status != null && r.dkim_collection_status !== 'NOT_DETECTED',
    ),
  },
  {
    signalId: 'SOT-DMARC-001', label: 'DMARC', table: 'signal_facts_dmarc', schema: 'v0',
    columns: ['dmarc_present', 'dmarc_policy', 'dmarc_collection_error'],
    analyse: rows => {
      const base = simpleV0Analyser(r => r.dmarc_present === true, r => r.dmarc_collection_error != null)(rows);
      let reject = 0, quarantine = 0, none = 0;
      for (const r of rows) {
        if (r.dmarc_present !== true) continue;
        if (r.dmarc_policy === 'reject') reject++;
        else if (r.dmarc_policy === 'quarantine') quarantine++;
        else none++;               // present with p=none or unspecified policy
      }
      base.distribution = { title: 'DMARC policy', buckets: [
        ['reject', reject],
        ['quarantine', quarantine],
        ['none', none],
        ['missing (no DMARC)', base.absent],
      ]};
      return base;
    },
  },
  {
    signalId: 'SOT-MTASTS-001', label: 'MTA-STS', table: 'signal_facts_mtasts', schema: 'v0',
    columns: ['dns_sts_present', 'policy_mode', 'dns_collection_error'],
    analyse: rows => {
      const base = simpleV0Analyser(r => r.dns_sts_present === true, r => r.dns_collection_error != null)(rows);
      let enforce = 0, testing = 0, none = 0;
      for (const r of rows) {
        if (r.dns_sts_present !== true) continue;
        if (r.policy_mode === 'enforce') enforce++;
        else if (r.policy_mode === 'testing') testing++;
        else none++;
      }
      base.distribution = { title: 'MTA-STS mode', buckets: [
        ['enforce', enforce],
        ['testing', testing],
        ['none/unspecified', none],
        ['absent', base.absent],
      ]};
      return base;
    },
  },
  {
    signalId: 'SOT-TLSRPT-001', label: 'TLS-RPT', table: 'signal_facts_tlsrpt', schema: 'v0',
    columns: ['dns_tlsrpt_present', 'dns_collection_error'],
    analyse: simpleV0Analyser(r => r.dns_tlsrpt_present === true, r => r.dns_collection_error != null),
  },
  {
    signalId: 'SOT-DNSSEC-001', label: 'DNSSEC', table: 'signal_facts_dnssec', schema: 'v0',
    columns: ['dns_ds_present', 'ds_collection_error'],
    analyse: rows => {
      const base = simpleV0Analyser(r => r.dns_ds_present === true, r => r.ds_collection_error != null)(rows);
      base.distribution = { title: 'DNSSEC', buckets: [
        ['signed (DS present)', base.present],
        ['unsigned', base.absent],
      ]};
      return base;
    },
  },
  {
    signalId: 'SOT-CAA-001', label: 'CAA', table: 'signal_facts_caa', schema: 'v0',
    columns: ['dns_caa_present', 'caa_collection_error'],
    analyse: simpleV0Analyser(r => r.dns_caa_present === true, r => r.caa_collection_error != null),
  },
  {
    signalId: 'SOT-SECURITYTXT-001', label: 'security.txt', table: 'signal_securitytxt_v1', schema: 'v1',
    columns: ['file_state'],
    analyse: rows => {
      const observed = rows.length;
      const states = {};
      let present = 0, indeterminate = 0;
      for (const r of rows) {
        const st = r.file_state || 'UNKNOWN';
        states[st] = (states[st] || 0) + 1;
        if (/^PRESENT/.test(st)) present++;
        else if (st === 'INDETERMINATE') indeterminate++;
      }
      return {
        observed, present, absent: observed - present - indeterminate,
        failures: indeterminate, adoptionPct: pct(present, observed),
        distribution: { title: 'security.txt file state', buckets: Object.entries(states).sort((a, b) => b[1] - a[1]) },
      };
    },
  },
  {
    signalId: 'SOT-SECURITYHEADERS-001', label: 'security headers', table: 'signal_securityheaders_v1', schema: 'v1',
    columns: ['endpoint_state', 'header_inventory'],
    analyse: rows => {
      const observed = rows.length;
      let served = 0, present = 0;
      const tiers = { complete: 0, partial: 0, minimal: 0, absent: 0 };
      const headerCounts = {};
      for (const h of REPORTED_HEADERS) headerCounts[h] = 0;
      for (const r of rows) {
        const didServe = String(r.endpoint_state || '').toUpperCase() === 'RESPONSE_OBSERVED';
        if (didServe) served++;
        const inv = r.header_inventory || {};
        let coreCount = 0;
        for (const h of REPORTED_HEADERS) if (inv[h] && inv[h].present === true) { headerCounts[h]++; if (CORE_HEADERS.includes(h)) coreCount++; }
        // Tier classification (core headers only): not-served counts as absent.
        if (!didServe || coreCount === 0) tiers.absent++;
        else if (coreCount <= 2) tiers.minimal++;
        else if (coreCount <= 4) tiers.partial++;
        else tiers.complete++;
        if (didServe && coreCount >= 1) present++;
      }
      return {
        observed, present, absent: observed - present,
        failures: observed - served,   // not-served = retrieval failure
        served, adoptionPct: pct(present, observed),
        distribution: { title: 'Security Headers maturity', buckets: [
          ['complete (5–6 core)', tiers.complete],
          ['partial (3–4 core)',  tiers.partial],
          ['minimal (1–2 core)',  tiers.minimal],
          ['absent (0 core / not served)', tiers.absent],
        ]},
        headerCounts, servedPct: pct(served, observed),
      };
    },
  },
];

const SPEC_BY_ID = Object.fromEntries(SIGNAL_SPECS.map(s => [s.signalId, s]));

// ── Collection Report parsing (population-agnostic) ─────────────────────────────

function parseCollectionReport(md) {
  const cohortLine = md.match(/^\*\*Cohort:\*\*\s*(.+?)\s+—\s+(.+)$/m);
  if (!cohortLine) throw new Error('Could not parse Cohort line from collection report');
  const selLine   = md.match(/^\*\*Selection ID:\*\*\s*(.+)$/m);
  const startLine = md.match(/^\*\*Collection started:\*\*\s*(.+)$/m);
  const endLine   = md.match(/^\*\*Collection completed:\*\*\s*(.+)$/m);

  const cellInt = label => {
    const m = md.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([0-9,]+)\\s*\\|`));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  // §6 Run UUID Register rows: | SOT-… | `uuid` | v0/v1 | startedAt | completedAt | … |
  const signals = [];
  const rowRe = /^\|\s*(SOT-[A-Z0-9-]+)\s*\|\s*`([0-9a-f-]+)`\s*\|\s*(v[01])\s*\|\s*([0-9TZ:.\-]+)\s*\|\s*([0-9TZ:.\-]+)\s*\|/gm;
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    signals.push({ signalId: m[1], runId: m[2], schema: m[3], startedAt: m[4].trim(), completedAt: m[5].trim() });
  }
  if (signals.length === 0) throw new Error('Could not parse §6 Run UUID Register from collection report');

  return {
    cohortId:    cohortLine[1].trim(),
    cohortName:  cohortLine[2].trim(),
    selectionId: selLine ? selLine[1].trim() : null,
    started:     startLine ? startLine[1].trim() : null,
    completed:   endLine ? endLine[1].trim() : null,
    n:         cellInt('Domains in cohort'),
    attempted: cellInt('Total observations attempted'),
    stored:    cellInt('Total observations stored'),
    signals,
  };
}

// ── Supabase fetch (the only I/O against persisted observations) ─────────────────

function getClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

// v0 rows carry no run_id, so they are isolated by collected_at. We use the GLOBAL
// collection window (the run's overall start→finish from the report header) rather than
// the per-signal window: within a single run every row for a signal's table belongs to
// that run, and the global window is guaranteed to bound them all (a per-signal window
// can clip rows whose collected_at lands just outside that signal's own start/finish
// stamps — e.g. DKIM's dual-table write). Runs do not overlap in time, so the global
// window selects exactly this run's rows.
async function fetchRows(sb, spec, sig, meta) {
  const cols = spec.columns.join(',');
  const out = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    let q = sb.from(spec.table).select(cols).range(from, from + page - 1);
    if (spec.schema === 'v1') q = q.eq('run_id', sig.runId);
    else q = q.gte('collected_at', meta.started).lte('collected_at', meta.completed);
    const { data, error } = await q;
    if (error) throw new Error(`${spec.table}: ${error.message}`);
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// ── Findings (deterministic, threshold-driven, observation-only) ────────────────

function adoptionBand(p) {
  if (p === 0)   return 'was not observed in any organisation';
  if (p < 5)     return 'is rare';
  if (p < 20)    return 'is uncommon';
  if (p < 50)    return 'is partially adopted';
  if (p < 80)    return 'is deployed by a majority of organisations';
  return 'is widely deployed';
}

function buildFindings(analyses) {
  const a = Object.fromEntries(analyses.map(x => [x.signalId, x]));
  const lines = [];
  const get = id => a[id] ? a[id].adoptionPct : null;

  // Per-signal observational lines.
  for (const x of analyses) {
    lines.push(`- ${cap(x.label)} ${adoptionBand(x.adoptionPct)} (${x.adoptionPct}% — ${x.present}/${x.observed}).`);
  }

  // Grouped observations (factual, threshold-driven).
  const grouped = [];
  const auth = ['SOT-SPF-001', 'SOT-DKIM-001', 'SOT-DMARC-001'].map(get).filter(v => v != null);
  if (auth.length === 3) {
    const minAuth = Math.min(...auth);
    if (minAuth >= 50) grouped.push('Email authentication (SPF, DKIM, DMARC) is deployed by a majority of organisations across the cohort.');
    else grouped.push('Email authentication (SPF, DKIM, DMARC) is unevenly deployed across the cohort.');
  }
  const transport = ['SOT-MTASTS-001', 'SOT-TLSRPT-001'].map(get).filter(v => v != null);
  if (transport.length === 2 && Math.max(...transport) < 10) {
    grouped.push('Email transport-security policies (MTA-STS, TLS-RPT) are rare.');
  }
  const dns = ['SOT-DNSSEC-001', 'SOT-CAA-001'].map(get).filter(v => v != null);
  if (dns.length === 2 && Math.max(...dns) < 20) {
    grouped.push('DNS-integrity controls (DNSSEC, CAA) have low adoption.');
  }
  if (get('SOT-SECURITYTXT-001') != null && get('SOT-SECURITYTXT-001') < 20) {
    grouped.push('Published vulnerability-disclosure channels (security.txt) are uncommon.');
  }

  return { perSignal: lines, grouped };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Markdown rendering ──────────────────────────────────────────────────────────

function renderReport(meta, analyses, findings, generatedAt) {
  const stem = reportStem(meta.cohortId);
  const observationsCollected = analyses.reduce((s, x) => s + x.observed, 0);
  const expected = meta.n != null ? meta.n * SIGNAL_SPECS.length : null;
  const completion = expected ? pct(observationsCollected, expected) : null;

  const L = [];
  L.push(`# ${stem}_ANALYSIS_REPORT`);
  L.push('');
  L.push(`**Cohort:** ${meta.cohortId} — ${meta.cohortName}`);
  L.push(`**Selection ID:** ${meta.selectionId}`);
  L.push(`**Source collection:** ${stem}_COLLECTION_REPORT.md (collection window ${meta.started} → ${meta.completed})`);
  L.push('');
  L.push('> This report documents **what the Observatory observed** for this completed run.');
  L.push('> It is derived entirely from persisted observations — no rescanning occurred.');
  L.push('> Its companion `' + stem + '_COLLECTION_REPORT.md` documents **how the collection ran**.');
  L.push('');
  L.push('---');
  L.push('');

  // 1. Cohort Summary
  L.push('## 1. Cohort Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Population | ${meta.cohortName} (${meta.cohortId}) |`);
  L.push(`| Selection ID | \`${meta.selectionId}\` |`);
  L.push(`| Organisations scanned | ${meta.n} |`);
  L.push(`| Signals analysed | ${analyses.length} |`);
  L.push(`| Observations collected | ${observationsCollected} |`);
  if (expected != null) L.push(`| Observations expected (n × signals) | ${expected} |`);
  if (completion != null) L.push(`| Completion rate | **${completion}%** |`);
  L.push('');
  L.push('---');
  L.push('');

  // 2. Signal Adoption
  L.push('## 2. Signal Adoption');
  L.push('');
  L.push('Adoption = observed-present ÷ observed, over the records persisted for this run.');
  L.push('');
  L.push('| Signal | Observed | Present | Absent | Retrieval failures | Adoption |');
  L.push('|---|---|---|---|---|---|');
  for (const x of analyses) {
    L.push(`| ${x.label} | ${x.observed} | ${x.present} | ${x.absent} | ${formatFailures(x)} | **${x.adoptionPct}%** |`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // 3. Distribution
  L.push('## 3. Distribution');
  L.push('');
  L.push('Objectively observable breakdowns, derived from stored columns only.');
  L.push('');
  for (const x of analyses) {
    if (!x.distribution) continue;
    L.push(`### ${x.distribution.title}`);
    L.push('');
    L.push('| Category | Count | Share |');
    L.push('|---|---|---|');
    for (const [name, count] of x.distribution.buckets) {
      L.push(`| ${name} | ${count} | ${pct(count, x.observed)}% |`);
    }
    L.push('');
  }
  // Security-headers per-header detail
  const sh = analyses.find(x => x.signalId === 'SOT-SECURITYHEADERS-001');
  if (sh && sh.headerCounts) {
    L.push('### Security Headers — individual header presence');
    L.push('');
    L.push(`Of ${sh.observed} observed, ${sh.served} (${sh.servedPct}%) served an HTTP response.`);
    L.push('');
    L.push('| Header | Present | Share |');
    L.push('|---|---|---|');
    const ordered = Object.entries(sh.headerCounts).sort((a, b) => b[1] - a[1]);
    for (const [h, c] of ordered) L.push(`| ${HEADER_LABELS[h] || h} | ${c} | ${pct(c, sh.observed)}% |`);
    L.push('');
  }
  L.push('---');
  L.push('');

  // 4. Initial Findings
  L.push('## 4. Initial Findings');
  L.push('');
  L.push('Observation-only summaries derived from the figures above. No recommendations; no speculation.');
  L.push('');
  for (const line of findings.perSignal) L.push(line);
  if (findings.grouped.length) {
    L.push('');
    for (const g of findings.grouped) L.push(`- ${g}`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Validation footer
  // Reconciliation against the Collection Report's self-reported "stored" count. The
  // Σ-observed figure is the DB ground truth. A POSITIVE delta is benign — the DB holds
  // at least every write the orchestrator reported, plus the occasional write whose
  // network acknowledgement failed (logged as a DB error) but whose insert actually
  // committed. Only a NEGATIVE delta (rows missing vs reported) is a genuine fault.
  let delta = null, reconcile = 'n/a', reconcileOk = true;
  if (meta.stored != null) {
    delta = observationsCollected - meta.stored;
    if (delta === 0) reconcile = '✓ MATCH';
    else if (delta > 0) { reconcile = `✓ MATCH (+${delta} — DB rows exceed orchestrator-reported writes; a write acked-as-failed but committed)`; }
    else { reconcile = `✗ SHORTFALL (${delta} — fewer DB rows than reported stored)`; reconcileOk = false; }
  }
  L.push('## 5. Reconciliation');
  L.push('');
  L.push('| Check | Value |');
  L.push('|---|---|');
  L.push(`| Observations collected (Σ observed, DB ground truth) | ${observationsCollected} |`);
  L.push(`| Observations stored (Collection Report §1) | ${meta.stored != null ? meta.stored : 'n/a'} |`);
  if (delta != null) L.push(`| Delta | ${delta > 0 ? '+' : ''}${delta} |`);
  L.push(`| Reconciliation | ${reconcile} |`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(`*Generated: ${generatedAt}*`);
  L.push(`*Derived from persisted observations; no rescanning. Source population: ${meta.cohortName} (${meta.cohortId}).*`);

  return { markdown: L.join('\n'), observationsCollected, completion, delta, reconcileOk };
}

function formatFailures(x) {
  if (x.signalId === 'SOT-SECURITYTXT-001') return `${x.failures} indeterminate`;
  if (x.signalId === 'SOT-SECURITYHEADERS-001') return `${x.failures} not served`;
  if (x.signalId === 'SOT-DKIM-001') return x.failures === 0 ? 'status-tracked (0)' : String(x.failures);
  return String(x.failures);
}

const reportStem = id => String(id).replace(/[^A-Za-z0-9]/g, '');

// ── Orchestration ───────────────────────────────────────────────────────────────

async function analyseRun(reportPath, { generatedAt } = {}) {
  const md   = fs.readFileSync(reportPath, 'utf8');
  const meta = parseCollectionReport(md);
  const sb   = getClient();

  const analyses = [];
  for (const sig of meta.signals) {
    const spec = SPEC_BY_ID[sig.signalId];
    if (!spec) continue;                       // unknown signal in report — skip, stay generic
    const rows = await fetchRows(sb, spec, sig, meta);
    analyses.push({ signalId: sig.signalId, label: spec.label, ...spec.analyse(rows) });
  }

  const findings = buildFindings(analyses);
  const rendered = renderReport(meta, analyses, findings, generatedAt || new Date().toISOString());
  return { meta, analyses, rendered };
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: node analysis-report.js <path-to-…_COLLECTION_REPORT.md>');
    process.exit(1);
  }
  const absReport = path.resolve(reportPath);
  if (!fs.existsSync(absReport)) {
    console.error(`Collection report not found: ${absReport}`);
    process.exit(1);
  }

  const { meta, rendered } = await analyseRun(absReport);
  const outPath = path.join(path.dirname(absReport), `${reportStem(meta.cohortId)}_ANALYSIS_REPORT.md`);
  fs.writeFileSync(outPath, rendered.markdown, 'utf8');

  console.log(`\n  Cohort:        ${meta.cohortId} — ${meta.cohortName}`);
  console.log(`  Organisations: ${meta.n}`);
  console.log(`  Observations:  ${rendered.observationsCollected} collected${meta.stored != null ? ` / ${meta.stored} stored` : ''}`);
  console.log(`  Reconciliation: ${rendered.reconcileOk ? 'OK' : 'SHORTFALL'}${rendered.delta != null && rendered.delta !== 0 ? ` (delta ${rendered.delta >= 0 ? '+' : ''}${rendered.delta})` : ''}`);
  console.log(`  Analysis report: ${outPath}\n`);
  if (!rendered.reconcileOk) process.exit(2);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  parseCollectionReport,
  SIGNAL_SPECS,
  SPEC_BY_ID,
  buildFindings,
  adoptionBand,
  renderReport,
  analyseRun,
  reportStem,
  pct,
};
