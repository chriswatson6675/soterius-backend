'use strict';
// CAA baseline comparison — NOB-CAA-001 (original) vs NOB-CAA-001R (validated)
//
// Governance: CR-CAA-001, under SLG-064 `[C]` Conditional Operational Remediation.
// Read-only against two immutable snapshot directories produced by
// caa-baseline-snapshot.js. Touches no database and no historical evidence.
// Records observations only — no scores, ratings, weights or benchmarks.
//
// Usage:
//   node backend/observatory/quality/caa-baseline-compare.js nob-caa-001 nob-caa-001r

const path = require('path');
const fs   = require('fs');

const A = process.argv[2] || 'nob-caa-001';
const B = process.argv[3] || 'nob-caa-001r';
const dirA = path.join(__dirname, A), dirB = path.join(__dirname, B);

const load = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
const obs  = (d) => fs.readFileSync(path.join(d, 'observations.ndjson'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));

const da = load(dirA, 'distribution.json'), db = load(dirB, 'distribution.json');
const ma = load(dirA, 'manifest.json'),    mb = load(dirB, 'manifest.json');
const oa = obs(dirA), ob = obs(dirB);

const byDomA = new Map(oa.map(r => [r.domain, r]));
const byDomB = new Map(ob.map(r => [r.domain, r]));

const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => `${x}%`;
const line = () => console.log('─'.repeat(96));

console.log(`\nCAA BASELINE COMPARISON — ${ma.run_label} → ${mb.run_label}\n`);

// ── 1. Structural verification ──────────────────────────────────────────────
line();
console.log(' 1. STRUCTURAL VERIFICATION');
line();
const rows = [
  ['row count (raw, in window)', ma.counts.raw_rows, mb.counts.raw_rows],
  ['domain count (distinct)',    ma.population,      mb.population],
  ['duplicate rows',             ma.counts.duplicate_rows, mb.counts.duplicate_rows],
  ['signal_version',             ma.signal_version,  mb.signal_version],
  ['schema-integrity violations (of 12)', ma.schema_integrity_violations, mb.schema_integrity_violations],
  ['observations sha256',        ma.sha256.observations.slice(0, 16) + '…', mb.sha256.observations.slice(0, 16) + '…'],
];
console.log(`  ${pad('measure', 42)}${pad(ma.run_label, 26)}${mb.run_label}`);
for (const [k, x, y] of rows) console.log(`  ${pad(k, 42)}${pad(x, 26)}${y}`);

// ── 2. Observation completeness ─────────────────────────────────────────────
line();
console.log(' 2. OBSERVATION COMPLETENESS & RATES');
line();
const r2 = [
  ['present',                da.outcomes.present,  db.outcomes.present],
  ['absent',                 da.outcomes.absent,   db.outcomes.absent],
  ['unknown (non-observed)', da.outcomes.unknown,  db.outcomes.unknown],
  ['  · DNS_FAILURE',        da.outcomes.dns_failure,  db.outcomes.dns_failure],
  ['  · DNS_SERVFAIL',       da.outcomes.dns_servfail, db.outcomes.dns_servfail],
  ['  · DNS_TIMEOUT',        da.outcomes.dns_timeout,  db.outcomes.dns_timeout],
  ['observation completeness', pct(da.observation_completeness_pct), pct(db.observation_completeness_pct)],
  ['publication rate (of population)', pct(da.publication_rate_pct.of_population), pct(db.publication_rate_pct.of_population)],
  ['publication rate (of observed)',   pct(da.publication_rate_pct.of_observed),   pct(db.publication_rate_pct.of_observed)],
  ['absence rate (of population)',     pct(da.absence_rate_pct.of_population),     pct(db.absence_rate_pct.of_population)],
  ['non-observation rate',             pct(da.nonobservation_rate_pct),            pct(db.nonobservation_rate_pct)],
];
console.log(`  ${pad('measure', 42)}${pad(ma.run_label, 26)}${mb.run_label}`);
for (const [k, x, y] of r2) console.log(`  ${pad(k, 42)}${pad(x, 26)}${y}`);

// ── 3. Recovered observations ───────────────────────────────────────────────
line();
console.log(' 3. RECOVERED OBSERVATIONS');
line();
const recovered = [], lost = [], stillUnknown = [];
for (const [d, a] of byDomA) {
  const b = byDomB.get(d);
  if (!b) continue;
  if (a.dns_caa_present === null && b.dns_caa_present !== null) recovered.push({ d, now: b });
  if (a.dns_caa_present !== null && b.dns_caa_present === null) lost.push({ d, was: a });
  if (a.dns_caa_present === null && b.dns_caa_present === null) stillUnknown.push({ d, err: b.caa_collection_error });
}
const recPresent = recovered.filter(r => r.now.dns_caa_present === true);
const recAbsent  = recovered.filter(r => r.now.dns_caa_present === false);
console.log(`  domains recovered from unknown        : ${recovered.length}`);
console.log(`    → resolved to PRESENT               : ${recPresent.length}`);
console.log(`    → resolved to ABSENT (confirmed)    : ${recAbsent.length}`);
console.log(`  domains newly unknown (regression)    : ${lost.length}`);
console.log(`  domains still unknown (residual floor): ${stillUnknown.length}`);
const sErr = {};
for (const s of stillUnknown) sErr[s.err] = (sErr[s.err] || 0) + 1;
console.log(`    residual by error                   : ${JSON.stringify(sErr)}`);
if (lost.length) for (const l of lost.slice(0, 20)) console.log(`    LOST: ${l.d} (was present=${l.was.dns_caa_present})`);

// ── 4. Recovered record inventory ───────────────────────────────────────────
line();
console.log(' 4. RECOVERED RECORD INVENTORY');
line();
console.log(`  total CAA records            : ${da.records.total}  →  ${db.records.total}   (+${db.records.total - da.records.total})`);
console.log(`  mean records / present domain: ${da.records.mean_per_present_domain}  →  ${db.records.mean_per_present_domain}`);
console.log(`  MAX records on any domain    : ${da.records.max_per_domain}  →  ${db.records.max_per_domain}`);
const ge = (h, n) => Object.entries(h).filter(([k]) => +k >= n).reduce((s, [, v]) => s + v, 0);
console.log(`  domains with >=12 records    : ${ge(da.records.histogram, 12)}  →  ${ge(db.records.histogram, 12)}`);
console.log(`  domains with >=16 records    : ${ge(da.records.histogram, 16)}  →  ${ge(db.records.histogram, 16)}`);
console.log(`  record-count histogram (${ma.run_label}): ${JSON.stringify(da.records.histogram)}`);
console.log(`  record-count histogram (${mb.run_label}): ${JSON.stringify(db.records.histogram)}`);

// ── 5. Recovered tag inventory ──────────────────────────────────────────────
line();
console.log(' 5. RECOVERED TAG INVENTORY');
line();
const tagsA = new Set(da.distinct_tags), tagsB = new Set(db.distinct_tags);
console.log(`  distinct tags ${ma.run_label}: ${[...tagsA].join(', ')}`);
console.log(`  distinct tags ${mb.run_label}: ${[...tagsB].join(', ')}`);
console.log(`  NEWLY OBSERVED tags          : ${[...tagsB].filter(t => !tagsA.has(t)).join(', ') || '(none)'}`);
console.log(`  tags lost                    : ${[...tagsA].filter(t => !tagsB.has(t)).join(', ') || '(none)'}`);
console.log(`\n  ${pad('tag', 18)}${pad(ma.run_label, 20)}${pad(mb.run_label, 20)}delta`);
for (const t of [...new Set([...tagsA, ...tagsB])].sort()) {
  const x = da.tag_counts[t] || 0, y = db.tag_counts[t] || 0;
  console.log(`  ${pad(t, 18)}${pad(x, 20)}${pad(y, 20)}${y - x >= 0 ? '+' : ''}${y - x}`);
}

// ── 6. Recovered issuer inventory ───────────────────────────────────────────
line();
console.log(' 6. RECOVERED ISSUER INVENTORY (issue tag)');
line();
const iA = da.issuers.issue, iB = db.issuers.issue;
console.log(`  distinct issue issuers: ${da.issuers.distinct_issue_issuers}  →  ${db.issuers.distinct_issue_issuers}`);
const newIssuers = Object.keys(iB).filter(k => !(k in iA));
console.log(`  newly observed in top-40: ${newIssuers.join(', ') || '(none)'}`);
console.log(`\n  ${pad('issuer-domain-name', 30)}${pad(ma.run_label, 18)}${pad(mb.run_label, 18)}delta`);
for (const k of Object.keys(iB).slice(0, 22)) {
  const x = iA[k] || 0, y = iB[k];
  console.log(`  ${pad(k, 30)}${pad(x, 18)}${pad(y, 18)}${y - x >= 0 ? '+' : ''}${y - x}`);
}

// ── 7. Protocol-relevant observables ────────────────────────────────────────
line();
console.log(' 7. PROTOCOL-RELEVANT OBSERVABLES');
line();
const r7 = [
  ['deny-all issue records',        da.deny_all.issue_records,     db.deny_all.issue_records],
  ['deny-all issuewild records',    da.deny_all.issuewild_records, db.deny_all.issuewild_records],
  ['empty-string value records',    da.empty_string_value_records, db.empty_string_value_records],
  ['parameter-bearing records',     da.parameter_bearing_records,  db.parameter_bearing_records],
  ['critical records',              da.critical.records,           db.critical.records],
  ['critical on unrecognised tag',  da.critical.on_unrecognised_tag, db.critical.on_unrecognised_tag],
  ['distinct flags values',         JSON.stringify(Object.keys(da.flags_observed)), JSON.stringify(Object.keys(db.flags_observed))],
];
console.log(`  ${pad('measure', 42)}${pad(ma.run_label, 26)}${mb.run_label}`);
for (const [k, x, y] of r7) console.log(`  ${pad(k, 42)}${pad(x, 26)}${y}`);

// ── 8. Bias check: is the missingness still size-selective? ─────────────────
line();
console.log(' 8. BIAS CHECK — is non-observation still correlated with response size?');
line();
console.log(`  ${ma.run_label}: max observed records ${da.records.max_per_domain}; ${ge(da.records.histogram, 12)} domains >=12`);
console.log(`  ${mb.run_label}: max observed records ${db.records.max_per_domain}; ${ge(db.records.histogram, 12)} domains >=12`);
console.log(`  residual unknowns: ${stillUnknown.length} — by error ${JSON.stringify(sErr)}`);
console.log(`  (a size-selective bias would keep the large-RRset domains unobserved)`);
line();
console.log('');
