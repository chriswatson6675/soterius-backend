'use strict';

// SOT-MTASTS-001 — HE-001 University Cohort MTA-STS Collection Run
//
// Reads the HE-001 cohort from the data.ac.uk CSV,
// runs the MTA-STS collector against every domain,
// stores all observations in signal_facts_mtasts,
// and prints a full cohort analysis.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/mtasts/run-he-001.js
//
// Prerequisites:
//   Migration 009_signal_lab_mtasts.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectMtaSts, SIGNAL_ID, SIGNAL_VERSION } = require('./mtasts-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 5;   // lower than DNS-only signals; HTTPS fetches are slower

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
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

    if (!rawUrl) { skipped.push({ ukprn, name, reason: 'missing WEBSITE_URL' }); continue; }
    let domain;
    try {
      domain = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      skipped.push({ ukprn, name, reason: `unparseable URL: ${rawUrl}` });
      continue;
    }
    if (!domain) { skipped.push({ ukprn, name, reason: `no hostname in URL: ${rawUrl}` }); continue; }
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
    .from('signal_facts_mtasts')
    .insert({
      domain,
      signal_version:            SIGNAL_VERSION,
      collected_at:              collectedAt,

      dns_sts_present:           facts.dns_sts_present,
      dns_collection_error:      facts.dns_collection_error,
      dns_records:               facts.dns_records,
      dns_record_count:          facts.dns_record_count,
      dns_sts_record_count:      facts.dns_sts_record_count,
      dns_multiple_sts_records:  facts.dns_multiple_sts_records,
      dns_parse_success:         facts.dns_parse_success,
      dns_syntax_errors:         facts.dns_syntax_errors,
      dns_version:               facts.dns_version,
      dns_id:                    facts.dns_id,
      dns_unknown_tags:          facts.dns_unknown_tags,

      policy_fetch_attempted:    facts.policy_fetch_attempted,
      policy_present:            facts.policy_present,
      policy_fetch_error:        facts.policy_fetch_error,
      policy_http_status:        facts.policy_http_status,
      policy_tls_valid:          facts.policy_tls_valid,
      policy_tls_error:          facts.policy_tls_error,
      policy_redirect_count:     facts.policy_redirect_count,
      policy_content_type:       facts.policy_content_type,
      policy_body_raw:           facts.policy_body_raw,
      policy_body_tls_validated: facts.policy_body_tls_validated,
      policy_parse_success:      facts.policy_parse_success,
      policy_syntax_errors:      facts.policy_syntax_errors,
      policy_version:            facts.policy_version,
      policy_mode:               facts.policy_mode,
      policy_max_age:            facts.policy_max_age,
      policy_mx_patterns:        facts.policy_mx_patterns,
      policy_mx_count:           facts.policy_mx_count,
      policy_unknown_fields:     facts.policy_unknown_fields,
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
  console.log('  Legend:  Y dns-present   N dns-absent   ? dns-unknown\n');

  const observations = await runWithConcurrency(institutions, async (inst) => {
    const facts  = await collectMtaSts(inst.domain);
    const { error: dbErr } = await saveObservation(client, inst.domain, facts, collectedAt);
    completed++;

    const pctDone = String(Math.round((completed / total) * 100)).padStart(3);

    const dnsSymbol = facts.dns_sts_present === true  ? 'Y'
                    : facts.dns_sts_present === false ? 'N'
                    : '?';

    let detail;
    if (facts.dns_sts_present === true) {
      const policyState = facts.policy_present === true  ? `policy=${facts.policy_mode ?? 'null'}`
                        : facts.policy_present === false ? 'policy=absent'
                        : `policy=?(${facts.policy_fetch_error ?? facts.policy_tls_error ?? 'err'})`;
      const tlsNote = facts.policy_tls_valid === false ? ` tls=${facts.policy_tls_error}` : '';
      detail = `id=${facts.dns_id ?? 'null'}  ${policyState}${tlsNote}`;
    } else if (facts.dns_sts_present === false) {
      detail = '(absent)';
    } else {
      detail = `(${facts.dns_collection_error ?? 'unknown'})`;
    }

    const dbNote = dbErr ? ` [DB: ${dbErr.message}]` : '';
    console.log(`  [${pctDone}%] ${dnsSymbol}  ${inst.domain.padEnd(38)} ${detail}${dbNote}`);

    return { ...inst, facts, dbErr };
  }, CONCURRENCY);

  const elapsed  = ((Date.now() - startedAt) / 1000).toFixed(1);
  const dbErrors = observations.filter(o => o.dbErr).length;

  console.log(`\n  Completed: ${total} institutions in ${elapsed}s`);
  if (dbErrors > 0) console.log(`  WARNING: ${dbErrors} database write(s) failed`);

  return observations;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(observations) {
  const total   = observations.length;
  const present = observations.filter(o => o.facts.dns_sts_present === true);
  const absent  = observations.filter(o => o.facts.dns_sts_present === false);
  const unknown = observations.filter(o => o.facts.dns_sts_present === null);

  // 1. DNS presence distribution
  const dnsPresence = { present: present.length, absent: absent.length, unknown: unknown.length };

  // 2. DNS collection error distribution
  const dnsErrors = { DNS_TIMEOUT: 0, DNS_SERVFAIL: 0, DNS_FAILURE: 0 };
  for (const o of unknown) {
    const code = o.facts.dns_collection_error;
    if (code && dnsErrors[code] !== undefined) dnsErrors[code]++;
  }

  // 3. Policy presence distribution (dns_sts_present = true domains)
  const policyPresence = { present: 0, absent: 0, unknown: 0 };
  for (const o of present) {
    if      (o.facts.policy_present === true)  policyPresence.present++;
    else if (o.facts.policy_present === false) policyPresence.absent++;
    else                                        policyPresence.unknown++;
  }

  // 4. TLS distribution (policy_present = true only)
  const withPolicy = present.filter(o => o.facts.policy_present === true);
  const tlsDist    = { valid: 0, invalid: 0, unknown: 0 };
  for (const o of withPolicy) {
    if      (o.facts.policy_tls_valid === true)  tlsDist.valid++;
    else if (o.facts.policy_tls_valid === false) tlsDist.invalid++;
    else                                          tlsDist.unknown++;
  }

  // 5. TLS error distribution (invalid certs)
  const tlsErrors = { CERT_EXPIRED: 0, CERT_HOSTNAME_MISMATCH: 0, CERT_UNTRUSTED: 0, CERT_SELF_SIGNED: 0, TLS_HANDSHAKE_FAILURE: 0 };
  for (const o of withPolicy) {
    const e = o.facts.policy_tls_error;
    if (e && tlsErrors[e] !== undefined) tlsErrors[e]++;
  }

  // 6. Policy mode distribution (policy_present = true)
  const modeDist = { enforce: 0, testing: 0, none: 0, null: 0, other: 0 };
  const otherModes = {};
  for (const o of withPolicy) {
    const m = o.facts.policy_mode;
    if      (m === null)       modeDist.null++;
    else if (m === 'enforce')  modeDist.enforce++;
    else if (m === 'testing')  modeDist.testing++;
    else if (m === 'none')     modeDist.none++;
    else {
      modeDist.other++;
      otherModes[m] = (otherModes[m] ?? 0) + 1;
    }
  }

  // 7. Policy fetch error distribution (policy_present = null, dns_sts_present = true)
  const policyFetchErrors = { CONNECTION_TIMEOUT: 0, CONNECTION_REFUSED: 0, DNS_ERROR: 0 };
  for (const o of present.filter(o => o.facts.policy_present === null)) {
    const e = o.facts.policy_fetch_error;
    if (e && policyFetchErrors[e] !== undefined) policyFetchErrors[e]++;
  }

  // 8. max_age distribution (policy_present = true)
  const maxAgeDist = { null: 0, zero: 0, day: 0, week: 0, month: 0, other: 0 };
  for (const o of withPolicy) {
    const ma = o.facts.policy_max_age;
    if      (ma === null)    maxAgeDist.null++;
    else if (ma === 0)       maxAgeDist.zero++;
    else if (ma <= 86400)    maxAgeDist.day++;
    else if (ma <= 604800)   maxAgeDist.week++;
    else if (ma <= 2592000)  maxAgeDist.month++;
    else                     maxAgeDist.other++;
  }

  // 9. mx_count distribution
  const mxCountDist = { zero: 0, one: 0, two: 0, more: 0 };
  for (const o of withPolicy) {
    const c = o.facts.policy_mx_count;
    if      (c === 0) mxCountDist.zero++;
    else if (c === 1) mxCountDist.one++;
    else if (c === 2) mxCountDist.two++;
    else              mxCountDist.more++;
  }

  // 10. policy_body_tls_validated distribution
  const bodyProvenance = { validated: 0, non_validated: 0 };
  for (const o of withPolicy) {
    if      (o.facts.policy_body_tls_validated === true)  bodyProvenance.validated++;
    else if (o.facts.policy_body_tls_validated === false) bodyProvenance.non_validated++;
  }

  // 11. Syntax error distribution (DNS + policy)
  const dnsSyntaxErrors    = {};
  const policySyntaxErrors = {};
  for (const o of present) {
    for (const e of (o.facts.dns_syntax_errors ?? [])) {
      dnsSyntaxErrors[e.code] = (dnsSyntaxErrors[e.code] ?? 0) + 1;
    }
  }
  for (const o of withPolicy) {
    for (const e of (o.facts.policy_syntax_errors ?? [])) {
      policySyntaxErrors[e.code] = (policySyntaxErrors[e.code] ?? 0) + 1;
    }
  }

  // 12. Multiple DNS records
  const multipleDnsRecords = present.filter(o => o.facts.dns_multiple_sts_records === true);

  // 13. Unknown DNS tags
  const withUnknownDnsTags = present.filter(o => Object.keys(o.facts.dns_unknown_tags ?? {}).length > 0);

  // 14. Unknown policy fields
  const withUnknownPolicyFields = withPolicy.filter(o => Object.keys(o.facts.policy_unknown_fields ?? {}).length > 0);

  return {
    total, present, absent, unknown, withPolicy,
    dnsPresence, dnsErrors,
    policyPresence,
    tlsDist, tlsErrors,
    modeDist, otherModes,
    policyFetchErrors,
    maxAgeDist,
    mxCountDist,
    bodyProvenance,
    dnsSyntaxErrors, policySyntaxErrors,
    multipleDnsRecords,
    withUnknownDnsTags,
    withUnknownPolicyFields,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function p(n, of) {
  if (of === 0) return '  0.0%';
  return `${((n / of) * 100).toFixed(1).padStart(5)}%`;
}

function row(label, count, of, width = 42) {
  return `    ${label.padEnd(width)} : ${String(count).padStart(4)}  ${p(count, of)}`;
}

// ── Summary output ────────────────────────────────────────────────────────────

function printSummary(s, collectedAt, skipped = []) {
  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);

  console.log('\n' + hr);
  console.log(` SOT-MTASTS-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${s.total}`);
  console.log(` Collected: ${collectedAt}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain`);
  }
  console.log(hr);

  // 1. DNS presence distribution
  console.log('\n' + div);
  console.log('\n 1. DNS PRESENCE DISTRIBUTION\n');
  console.log(row('dns_sts_present = true',  s.dnsPresence.present, s.total));
  console.log(row('dns_sts_present = false', s.dnsPresence.absent,  s.total));
  console.log(row('dns_sts_present = null',  s.dnsPresence.unknown, s.total));

  // 2. DNS collection errors
  if (s.dnsPresence.unknown > 0) {
    console.log('\n' + div);
    console.log('\n 2. DNS COLLECTION ERROR DISTRIBUTION  (when dns_sts_present = null)\n');
    const unknownTotal = s.dnsPresence.unknown;
    console.log(row('DNS_TIMEOUT',  s.dnsErrors.DNS_TIMEOUT,  unknownTotal));
    console.log(row('DNS_SERVFAIL', s.dnsErrors.DNS_SERVFAIL, unknownTotal));
    console.log(row('DNS_FAILURE',  s.dnsErrors.DNS_FAILURE,  unknownTotal));
  }

  // 3. Policy presence distribution (DNS-present domains only)
  const dnsPresent = s.dnsPresence.present;
  console.log('\n' + div);
  console.log(`\n 3. POLICY PRESENCE DISTRIBUTION  (${dnsPresent} domains with dns_sts_present = true)\n`);
  console.log(row('policy_present = true',  s.policyPresence.present, dnsPresent));
  console.log(row('policy_present = false', s.policyPresence.absent,  dnsPresent));
  console.log(row('policy_present = null',  s.policyPresence.unknown, dnsPresent));

  // 4. TLS distribution
  const withPolicyTotal = s.withPolicy.length;
  console.log('\n' + div);
  console.log(`\n 4. TLS DISTRIBUTION  (${withPolicyTotal} domains with policy_present = true)\n`);
  console.log(row('policy_tls_valid = true',    s.tlsDist.valid,   withPolicyTotal));
  console.log(row('policy_tls_valid = false',   s.tlsDist.invalid, withPolicyTotal));
  console.log(row('policy_tls_valid = null',    s.tlsDist.unknown, withPolicyTotal));

  if (s.tlsDist.invalid > 0) {
    console.log('\n    TLS error breakdown:');
    for (const [code, count] of Object.entries(s.tlsErrors).filter(([, c]) => c > 0)) {
      console.log(`      ${code.padEnd(30)} : ${count}`);
    }
    const pass2Total = s.bodyProvenance.non_validated;
    if (pass2Total > 0) {
      console.log(`\n    Bodies retrieved via Pass 2 (non-validating): ${pass2Total}`);
    }
  }

  // 5. Policy mode distribution
  console.log('\n' + div);
  console.log(`\n 5. POLICY MODE DISTRIBUTION  (${withPolicyTotal} domains with policy_present = true)\n`);
  console.log(row('mode = enforce',        s.modeDist.enforce, withPolicyTotal));
  console.log(row('mode = testing',        s.modeDist.testing, withPolicyTotal));
  console.log(row('mode = none',           s.modeDist.none,    withPolicyTotal));
  if (s.modeDist.null > 0) {
    console.log(row('mode = null  (MISSING_MODE)', s.modeDist.null, withPolicyTotal));
  }
  if (s.modeDist.other > 0) {
    console.log(row('mode = (unexpected)', s.modeDist.other, withPolicyTotal));
    for (const [val, count] of Object.entries(s.otherModes)) {
      console.log(`      "${val}" : ${count}`);
    }
  }

  // 6. max_age distribution
  console.log('\n' + div);
  console.log(`\n 6. MAX_AGE DISTRIBUTION  (${withPolicyTotal} domains with policy_present = true)\n`);
  console.log(row('max_age = null  (absent)',    s.maxAgeDist.null,   withPolicyTotal));
  console.log(row('max_age = 0',                s.maxAgeDist.zero,  withPolicyTotal));
  console.log(row('max_age <= 86400  (1 day)',   s.maxAgeDist.day,   withPolicyTotal));
  console.log(row('max_age <= 604800  (1 week)', s.maxAgeDist.week,  withPolicyTotal));
  console.log(row('max_age <= 2592000  (1 mo)',  s.maxAgeDist.month, withPolicyTotal));
  console.log(row('max_age > 2592000',           s.maxAgeDist.other, withPolicyTotal));

  // 7. MX pattern count distribution
  console.log('\n' + div);
  console.log(`\n 7. MX PATTERN COUNT  (${withPolicyTotal} domains with policy_present = true)\n`);
  console.log(row('mx_count = 0',  s.mxCountDist.zero, withPolicyTotal));
  console.log(row('mx_count = 1',  s.mxCountDist.one,  withPolicyTotal));
  console.log(row('mx_count = 2',  s.mxCountDist.two,  withPolicyTotal));
  console.log(row('mx_count > 2',  s.mxCountDist.more, withPolicyTotal));

  // 8. Policy fetch error distribution
  if (s.policyPresence.unknown > 0) {
    console.log('\n' + div);
    console.log('\n 8. POLICY FETCH ERROR DISTRIBUTION  (when policy_present = null)\n');
    const unknownPolicy = s.policyPresence.unknown;
    console.log(row('CONNECTION_TIMEOUT',  s.policyFetchErrors.CONNECTION_TIMEOUT,  unknownPolicy));
    console.log(row('CONNECTION_REFUSED',  s.policyFetchErrors.CONNECTION_REFUSED,  unknownPolicy));
    console.log(row('DNS_ERROR',           s.policyFetchErrors.DNS_ERROR,           unknownPolicy));
  }

  // 9. DNS syntax errors
  const dnsSyntaxEntries = Object.entries(s.dnsSyntaxErrors).sort((a, b) => b[1] - a[1]);
  console.log('\n' + div);
  console.log('\n 9. DNS SYNTAX ERROR DISTRIBUTION\n');
  if (dnsSyntaxEntries.length === 0) {
    console.log('    (no DNS syntax errors)');
  } else {
    for (const [code, count] of dnsSyntaxEntries) {
      console.log(`    ${code.padEnd(36)} : ${String(count).padStart(4)}`);
    }
  }

  // 10. Policy syntax errors
  const policySyntaxEntries = Object.entries(s.policySyntaxErrors).sort((a, b) => b[1] - a[1]);
  console.log('\n' + div);
  console.log('\n 10. POLICY SYNTAX ERROR DISTRIBUTION\n');
  if (policySyntaxEntries.length === 0) {
    console.log('    (no policy syntax errors)');
  } else {
    for (const [code, count] of policySyntaxEntries) {
      console.log(`    ${code.padEnd(36)} : ${String(count).padStart(4)}`);
    }
  }

  // 11. Multiple DNS records
  console.log('\n' + div);
  console.log(`\n 11. MULTIPLE DNS RECORD ANALYSIS  (dns_multiple_sts_records = true)\n`);
  if (s.multipleDnsRecords.length === 0) {
    console.log('    (none — all domains returned at most one v=STSv1 record)');
  } else {
    console.log(`    ${s.multipleDnsRecords.length} domain(s) returned multiple records:`);
    for (const o of s.multipleDnsRecords) {
      console.log(`    * ${o.domain}  (${o.facts.dns_record_count} records)`);
      for (let i = 0; i < o.facts.dns_records.length; i++) {
        const rec = o.facts.dns_records[i];
        console.log(`      [${i}] ${rec.length > 70 ? rec.slice(0, 67) + '...' : rec}`);
      }
    }
  }

  // 12. Unknown tags / fields
  console.log('\n' + div);
  console.log('\n 12. EVIDENCE INVENTORY — UNKNOWN TAGS AND FIELDS\n');
  console.log(`    Domains with unknown DNS tags:     ${s.withUnknownDnsTags.length}`);
  console.log(`    Domains with unknown policy fields: ${s.withUnknownPolicyFields.length}`);

  if (s.withUnknownDnsTags.length > 0) {
    console.log('\n    Unknown DNS tag examples:');
    const tagFreq = {};
    for (const o of s.withUnknownDnsTags) {
      for (const [k, v] of Object.entries(o.facts.dns_unknown_tags)) {
        tagFreq[k] = (tagFreq[k] ?? 0) + 1;
      }
    }
    for (const [name, count] of Object.entries(tagFreq).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${name.padEnd(24)} : ${count}`);
    }
  }

  if (s.withUnknownPolicyFields.length > 0) {
    console.log('\n    Unknown policy field examples:');
    const fieldFreq = {};
    for (const o of s.withUnknownPolicyFields) {
      for (const [k] of Object.entries(o.facts.policy_unknown_fields)) {
        fieldFreq[k] = (fieldFreq[k] ?? 0) + 1;
      }
    }
    for (const [name, count] of Object.entries(fieldFreq).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${name.padEnd(24)} : ${count}`);
    }
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

  // Policy mode examples
  for (const mode of ['enforce', 'testing', 'none']) {
    const examples = s.withPolicy.filter(o => o.facts.policy_mode === mode).slice(0, 2);
    if (examples.length === 0) continue;

    console.log(`\n ${div}`);
    console.log(` mode = ${mode}  (${examples.length} example(s))`);
    console.log(` ${div}`);

    for (const o of examples) {
      const f = o.facts;
      console.log(`\n  Domain               : ${o.domain}`);
      console.log(`  dns_id               : ${f.dns_id ?? 'null'}`);
      console.log(`  policy_mode          : ${f.policy_mode ?? 'null'}`);
      console.log(`  policy_max_age       : ${f.policy_max_age ?? 'null'}`);
      console.log(`  policy_mx_count      : ${f.policy_mx_count}`);
      for (let i = 0; i < f.policy_mx_patterns.length; i++) {
        console.log(`  policy_mx_patterns[${i}] : ${f.policy_mx_patterns[i]}`);
      }
      console.log(`  policy_tls_valid     : ${f.policy_tls_valid}`);
      if (f.policy_tls_error) {
        console.log(`  policy_tls_error     : ${f.policy_tls_error}`);
      }
      console.log(`  policy_body_tls_validated : ${f.policy_body_tls_validated}`);
      console.log(`  policy_parse_success : ${f.policy_parse_success}`);
      if (f.policy_syntax_errors.length > 0) {
        console.log(`  policy_syntax_errors : ${f.policy_syntax_errors.map(e => e.code).join(', ')}`);
      }
      if (f.policy_body_raw) {
        const preview = f.policy_body_raw.slice(0, 120).replace(/\n/g, ' | ');
        console.log(`  policy_body_raw      : "${preview}${f.policy_body_raw.length > 120 ? '...' : ''}"`);
      }
    }
  }

  // TLS invalid examples
  const tlsInvalid = s.withPolicy.filter(o => o.facts.policy_tls_valid === false);
  if (tlsInvalid.length > 0) {
    console.log(`\n ${div}`);
    console.log(` TLS INVALID  — Pass 2 evidence retrieval (up to 3 examples)`);
    console.log(` ${div}`);
    for (const o of tlsInvalid.slice(0, 3)) {
      const f = o.facts;
      console.log(`\n  Domain                  : ${o.domain}`);
      console.log(`  policy_tls_valid        : false`);
      console.log(`  policy_tls_error        : ${f.policy_tls_error}`);
      console.log(`  policy_present          : ${f.policy_present}`);
      console.log(`  policy_body_tls_validated: ${f.policy_body_tls_validated}`);
      if (f.policy_mode) {
        console.log(`  policy_mode             : ${f.policy_mode}`);
      }
    }
  }

  console.log('\n' + hr + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();

  const hr = '═'.repeat(72);
  console.log('\n' + hr);
  console.log(' SOT-MTASTS-001 — HE-001 University Cohort MTA-STS Collection');
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
  const { error: pingErr } = await client.from('signal_facts_mtasts').select('id').limit(1);
  if (pingErr) {
    const tableGone = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    if (tableGone) {
      console.error('\n  ERROR: signal_facts_mtasts table not found.');
      console.error('  Apply backend/db/migrations/009_signal_lab_mtasts.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_facts_mtasts ready\n');

  const observations = await collect(institutions, client, collectedAt);
  const summary      = computeSummary(observations);

  printSummary(summary, collectedAt, skipped);
  printEvidenceReview(summary);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
