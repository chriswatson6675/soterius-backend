'use strict';

// SOT-DKIM-001 — HE-001 University Cohort DKIM Collection Run
//
// Reads the 166-institution HE-001 cohort from the data.ac.uk CSV,
// runs the DKIM collector against every domain (probe set v1, 20 selectors),
// stores observations in signal_facts_dkim and signal_facts_dkim_keys,
// and prints a full cohort summary.
//
// INTERPRETATION RULE:
//   'Exposed' = at least one DKIM key was found via the probe set.
//   This does NOT confirm overall DKIM deployment for any institution.
//   Selector discovery is not exhaustive.
//
// Usage:
//   node backend/signal-lab/signals/dkim/run-he-001.js
//
// Prerequisites:
//   Migration 007_signal_lab_dkim.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectDkim, SIGNAL_ID, SIGNAL_VERSION } = require('./dkim-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 10;

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
  // Insert domain-level row and retrieve its id
  const { data, error: domainErr } = await client
    .from('signal_facts_dkim')
    .insert({
      domain,
      signal_version:         SIGNAL_VERSION,
      collected_at:           collectedAt,
      dkim_present:           facts.dkim_present,
      dkim_collection_status: facts.dkim_collection_status,
      dkim_record_count:      facts.dkim_record_count,
      dkim_selectors_probed:  facts.dkim_selectors_probed,
      dkim_selectors_found:   facts.dkim_selectors_found,
      dkim_probe_set_version: facts.dkim_probe_set_version,
    })
    .select('id')
    .single();

  if (domainErr) return { domainErr, keysErr: null };

  // Insert key-level rows (batch)
  if (facts.dkim_keys.length > 0) {
    const { error: keysErr } = await client
      .from('signal_facts_dkim_keys')
      .insert(
        facts.dkim_keys.map(key => ({
          dkim_run_id:        data.id,
          domain,
          collected_at:       collectedAt,
          selector:           key.selector,
          raw_record:         key.raw_record,
          parse_success:      key.parse_success,
          version:            key.version,
          key_type:           key.key_type,
          key_bits:           key.key_bits,
          public_key_present: key.public_key_present,
          hash_algorithms:    key.hash_algorithms,
          service_type:       key.service_type,
          flags:              key.flags,
          syntax_errors:      key.syntax_errors,
        }))
      );
    if (keysErr) return { domainErr: null, keysErr };
  }

  return { domainErr: null, keysErr: null };
}

// ── Collection run ────────────────────────────────────────────────────────────

async function collect(institutions, client, collectedAt) {
  const total     = institutions.length;
  const startedAt = Date.now();
  let   completed = 0;

  const div = '─'.repeat(72);
  console.log(`\n${div}`);
  console.log(` Collecting — ${total} institutions  concurrency: ${CONCURRENCY}  probe set: v1 (${20} selectors)`);
  console.log(`${div}\n`);
  console.log('  Legend:  ✓ exposed   ∅ not detected   ? DNS uncertain\n');

  const observations = await runWithConcurrency(institutions, async (inst) => {
    const facts  = await collectDkim(inst.domain);
    const { domainErr, keysErr } = await saveObservation(client, inst.domain, facts, collectedAt);
    completed++;

    const pct    = String(Math.round((completed / total) * 100)).padStart(3);
    const symbol = facts.dkim_present === true ? '✓' : facts.dkim_collection_status === 'NOT_DETECTED' ? '∅' : '?';
    const detail = facts.dkim_present === true
      ? `${facts.dkim_selectors_found.join(', ')}  (${facts.dkim_record_count} ${facts.dkim_record_count === 1 ? 'key' : 'keys'})`
      : `(${facts.dkim_collection_status})`;
    const dbNote = domainErr ? ` [DB domain: ${domainErr.message}]`
      : keysErr ? ` [DB keys: ${keysErr.message}]` : '';

    console.log(`  [${pct}%] ${symbol}  ${inst.domain.padEnd(36)} ${detail}${dbNote}`);

    return { ...inst, facts, keys: facts.dkim_keys, domainErr, keysErr };
  }, CONCURRENCY);

  const elapsed  = ((Date.now() - startedAt) / 1000).toFixed(1);
  const dbErrors = observations.filter(o => o.domainErr || o.keysErr).length;

  console.log(`\n  Completed: ${total} institutions in ${elapsed}s`);
  if (dbErrors > 0) console.log(`  WARNING: ${dbErrors} database write(s) failed`);

  return observations;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(observations) {
  const total   = observations.length;
  const allKeys = observations.flatMap(o => o.keys);

  // 1. Collection outcome distribution
  const outcomes = { present: 0, not_detected: 0, dns_timeout: 0, dns_servfail: 0, dns_failure: 0 };
  for (const { facts } of observations) {
    if      (facts.dkim_present === true)                       outcomes.present++;
    else if (facts.dkim_collection_status === 'NOT_DETECTED')   outcomes.not_detected++;
    else if (facts.dkim_collection_status === 'DNS_TIMEOUT')    outcomes.dns_timeout++;
    else if (facts.dkim_collection_status === 'DNS_SERVFAIL')   outcomes.dns_servfail++;
    else if (facts.dkim_collection_status === 'DNS_FAILURE')    outcomes.dns_failure++;
  }

  // 2–3. Selector discovery — count and rank
  const selectorCounts = {};
  for (const key of allKeys) {
    selectorCounts[key.selector] = (selectorCounts[key.selector] ?? 0) + 1;
  }

  // 4. Key type distribution
  const keyTypeCounts = {};
  for (const key of allKeys) {
    const kt = key.key_type ?? 'unknown';
    keyTypeCounts[kt] = (keyTypeCounts[kt] ?? 0) + 1;
  }

  // 5. Key length distribution (RSA only — key_bits is null for Ed25519)
  const keyBitsCounts = {};
  for (const key of allKeys) {
    if (key.key_bits !== null) {
      const k = String(key.key_bits);
      keyBitsCounts[k] = (keyBitsCounts[k] ?? 0) + 1;
    }
  }

  // 6. Domains with multiple keys
  const multipleKeys = observations.filter(o => o.keys.length > 1);

  // 7. Domains with revoked keys (public_key_present = false)
  const revokedKeys = observations.filter(o =>
    o.keys.some(k => k.public_key_present === false)
  );

  // 8. Parse error distribution
  const parseErrors = {};
  for (const key of allKeys) {
    for (const err of (key.syntax_errors ?? [])) {
      parseErrors[err.code] = (parseErrors[err.code] ?? 0) + 1;
    }
  }

  return {
    total, allKeys, outcomes, selectorCounts, keyTypeCounts,
    keyBitsCounts, multipleKeys, revokedKeys, parseErrors,
  };
}

// ── Summary output ────────────────────────────────────────────────────────────

function pct(n, of) {
  if (of === 0) return '  0.0%';
  return `${((n / of) * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(s, collectedAt, skipped = []) {
  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);
  const { present, not_detected, dns_timeout, dns_servfail, dns_failure } = s.outcomes;

  console.log('\n' + hr);
  console.log(` SOT-DKIM-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${s.total}`);
  console.log(` Collected: ${collectedAt}`);
  console.log(` Probe set: v1 (20 selectors)`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain`);
    for (const sk of skipped) {
      console.log(`   UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
    }
  }
  console.log(hr);

  // Interpretation notice
  console.log('\n NOTE: "Exposed" means at least one DKIM key was found via the probe set.');
  console.log('       This does NOT confirm or deny overall DKIM deployment.');
  console.log('       Selector discovery is not exhaustive.\n');

  // 1. Collection outcome distribution
  console.log(div);
  console.log('\n 1. COLLECTION OUTCOME DISTRIBUTION\n');
  console.log(`    Exposed      (dkim_present = true)         : ${String(present).padStart(4)}  ${pct(present, s.total)}`);
  console.log(`    Not detected (NOT_DETECTED)                : ${String(not_detected).padStart(4)}  ${pct(not_detected, s.total)}`);
  console.log(`    DNS_TIMEOUT                                : ${String(dns_timeout).padStart(4)}  ${pct(dns_timeout, s.total)}`);
  console.log(`    DNS_SERVFAIL                               : ${String(dns_servfail).padStart(4)}  ${pct(dns_servfail, s.total)}`);
  console.log(`    DNS_FAILURE                                : ${String(dns_failure).padStart(4)}  ${pct(dns_failure, s.total)}`);
  console.log(`    Total keys discovered                      : ${String(s.allKeys.length).padStart(4)}`);

  // 2. Selector discovery distribution (all discovered selectors with counts)
  console.log('\n' + div);
  console.log('\n 2. SELECTOR DISCOVERY DISTRIBUTION\n');
  const selectorEntries = Object.entries(s.selectorCounts).sort((a, b) => b[1] - a[1]);
  if (selectorEntries.length === 0) {
    console.log('    (no selectors discovered)');
  } else {
    for (const [sel, count] of selectorEntries) {
      console.log(`    ${sel.padEnd(28)} : ${String(count).padStart(4)}`);
    }
  }

  // 3. Most common selectors (ranked)
  console.log('\n' + div);
  console.log('\n 3. MOST COMMON SELECTORS (ranked by frequency)\n');
  if (selectorEntries.length === 0) {
    console.log('    (none discovered)');
  } else {
    let rank = 1;
    for (const [sel, count] of selectorEntries) {
      console.log(`    ${String(rank).padStart(2)}.  ${sel.padEnd(24)} : ${count}`);
      rank++;
    }
  }

  // 4. Key type distribution
  console.log('\n' + div);
  console.log('\n 4. KEY TYPE DISTRIBUTION\n');
  for (const [kt, count] of Object.entries(s.keyTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kt.padEnd(28)} : ${String(count).padStart(4)}`);
  }
  if (Object.keys(s.keyTypeCounts).length === 0) console.log('    (no keys discovered)');

  // 5. Key length distribution
  console.log('\n' + div);
  console.log('\n 5. KEY LENGTH DISTRIBUTION (RSA only — bits)\n');
  const bitEntries = Object.entries(s.keyBitsCounts)
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0]);
  if (bitEntries.length === 0) {
    console.log('    (no RSA keys with measurable length)');
  } else {
    for (const [bits, count] of bitEntries) {
      console.log(`    ${String(bits).padStart(6)} bits  : ${String(count).padStart(4)}`);
    }
  }

  // 6. Domains with multiple keys
  console.log('\n' + div);
  console.log(`\n 6. DOMAINS WITH MULTIPLE KEYS DISCOVERED  (${s.multipleKeys.length})\n`);
  if (s.multipleKeys.length === 0) {
    console.log('    (none)\n');
  } else {
    for (const o of s.multipleKeys) {
      console.log(`    • ${o.domain.padEnd(36)} ${o.keys.length} keys: ${o.facts.dkim_selectors_found.join(', ')}`);
    }
    console.log('');
  }

  // 7. Domains with revoked keys (public_key_present = false)
  console.log(div);
  console.log(`\n 7. DOMAINS WITH public_key_present = false  (${s.revokedKeys.length})\n`);
  if (s.revokedKeys.length === 0) {
    console.log('    (none)\n');
  } else {
    for (const o of s.revokedKeys) {
      const revokedSelectors = o.keys
        .filter(k => k.public_key_present === false)
        .map(k => k.selector)
        .join(', ');
      console.log(`    • ${o.domain.padEnd(36)} selector(s): ${revokedSelectors}`);
    }
    console.log('');
  }

  // 8. Parse error distribution
  console.log(div);
  console.log('\n 8. PARSE ERROR DISTRIBUTION\n');
  const parseErrEntries = Object.entries(s.parseErrors).sort((a, b) => b[1] - a[1]);
  if (parseErrEntries.length === 0) {
    console.log('    (none detected)');
  } else {
    for (const [code, count] of parseErrEntries) {
      console.log(`    ${code.padEnd(30)} : ${String(count).padStart(4)}`);
    }
  }

  console.log('\n' + hr + '\n');
}

// ── Phase 4 — Evidence Review ─────────────────────────────────────────────────

function printEvidenceReview(observations) {
  const withKeys = observations.filter(o => o.keys.length > 0).slice(0, 10);

  if (withKeys.length === 0) {
    console.log(' PHASE 4 — EVIDENCE REVIEW: no keys discovered\n');
    return;
  }

  const hr  = '═'.repeat(72);
  const div = '─'.repeat(72);

  console.log('\n' + hr);
  console.log(' PHASE 4 — EVIDENCE REVIEW');
  console.log(` Sample of up to 10 discovered keys. Purpose: validate selector discovery`);
  console.log(` and record parsing. Confirm stored evidence matches DNS observations.`);
  console.log(hr);

  for (const o of withKeys) {
    for (const key of o.keys) {
      const truncated = key.raw_record.length > 80
        ? key.raw_record.slice(0, 77) + '...'
        : key.raw_record;
      console.log(`\n  Domain          : ${o.domain}`);
      console.log(`  Selector        : ${key.selector}`);
      console.log(`  Raw record      : ${truncated}`);
      console.log(`  key_type        : ${key.key_type ?? 'null'}`);
      console.log(`  key_bits        : ${key.key_bits ?? 'null'}`);
      console.log(`  version         : ${key.version ?? 'null'}`);
      console.log(`  public_key_present : ${key.public_key_present}`);
      console.log(`  hash_algorithms : ${key.hash_algorithms ? key.hash_algorithms.join(', ') : 'null'}`);
      console.log(`  service_type    : ${key.service_type ? key.service_type.join(', ') : 'null'}`);
      console.log(`  flags           : ${key.flags ? key.flags.join(', ') : 'null'}`);
      console.log(`  parse_success   : ${key.parse_success}`);
      if (key.syntax_errors.length > 0) {
        console.log(`  syntax_errors   : ${key.syntax_errors.map(e => e.code).join(', ')}`);
      } else {
        console.log(`  syntax_errors   : (none)`);
      }
      console.log('  ' + div);
    }
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();

  console.log('\n' + '═'.repeat(72));
  console.log(' SOT-DKIM-001 — HE-001 University Cohort DKIM Collection');
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${collectedAt}`);
  console.log('═'.repeat(72));

  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded from CSV`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s) — source data quality issue:`);
    for (const s of skipped) {
      console.log(`    • UKPRN ${s.ukprn}  ${s.name}  [${s.reason}]`);
    }
  }

  const client = getClient();
  const { error: pingErr } = await client.from('signal_facts_dkim').select('id').limit(1);
  if (pingErr) {
    const tableGone = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    if (tableGone) {
      console.error('\n  ERROR: signal_facts_dkim table not found.');
      console.error('  Apply backend/db/migrations/007_signal_lab_dkim.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_facts_dkim and signal_facts_dkim_keys ready');

  const observations = await collect(institutions, client, collectedAt);
  const summary      = computeSummary(observations);

  printSummary(summary, collectedAt, skipped);
  printEvidenceReview(observations);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
