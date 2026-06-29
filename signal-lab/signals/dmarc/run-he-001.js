'use strict';

// SOT-DMARC-001 — HE-001 University Cohort DMARC Collection Run
//
// Reads the HE-001 cohort from the data.ac.uk CSV,
// runs the DMARC collector against every domain,
// stores all observations in signal_facts_dmarc,
// and prints a full cohort analysis.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/dmarc/run-he-001.js
//
// Prerequisites:
//   Migration 008_signal_lab_dmarc.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectDmarc, SIGNAL_ID, SIGNAL_VERSION } = require('./dmarc-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 10;

// Known tag names from RFC 7489 — used to detect non-standard tags in raw records
const KNOWN_TAGS = new Set(['v', 'p', 'sp', 'rua', 'ruf', 'fo', 'pct', 'adkim', 'aspf', 'rf', 'ri']);

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — check backend/.env');
  }
  return createClient(url, key);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function loadCohort() {
  const raw     = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitCsvLine(lines[0]);

  const ukprnIdx    = headers.indexOf('UKPRN');
  const viewNameIdx = headers.indexOf('VIEW_NAME');
  const provNameIdx = headers.indexOf('PROVIDER_NAME');
  const urlIdx      = headers.indexOf('WEBSITE_URL');

  const institutions = [];
  const skipped      = [];

  for (const line of lines.slice(1)) {
    const f      = splitCsvLine(line);
    const rawUrl = f[urlIdx]?.trim();
    const name   = f[viewNameIdx]?.trim() || f[provNameIdx]?.trim() || '(unknown)';
    const ukprn  = f[ukprnIdx]?.trim() ?? '';

    if (!rawUrl) {
      skipped.push({ ukprn, name, reason: 'missing WEBSITE_URL' });
      continue;
    }
    let domain;
    try {
      domain = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      skipped.push({ ukprn, name, reason: `unparseable URL: ${rawUrl}` });
      continue;
    }
    if (!domain) {
      skipped.push({ ukprn, name, reason: `no hostname in URL: ${rawUrl}` });
      continue;
    }
    institutions.push({ ukprn, name, domain });
  }

  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Database storage ──────────────────────────────────────────────────────────

async function saveObservation(client, domain, facts, collectedAt) {
  const { error } = await client
    .from('signal_facts_dmarc')
    .insert({
      domain,
      signal_version:         SIGNAL_VERSION,
      collected_at:           collectedAt,
      dmarc_present:          facts.dmarc_present,
      dmarc_collection_error: facts.dmarc_collection_error,
      dmarc_records:          facts.dmarc_records,
      dmarc_record_count:     facts.dmarc_record_count,
      dmarc_multiple_records: facts.dmarc_multiple_records,
      dmarc_parse_success:    facts.dmarc_parse_success,
      dmarc_syntax_errors:    facts.dmarc_syntax_errors,
      dmarc_version:          facts.dmarc_version,
      dmarc_policy:           facts.dmarc_policy,
      dmarc_subdomain_policy: facts.dmarc_subdomain_policy,
      dmarc_adkim:            facts.dmarc_adkim,
      dmarc_aspf:             facts.dmarc_aspf,
      dmarc_pct:              facts.dmarc_pct,
      dmarc_rua:              facts.dmarc_rua,
      dmarc_ruf:              facts.dmarc_ruf,
      dmarc_rua_count:        facts.dmarc_rua_count,
      dmarc_ruf_count:        facts.dmarc_ruf_count,
      dmarc_fo:               facts.dmarc_fo,
      dmarc_ri:               facts.dmarc_ri,
      dmarc_rf:               facts.dmarc_rf,
    });
  return { error };
}

// ── Collection run ────────────────────────────────────────────────────────────

async function collect(institutions, client, collectedAt) {
  const total     = institutions.length;
  const startedAt = Date.now();
  let   completed = 0;

  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);
  console.log(`\n${hr}`);
  console.log(` Collecting — ${total} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${hr}\n`);
  console.log('  Legend:  Y present   N absent   ? DNS uncertain\n');

  const observations = await runWithConcurrency(institutions, async (inst) => {
    const facts  = await collectDmarc(inst.domain);
    const { error: dbErr } = await saveObservation(client, inst.domain, facts, collectedAt);
    completed++;

    const pctDone = String(Math.round((completed / total) * 100)).padStart(3);
    const symbol  = facts.dmarc_present === true  ? 'Y'
                  : facts.dmarc_present === false ? 'N'
                  : '?';
    const detail  = facts.dmarc_present === true
      ? `p=${facts.dmarc_policy ?? 'null'}  adkim=${facts.dmarc_adkim ?? 'null'}  aspf=${facts.dmarc_aspf ?? 'null'}`
      : facts.dmarc_present === false
      ? '(absent)'
      : `(${facts.dmarc_collection_error ?? 'unknown'})`;
    const dbNote  = dbErr ? ` [DB: ${dbErr.message}]` : '';

    console.log(`  [${pctDone}%] ${symbol}  ${inst.domain.padEnd(38)} ${detail}${dbNote}`);

    return { ...inst, facts, dbErr };
  }, CONCURRENCY);

  const elapsed  = ((Date.now() - startedAt) / 1000).toFixed(1);
  const dbErrors = observations.filter(o => o.dbErr).length;

  console.log(`\n  Completed: ${total} institutions in ${elapsed}s`);
  if (dbErrors > 0) console.log(`  WARNING: ${dbErrors} database write(s) failed`);

  return observations;
}

// ── Unknown tag detection ─────────────────────────────────────────────────────

function extractUnknownTags(rawRecord) {
  if (!rawRecord) return [];
  const parts    = rawRecord.split(';').map(p => p.trim()).filter(p => p);
  const unknown  = [];
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim().toLowerCase();
    if (!KNOWN_TAGS.has(name)) {
      unknown.push({ name, value: part.slice(eqIdx + 1).trim() });
    }
  }
  return unknown;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(observations) {
  const total    = observations.length;
  const present  = observations.filter(o => o.facts.dmarc_present === true);
  const absent   = observations.filter(o => o.facts.dmarc_present === false);
  const unknown  = observations.filter(o => o.facts.dmarc_present === null);

  // 1. Presence distribution
  const presence = { present: present.length, absent: absent.length, unknown: unknown.length };

  // 2. Collection error distribution (only when dmarc_present = null)
  const collErrors = { DNS_TIMEOUT: 0, DNS_SERVFAIL: 0, DNS_FAILURE: 0 };
  for (const o of unknown) {
    const code = o.facts.dmarc_collection_error;
    if (code && collErrors[code] !== undefined) collErrors[code]++;
  }

  // 3. Policy distribution (present domains only)
  const policyDist = { none: 0, quarantine: 0, reject: 0, null: 0, other: 0 };
  const otherPolicies = {};
  for (const o of present) {
    const p = o.facts.dmarc_policy;
    if      (p === null)          policyDist.null++;
    else if (p === 'none')        policyDist.none++;
    else if (p === 'quarantine')  policyDist.quarantine++;
    else if (p === 'reject')      policyDist.reject++;
    else {
      policyDist.other++;
      otherPolicies[p] = (otherPolicies[p] ?? 0) + 1;
    }
  }

  // 4. Subdomain policy distribution (present domains only)
  const spDist = { none: 0, quarantine: 0, reject: 0, null: 0 };
  for (const o of present) {
    const sp = o.facts.dmarc_subdomain_policy;
    if      (sp === null)         spDist.null++;
    else if (sp === 'none')       spDist.none++;
    else if (sp === 'quarantine') spDist.quarantine++;
    else if (sp === 'reject')     spDist.reject++;
  }

  // 5. DKIM alignment distribution (present domains only)
  const adkimDist = { r: 0, s: 0, null: 0 };
  for (const o of present) {
    const a = o.facts.dmarc_adkim;
    if      (a === null) adkimDist.null++;
    else if (a === 'r')  adkimDist.r++;
    else if (a === 's')  adkimDist.s++;
  }

  // 6. SPF alignment distribution (present domains only)
  const aspfDist = { r: 0, s: 0, null: 0 };
  for (const o of present) {
    const a = o.facts.dmarc_aspf;
    if      (a === null) aspfDist.null++;
    else if (a === 'r')  aspfDist.r++;
    else if (a === 's')  aspfDist.s++;
  }

  // 7. Percentage distribution
  const pctDist = { null: 0, 100: 0, 50: 0, 25: 0, other: 0 };
  const otherPcts = {};
  for (const o of present) {
    const p = o.facts.dmarc_pct;
    if      (p === null) pctDist.null++;
    else if (p === 100)  pctDist[100]++;
    else if (p === 50)   pctDist[50]++;
    else if (p === 25)   pctDist[25]++;
    else {
      pctDist.other++;
      otherPcts[String(p)] = (otherPcts[String(p)] ?? 0) + 1;
    }
  }

  // 8. Aggregate reporting (rua) distribution
  const ruaDist = { zero: 0, one: 0, many: 0 };
  for (const o of present) {
    const c = o.facts.dmarc_rua_count;
    if      (c === 0) ruaDist.zero++;
    else if (c === 1) ruaDist.one++;
    else              ruaDist.many++;
  }

  // 9. Forensic reporting (ruf) distribution
  const rufDist = { zero: 0, one: 0, many: 0 };
  for (const o of present) {
    const c = o.facts.dmarc_ruf_count;
    if      (c === 0) rufDist.zero++;
    else if (c === 1) rufDist.one++;
    else              rufDist.many++;
  }

  // 10. Reporting interval (ri) distribution
  const riDist = { null: 0, 86400: 0, other: 0 };
  const otherRi = {};
  for (const o of present) {
    const ri = o.facts.dmarc_ri;
    if      (ri === null)  riDist.null++;
    else if (ri === 86400) riDist[86400]++;
    else {
      riDist.other++;
      otherRi[String(ri)] = (otherRi[String(ri)] ?? 0) + 1;
    }
  }

  // 11. Multiple record analysis
  const multipleRecords = present.filter(o => o.facts.dmarc_multiple_records === true);

  // 12. Syntax error distribution
  const syntaxErrors = {};
  for (const o of present) {
    for (const err of (o.facts.dmarc_syntax_errors ?? [])) {
      syntaxErrors[err.code] = (syntaxErrors[err.code] ?? 0) + 1;
    }
  }

  // Domains with syntax errors
  const withSyntaxErrors = present.filter(o => o.facts.dmarc_syntax_errors?.length > 0);

  // Unknown tag detection across all present domains
  const unknownTagDomains = [];
  for (const o of present) {
    const rawRecord = o.facts.dmarc_records[0];
    const unknownTags = extractUnknownTags(rawRecord);
    if (unknownTags.length > 0) {
      unknownTagDomains.push({ domain: o.domain, rawRecord, unknownTags });
    }
  }

  return {
    total, present, absent, unknown,
    presence, collErrors,
    policyDist, otherPolicies,
    spDist,
    adkimDist, aspfDist,
    pctDist, otherPcts,
    ruaDist, rufDist,
    riDist, otherRi,
    multipleRecords,
    syntaxErrors, withSyntaxErrors,
    unknownTagDomains,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function p(n, of) {
  if (of === 0) return '  0.0%';
  return `${((n / of) * 100).toFixed(1).padStart(5)}%`;
}

function row(label, count, of, width = 40) {
  return `    ${label.padEnd(width)} : ${String(count).padStart(4)}  ${p(count, of)}`;
}

// ── Summary output ────────────────────────────────────────────────────────────

function printSummary(s, collectedAt, skipped = []) {
  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);

  console.log('\n' + hr);
  console.log(` SOT-DMARC-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${s.total}`);
  console.log(` Collected: ${collectedAt}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain`);
    for (const sk of skipped) {
      console.log(`   UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
    }
  }
  console.log(hr);

  // ── 1. Presence distribution ──────────────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 1. PRESENCE DISTRIBUTION\n');
  console.log(row('dmarc_present = true',  s.presence.present, s.total));
  console.log(row('dmarc_present = false', s.presence.absent,  s.total));
  console.log(row('dmarc_present = null',  s.presence.unknown, s.total));

  // ── 2. Collection error distribution ─────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 2. COLLECTION ERROR DISTRIBUTION  (when dmarc_present = null)\n');
  const unknownTotal = s.presence.unknown;
  if (unknownTotal === 0) {
    console.log('    (no DNS errors — all domains resolved)');
  } else {
    console.log(row('DNS_TIMEOUT',  s.collErrors.DNS_TIMEOUT,  unknownTotal));
    console.log(row('DNS_SERVFAIL', s.collErrors.DNS_SERVFAIL, unknownTotal));
    console.log(row('DNS_FAILURE',  s.collErrors.DNS_FAILURE,  unknownTotal));
  }

  // ── 3. Policy distribution ────────────────────────────────────────────────

  const presentTotal = s.presence.present;
  console.log('\n' + div);
  console.log(`\n 3. DMARC POLICY DISTRIBUTION  (${presentTotal} domains with dmarc_present = true)\n`);
  console.log(row('p = none',       s.policyDist.none,       presentTotal));
  console.log(row('p = quarantine', s.policyDist.quarantine,  presentTotal));
  console.log(row('p = reject',     s.policyDist.reject,      presentTotal));
  if (s.policyDist.null > 0) {
    console.log(row('p = null  (MISSING_POLICY)', s.policyDist.null, presentTotal));
  }
  if (s.policyDist.other > 0) {
    console.log(row('p = (unexpected value)',       s.policyDist.other, presentTotal));
    for (const [val, count] of Object.entries(s.otherPolicies)) {
      console.log(`      "${val}" : ${count}`);
    }
  }

  // ── 4. Subdomain policy distribution ─────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 4. SUBDOMAIN POLICY DISTRIBUTION  (sp= tag; null = absent)\n');
  console.log(row('sp = null  (absent)',       s.spDist.null,       presentTotal));
  console.log(row('sp = none',                 s.spDist.none,       presentTotal));
  console.log(row('sp = quarantine',           s.spDist.quarantine, presentTotal));
  console.log(row('sp = reject',               s.spDist.reject,     presentTotal));

  // ── 5. DKIM alignment distribution ───────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 5. DKIM ALIGNMENT DISTRIBUTION  (adkim= tag; null = absent)\n');
  console.log(row('adkim = null  (absent)',    s.adkimDist.null, presentTotal));
  console.log(row('adkim = r  (relaxed)',      s.adkimDist.r,    presentTotal));
  console.log(row('adkim = s  (strict)',       s.adkimDist.s,    presentTotal));

  // ── 6. SPF alignment distribution ────────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 6. SPF ALIGNMENT DISTRIBUTION  (aspf= tag; null = absent)\n');
  console.log(row('aspf = null  (absent)',     s.aspfDist.null, presentTotal));
  console.log(row('aspf = r  (relaxed)',       s.aspfDist.r,    presentTotal));
  console.log(row('aspf = s  (strict)',        s.aspfDist.s,    presentTotal));

  // ── 7. Percentage distribution ────────────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 7. PERCENTAGE DISTRIBUTION  (pct= tag; null = absent)\n');
  console.log(row('pct = null  (absent)',      s.pctDist.null,  presentTotal));
  console.log(row('pct = 100',                 s.pctDist[100],  presentTotal));
  console.log(row('pct = 50',                  s.pctDist[50],   presentTotal));
  console.log(row('pct = 25',                  s.pctDist[25],   presentTotal));
  if (s.pctDist.other > 0) {
    console.log(row('pct = (other)',            s.pctDist.other, presentTotal));
    for (const [val, count] of Object.entries(s.otherPcts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`      pct=${val} : ${count}`);
    }
  }

  // ── 8. Aggregate reporting distribution ──────────────────────────────────

  console.log('\n' + div);
  console.log('\n 8. AGGREGATE REPORTING DISTRIBUTION  (rua= tag; rua_count)\n');
  console.log(row('rua_count = 0  (no rua)',   s.ruaDist.zero, presentTotal));
  console.log(row('rua_count = 1',             s.ruaDist.one,  presentTotal));
  console.log(row('rua_count > 1',             s.ruaDist.many, presentTotal));

  // ── 9. Forensic reporting distribution ───────────────────────────────────

  console.log('\n' + div);
  console.log('\n 9. FORENSIC REPORTING DISTRIBUTION  (ruf= tag; ruf_count)\n');
  console.log(row('ruf_count = 0  (no ruf)',   s.rufDist.zero, presentTotal));
  console.log(row('ruf_count = 1',             s.rufDist.one,  presentTotal));
  console.log(row('ruf_count > 1',             s.rufDist.many, presentTotal));

  // ── 10. Reporting interval distribution ──────────────────────────────────

  console.log('\n' + div);
  console.log('\n 10. REPORTING INTERVAL DISTRIBUTION  (ri= tag; null = absent)\n');
  console.log(row('ri = null  (absent)',        s.riDist.null,  presentTotal));
  console.log(row('ri = 86400  (24 hrs)',       s.riDist[86400], presentTotal));
  if (s.riDist.other > 0) {
    console.log(row('ri = (other)',             s.riDist.other,  presentTotal));
    for (const [val, count] of Object.entries(s.otherRi).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`      ri=${val} : ${count}`);
    }
  }

  // ── 11. Multiple record analysis ──────────────────────────────────────────

  console.log('\n' + div);
  console.log(`\n 11. MULTIPLE RECORD ANALYSIS  (dmarc_multiple_records = true)\n`);
  if (s.multipleRecords.length === 0) {
    console.log('    (none — all domains returned at most one v=DMARC1 record)');
  } else {
    console.log(`    ${s.multipleRecords.length} domain(s) returned multiple DMARC records:\n`);
    for (const o of s.multipleRecords) {
      console.log(`    * ${o.domain}  (${o.facts.dmarc_record_count} records)`);
      for (let i = 0; i < o.facts.dmarc_records.length; i++) {
        const rec = o.facts.dmarc_records[i];
        console.log(`      [${i}] ${rec.length > 80 ? rec.slice(0, 77) + '...' : rec}`);
      }
    }
  }

  // ── 12. Syntax error distribution ────────────────────────────────────────

  console.log('\n' + div);
  console.log('\n 12. SYNTAX ERROR DISTRIBUTION  (across all dmarc_present = true domains)\n');
  const errEntries = Object.entries(s.syntaxErrors).sort((a, b) => b[1] - a[1]);
  if (errEntries.length === 0) {
    console.log('    (no syntax errors detected)');
  } else {
    for (const [code, count] of errEntries) {
      console.log(`    ${code.padEnd(34)} : ${String(count).padStart(4)}`);
    }
    console.log(`\n    Domains with one or more syntax errors: ${s.withSyntaxErrors.length} of ${presentTotal}`);
  }

  console.log('\n' + hr + '\n');
}

// ── Evidence review ───────────────────────────────────────────────────────────

function printEvidenceReview(s) {
  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);

  console.log('\n' + hr);
  console.log(' EVIDENCE REVIEW');
  console.log(hr);

  // ── Policy examples ───────────────────────────────────────────────────────

  function examplesForPolicy(policy) {
    return s.present.filter(o => o.facts.dmarc_policy === policy).slice(0, 2);
  }

  for (const policy of ['none', 'quarantine', 'reject']) {
    const examples = examplesForPolicy(policy);
    if (examples.length === 0) continue;

    console.log(`\n ${div}`);
    console.log(` p = ${policy}  (${examples.length > 1 ? 'up to 2 examples' : '1 example'})`);
    console.log(` ${div}`);

    for (const o of examples) {
      const f   = o.facts;
      const raw = f.dmarc_records[0] ?? '(none)';
      console.log(`\n  Domain          : ${o.domain}`);
      console.log(`  Raw record      : ${raw.length > 100 ? raw.slice(0, 97) + '...' : raw}`);
      console.log(`  dmarc_policy    : ${f.dmarc_policy}`);
      console.log(`  dmarc_sp        : ${f.dmarc_subdomain_policy ?? 'null'}`);
      console.log(`  dmarc_adkim     : ${f.dmarc_adkim ?? 'null'}`);
      console.log(`  dmarc_aspf      : ${f.dmarc_aspf ?? 'null'}`);
      console.log(`  dmarc_pct       : ${f.dmarc_pct ?? 'null'}`);
      console.log(`  dmarc_rua       : ${f.dmarc_rua ? f.dmarc_rua.slice(0, 60) + (f.dmarc_rua.length > 60 ? '...' : '') : 'null'}`);
      console.log(`  dmarc_ruf       : ${f.dmarc_ruf ?? 'null'}`);
      console.log(`  dmarc_fo        : ${f.dmarc_fo ?? 'null'}`);
      console.log(`  dmarc_ri        : ${f.dmarc_ri ?? 'null'}`);
      console.log(`  parse_success   : ${f.dmarc_parse_success}`);
      if (f.dmarc_syntax_errors.length > 0) {
        console.log(`  syntax_errors   : ${f.dmarc_syntax_errors.map(e => e.code).join(', ')}`);
      }
    }
  }

  // ── Multiple records ──────────────────────────────────────────────────────

  if (s.multipleRecords.length > 0) {
    console.log(`\n ${div}`);
    console.log(' MULTIPLE DMARC RECORDS  (evidence preservation examples)');
    console.log(` ${div}`);
    for (const o of s.multipleRecords.slice(0, 3)) {
      console.log(`\n  Domain            : ${o.domain}`);
      console.log(`  dmarc_record_count: ${o.facts.dmarc_record_count}`);
      for (let i = 0; i < o.facts.dmarc_records.length; i++) {
        const rec = o.facts.dmarc_records[i];
        console.log(`  dmarc_records[${i}]  : ${rec.length > 80 ? rec.slice(0, 77) + '...' : rec}`);
      }
      console.log(`  Parsed from [0]   : p=${o.facts.dmarc_policy ?? 'null'}`);
      const multiErr = o.facts.dmarc_syntax_errors.find(e => e.code === 'MULTIPLE_RECORDS');
      if (multiErr) console.log(`  MULTIPLE_RECORDS  : ${multiErr.message.slice(0, 80)}`);
    }
  }

  // ── Syntax error examples ─────────────────────────────────────────────────

  if (s.withSyntaxErrors.length > 0) {
    console.log(`\n ${div}`);
    console.log(` SYNTAX ERROR EXAMPLES  (up to 5)`);
    console.log(` ${div}`);
    for (const o of s.withSyntaxErrors.slice(0, 5)) {
      const f   = o.facts;
      const raw = f.dmarc_records[0] ?? '(none)';
      console.log(`\n  Domain          : ${o.domain}`);
      console.log(`  Raw record      : ${raw.length > 100 ? raw.slice(0, 97) + '...' : raw}`);
      for (const err of f.dmarc_syntax_errors) {
        console.log(`  [${err.code}]`);
        console.log(`    ${err.message}`);
      }
    }
  }

  // ── Unknown tags ──────────────────────────────────────────────────────────

  if (s.unknownTagDomains.length > 0) {
    console.log(`\n ${div}`);
    console.log(` NON-RFC-7489 TAGS OBSERVED  (${s.unknownTagDomains.length} domain(s))`);
    console.log(` ${div}`);

    // Aggregate unique unknown tag names
    const tagFreq = {};
    for (const { unknownTags } of s.unknownTagDomains) {
      for (const { name } of unknownTags) {
        tagFreq[name] = (tagFreq[name] ?? 0) + 1;
      }
    }
    console.log('\n  Unknown tag frequencies:');
    for (const [name, count] of Object.entries(tagFreq).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${name.padEnd(20)} : ${count}`);
    }
    console.log('\n  Domain examples (up to 5):');
    for (const { domain, rawRecord, unknownTags } of s.unknownTagDomains.slice(0, 5)) {
      const tags = unknownTags.map(t => `${t.name}=${t.value}`).join('  ');
      console.log(`    ${domain.padEnd(36)} ${tags}`);
      if (rawRecord) {
        console.log(`      Raw: ${rawRecord.length > 80 ? rawRecord.slice(0, 77) + '...' : rawRecord}`);
      }
    }
  } else {
    console.log(`\n ${div}`);
    console.log(' NON-RFC-7489 TAGS: none observed');
  }

  console.log('\n' + hr + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();

  const hr = '═'.repeat(72);
  console.log('\n' + hr);
  console.log(' SOT-DMARC-001 — HE-001 University Cohort DMARC Collection');
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${collectedAt}`);
  console.log(hr);

  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded from CSV`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s):`);
    for (const sk of skipped) {
      console.log(`    • UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
    }
  }

  const client = getClient();
  const { error: pingErr } = await client.from('signal_facts_dmarc').select('id').limit(1);
  if (pingErr) {
    const tableGone = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    if (tableGone) {
      console.error('\n  ERROR: signal_facts_dmarc table not found.');
      console.error('  Apply backend/db/migrations/008_signal_lab_dmarc.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_facts_dmarc ready\n');

  const observations = await collect(institutions, client, collectedAt);
  const summary      = computeSummary(observations);

  printSummary(summary, collectedAt, skipped);
  printEvidenceReview(summary);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
