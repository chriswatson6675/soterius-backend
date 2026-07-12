'use strict';
// CAA National Baseline snapshot exporter
//
// Materialises a CAA national baseline (latest observation per domain within a
// collection-time window) from the append-only signal_facts_caa table into an
// immutable repository dataset — the CAA analogue of nob-001r / nob-dkim-001r.
// Read-only against the database; writes only local NDJSON + JSON. Deterministic
// for a fixed window (append-only source + stable sort → stable SHA).
//
// It is used twice, with the SAME code (no drift), to preserve full audit lineage:
//   • the ORIGINAL size-censored baseline (NOB-CAA-001),  the 2026-07-06/07 window
//   • the VALIDATED replacement baseline  (NOB-CAA-001R), the CR-CAA-001 re-run
//
// Governance: CR-CAA-001, under SLG-064 `[C]` Conditional Operational Remediation,
// triggered by SLG-067. Records observations only — no scores, ratings, weights or
// benchmarks. Alters no historical evidence.
//
// Usage:
//   node backend/observatory/quality/caa-baseline-snapshot.js \
//        --label NOB-CAA-001  --outdir nob-caa-001 \
//        --after 2026-07-06T23:57:33Z --before 2026-07-07T00:08:09Z
//   node backend/observatory/quality/caa-baseline-snapshot.js \
//        --label NOB-CAA-001R --outdir nob-caa-001r --after <run-start>

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const LABEL  = arg('label');
const OUTDIR = arg('outdir');
const BEFORE = arg('before');  // upper bound (exclusive) on collected_at
const AFTER  = arg('after');   // lower bound (inclusive) on collected_at
if (!LABEL || !OUTDIR) { console.error('need --label and --outdir'); process.exit(1); }

const DIR  = path.join(__dirname, OUTDIR);
const PAGE = 1000;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

// Paginate by the stable unique key (id). Ordering by collected_at is unsafe:
// rows within a run can share a timestamp, and range pagination over a non-unique
// sort key skips/duplicates rows across pages.
async function fetchAll(sb, table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (BEFORE) q = q.lt('collected_at', BEFORE);
    if (AFTER)  q = q.gte('collected_at', AFTER);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    process.stdout.write(`\r  ${table}: ${out.length} rows`);
    if (data.length < PAGE) break;
  }
  process.stdout.write('\n');
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bump   = (o, k) => { o[k] = (o[k] || 0) + 1; };

// RFC 8659 §4.2: the issuer-domain-name is the value up to the first ';'.
// An empty issuer-domain-name (value "" or ";") requests NO issuance.
const issuerOf = (v) => String(v).split(';')[0].trim().toLowerCase();
const isDenyAll = (v) => { const t = String(v).trim(); return t === '' || t === ';'; };

(async () => {
  console.log(`\nCAA baseline snapshot — ${LABEL}  (window: ${AFTER ? `>= ${AFTER} ` : ''}${BEFORE ? `< ${BEFORE}` : ''})`);
  fs.mkdirSync(DIR, { recursive: true });
  const sb = getClient();

  const rows = await fetchAll(sb, 'signal_facts_caa',
    'id,domain,signal_version,collected_at,dns_caa_present,caa_collection_error,caa_records,' +
    'caa_record_count,caa_issue_count,caa_issuewild_count,caa_iodef_count,caa_unknown_tag_count,' +
    'caa_critical_count,caa_issue_values,caa_issuewild_values,caa_iodef_values,caa_tags_present');

  // ── Reduce to latest observation per domain within the window ───────────────
  const latestByDomain = new Map();
  for (const r of rows) {
    const cur = latestByDomain.get(r.domain);
    if (!cur || r.collected_at > cur.collected_at) latestByDomain.set(r.domain, r);
  }
  const latest = [...latestByDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  const duplicateRows = rows.length - latest.length;
  console.log(`  raw rows ${rows.length} · distinct domains ${latest.length} · duplicate rows ${duplicateRows}`);

  // ── Serialise NDJSON (stable order → stable SHA) ────────────────────────────
  const obsNd = latest.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Observational statistics (facts only) ───────────────────────────────────
  const present = latest.filter(r => r.dns_caa_present === true);
  const absent  = latest.filter(r => r.dns_caa_present === false);
  const unknown = latest.filter(r => r.dns_caa_present === null);
  const errOf   = (e) => unknown.filter(r => r.caa_collection_error === e).length;
  const observed = latest.length - unknown.length;

  const recHist = {}, tagCounts = {}, tagProfile = {}, flagsSeen = {};
  const issuerIssue = {}, issuerWild = {};
  let issueDenyAllRecs = 0, wildDenyAllRecs = 0, totalRecords = 0;
  let criticalRecs = 0, criticalOnUnrecognised = 0, paramRecs = 0, emptyValueRecs = 0;

  for (const r of present) {
    bump(recHist, r.caa_record_count);
    bump(tagProfile, (r.caa_tags_present || []).join('+'));
    for (const t of (r.caa_tags_present || [])) bump(tagCounts, t);
    for (const rec of (r.caa_records || [])) {
      totalRecords++;
      bump(flagsSeen, rec.flags);
      const critical = (rec.flags & 128) > 0;
      if (critical) criticalRecs++;
      if (critical && !['issue', 'issuewild', 'iodef'].includes(rec.tag)) criticalOnUnrecognised++;
      if (String(rec.value) === '') emptyValueRecs++;
      if (rec.tag === 'issue' || rec.tag === 'issuewild') {
        if (String(rec.value).includes(';') && !isDenyAll(rec.value)) paramRecs++;
        if (isDenyAll(rec.value)) { rec.tag === 'issue' ? issueDenyAllRecs++ : wildDenyAllRecs++; }
        else bump(rec.tag === 'issue' ? issuerIssue : issuerWild, issuerOf(rec.value));
      }
    }
  }

  const topN = (o, n = 25) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));

  // ── Schema-integrity invariants (SLG-067 §7) ────────────────────────────────
  const V = {
    count_null_when_known:   latest.filter(r => r.dns_caa_present !== null && r.caa_record_count === null).length,
    count_set_when_unknown:  latest.filter(r => r.dns_caa_present === null && r.caa_record_count !== null).length,
    unknown_without_error:   latest.filter(r => r.dns_caa_present === null && r.caa_collection_error === null).length,
    error_when_known:        latest.filter(r => r.dns_caa_present !== null && r.caa_collection_error !== null).length,
    present_zero_records:    latest.filter(r => r.dns_caa_present === true && r.caa_record_count === 0).length,
    absent_nonzero_records:  latest.filter(r => r.dns_caa_present === false && r.caa_record_count !== 0).length,
    count_vs_jsonb:          present.filter(r => r.caa_record_count !== (r.caa_records || []).length).length,
    tag_partition:           present.filter(r => (r.caa_issue_count + r.caa_issuewild_count + r.caa_iodef_count + r.caa_unknown_tag_count) !== r.caa_record_count).length,
    issue_values_vs_count:   present.filter(r => (r.caa_issue_values || []).length !== r.caa_issue_count).length,
    unknown_has_records:     unknown.filter(r => (r.caa_records || []).length !== 0).length,
    absent_has_tags:         absent.filter(r => (r.caa_tags_present || []).length !== 0).length,
    version_drift:           latest.filter(r => r.signal_version !== 1).length,
  };
  const violations = Object.values(V).reduce((a, b) => a + b, 0);

  const dist = {
    label: LABEL,
    population: latest.length,
    raw_rows: rows.length,
    duplicate_rows: duplicateRows,
    outcomes: {
      present: present.length, absent: absent.length, unknown: unknown.length,
      dns_failure: errOf('DNS_FAILURE'), dns_servfail: errOf('DNS_SERVFAIL'), dns_timeout: errOf('DNS_TIMEOUT'),
    },
    observed_population: observed,
    observation_completeness_pct: +(100 * observed / latest.length).toFixed(3),
    publication_rate_pct:  { of_population: +(100 * present.length / latest.length).toFixed(3),
                             of_observed:   +(100 * present.length / observed).toFixed(3) },
    absence_rate_pct:      { of_population: +(100 * absent.length / latest.length).toFixed(3),
                             of_observed:   +(100 * absent.length / observed).toFixed(3) },
    nonobservation_rate_pct: +(100 * unknown.length / latest.length).toFixed(3),
    records: {
      total: totalRecords,
      mean_per_present_domain: +(totalRecords / present.length).toFixed(3),
      max_per_domain: Math.max(...present.map(r => r.caa_record_count)),
      histogram: Object.fromEntries(Object.entries(recHist).sort((a, b) => +a[0] - +b[0])),
    },
    tag_counts: tagCounts,
    tag_profiles: topN(tagProfile, 30),
    distinct_tags: Object.keys(tagCounts).sort(),
    issuers: { issue: topN(issuerIssue, 40), issuewild: topN(issuerWild, 40),
               distinct_issue_issuers: Object.keys(issuerIssue).length },
    deny_all: { issue_records: issueDenyAllRecs, issuewild_records: wildDenyAllRecs },
    empty_string_value_records: emptyValueRecs,
    parameter_bearing_records: paramRecs,
    critical: { records: criticalRecs, on_unrecognised_tag: criticalOnUnrecognised },
    flags_observed: Object.fromEntries(Object.entries(flagsSeen).sort((a, b) => +a[0] - +b[0])),
    schema_integrity: { invariants: 12, violations, detail: V },
  };
  fs.writeFileSync(path.join(DIR, 'distribution.json'), JSON.stringify(dist, null, 2));

  const manifest = {
    run_label: LABEL,
    signal: 'SOT-CAA-001',
    category: 'B — Domain Trust (Signal 1)',
    population: latest.length,
    cohort_id: 'ORG-AUTHORITY-001',
    window: { after: AFTER || null, before: BEFORE || null },
    collected_span: {
      earliest: latest.reduce((m, r) => r.collected_at < m ? r.collected_at : m, latest[0].collected_at),
      latest:   latest.reduce((m, r) => r.collected_at > m ? r.collected_at : m, latest[0].collected_at),
    },
    counts: { observations: latest.length, raw_rows: rows.length, duplicate_rows: duplicateRows, records: totalRecords },
    sha256: { observations: sha256(obsNd) },
    signal_version: 1,
    observation_completeness_pct: dist.observation_completeness_pct,
    nonobservation_rate_pct: dist.nonobservation_rate_pct,
    publication_rate_pct: dist.publication_rate_pct.of_population,
    schema_integrity_violations: violations,
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n  wrote ${DIR}`);
  console.log(`  observations ${latest.length} (sha ${manifest.sha256.observations.slice(0, 12)}…)  records ${totalRecords}`);
  console.log(`  present ${present.length} (${dist.publication_rate_pct.of_population}%)  absent ${absent.length}  unknown ${unknown.length} (${dist.nonobservation_rate_pct}%)`);
  console.log(`  max records/domain ${dist.records.max_per_domain}   distinct tags ${dist.distinct_tags.join(', ')}`);
  console.log(`  schema integrity: ${violations} violations across 12 invariants\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
