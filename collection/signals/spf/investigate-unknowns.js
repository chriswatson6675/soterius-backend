'use strict';

// SOT-SPF-001 Unknown Investigation
//
// Re-runs the 40 domains where spf_present IS NULL from the HE-001 cohort.
// All 40 original failures were classified DNS_FAILURE — not DNS_TIMEOUT or
// DNS_SERVFAIL — indicating the system resolver returned an unclassified error
// code during the concurrent collection run.
//
// This run uses:
//   - Concurrency 1 (sequential, no resolver contention)
//   - Public DNS resolvers (8.8.8.8 / 1.1.1.1) to bypass the system resolver
//   - 10-second timeout with 3 retries per domain
//   - Raw error code capture before our classifier sees it
//
// Does NOT write to signal_facts_spf (diagnostic run only).
// Does NOT modify schema or scoring.
//
// Usage:
//   node backend/signal-lab/signals/spf/investigate-unknowns.js

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const dns  = require('dns');
const { createClient } = require('@supabase/supabase-js');
const { collectSpf } = require('./spf-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const DNS_TIMEOUT = 10000;
const DNS_TRIES   = 3;
const DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

// ── Timed collection with raw error capture ───────────────────────────────────

async function collectWithDiagnostics(domain) {
  let rawErrorCode = null;

  const resolver = new dns.promises.Resolver({ timeout: DNS_TIMEOUT, tries: DNS_TRIES });
  resolver.setServers(DNS_SERVERS);

  const diagnosticResolver = {
    resolveTxt: async (d) => {
      try {
        return await resolver.resolveTxt(d);
      } catch (err) {
        rawErrorCode = err.code ?? 'UNKNOWN';
        throw err;
      }
    },
  };

  const start = Date.now();
  const facts = await collectSpf(domain, { dnsResolver: diagnosticResolver });
  const elapsed = Date.now() - start;

  return { facts, dns_resolution_time_ms: elapsed, raw_error_code: rawErrorCode };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function presenceLabel(spfPresent) {
  if (spfPresent === true)  return 'Present';
  if (spfPresent === false) return 'Absent';
  return 'Unknown';
}

function stats(nums) {
  if (nums.length === 0) return { min: 'n/a', avg: 'n/a', max: 'n/a' };
  return {
    min: Math.min(...nums),
    avg: Math.round(nums.reduce((s, n) => s + n, 0) / nums.length),
    max: Math.max(...nums),
  };
}

function printComparisonTable(results) {
  const div = '─'.repeat(94);
  console.log('\n' + div);
  console.log(
    '  ' +
    'Domain'.padEnd(36) +
    'Previous'.padEnd(10) +
    'New'.padEnd(10) +
    'Time (ms)'.padEnd(12) +
    'Raw error code'
  );
  console.log(div);
  for (const r of results) {
    const changed = r.new_result !== 'Unknown';
    const newCol  = changed ? `${r.new_result} ←` : r.new_result;
    console.log(
      '  ' +
      r.domain.padEnd(36) +
      r.previous_result.padEnd(10) +
      newCol.padEnd(10) +
      String(r.dns_resolution_time_ms).padStart(6) + 'ms'.padEnd(6) +
      (r.raw_error_code ?? 'null')
    );
  }
  console.log(div + '\n');
}

function printSummary(results) {
  const hr  = '═'.repeat(64);
  const div = '─'.repeat(64);

  const present = results.filter(r => r.facts.spf_present === true);
  const absent  = results.filter(r => r.facts.spf_present === false);
  const unknown = results.filter(r => r.facts.spf_present === null);

  // Error distribution among remaining unknowns
  const collectionErrDist = {};
  const rawErrDist         = {};
  for (const r of unknown) {
    const ce = r.facts.spf_collection_error ?? 'null';
    collectionErrDist[ce] = (collectionErrDist[ce] ?? 0) + 1;
    const re = r.raw_error_code ?? 'null';
    rawErrDist[re] = (rawErrDist[re] ?? 0) + 1;
  }

  // Also capture raw error distribution from original run (all were DNS_FAILURE)
  // and from this run across all domains
  const allRawErrDist = {};
  for (const r of results) {
    if (r.raw_error_code) {
      allRawErrDist[r.raw_error_code] = (allRawErrDist[r.raw_error_code] ?? 0) + 1;
    }
  }

  const { min, avg, max } = stats(results.map(r => r.dns_resolution_time_ms));

  console.log('\n' + hr);
  console.log(' SOT-SPF-001 UNKNOWN INVESTIGATION — SUMMARY');
  console.log(` DNS: ${DNS_SERVERS.join(', ')}   timeout: ${DNS_TIMEOUT}ms   tries: ${DNS_TRIES}`);
  console.log(hr);

  // 1. Outcome distribution
  console.log('\n 1. OUTCOME DISTRIBUTION\n');
  console.log(`    Unknown → Present : ${String(present.length).padStart(3)}`);
  console.log(`    Unknown → Absent  : ${String(absent.length).padStart(3)}`);
  console.log(`    Unknown → Unknown : ${String(unknown.length).padStart(3)}`);
  console.log(`    Total re-tested   : ${String(results.length).padStart(3)}`);

  // 2. Error distribution (remaining unknowns)
  console.log('\n' + div);
  console.log('\n 2. ERROR DISTRIBUTION  (remaining Unknown domains)\n');
  if (Object.keys(collectionErrDist).length === 0) {
    console.log('    (all domains resolved — no remaining failures)');
  } else {
    console.log('    spf_collection_error:');
    for (const [code, count] of Object.entries(collectionErrDist).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${code.padEnd(20)} : ${count}`);
    }
    if (Object.keys(rawErrDist).length > 0) {
      console.log('    raw DNS error code:');
      for (const [code, count] of Object.entries(rawErrDist).sort((a, b) => b[1] - a[1])) {
        console.log(`      ${code.padEnd(20)} : ${count}`);
      }
    }
  }

  // Raw error distribution across ALL re-tested domains (diagnostic)
  if (Object.keys(allRawErrDist).length > 0) {
    console.log('\n    raw DNS error codes across all re-tested domains:');
    for (const [code, count] of Object.entries(allRawErrDist).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${code.padEnd(20)} : ${count}`);
    }
  }

  // 3. Resolution time stats
  console.log('\n' + div);
  console.log('\n 3. DNS RESOLUTION TIME  (all re-tested domains)\n');
  console.log(`    Minimum : ${min}ms`);
  console.log(`    Average : ${avg}ms`);
  console.log(`    Maximum : ${max}ms`);

  // 4. Remaining unknowns
  console.log('\n' + div);
  console.log('\n 4. DOMAINS REMAINING UNKNOWN\n');
  if (unknown.length === 0) {
    console.log('    none — all domains resolved on re-test');
  } else {
    for (const r of unknown.sort((a, b) => a.domain.localeCompare(b.domain))) {
      const ce  = r.facts.spf_collection_error ?? 'no error';
      const raw = r.raw_error_code ?? 'no raw code';
      console.log(`    • ${r.domain.padEnd(36)} [${ce}]  raw: ${raw}  ${r.dns_resolution_time_ms}ms`);
    }
  }

  console.log('\n' + hr + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();

  console.log('\n' + '═'.repeat(64));
  console.log(' SOT-SPF-001 UNKNOWN INVESTIGATION');
  console.log(` DNS servers  : ${DNS_SERVERS.join(', ')}  (public resolvers)`);
  console.log(` DNS timeout  : ${DNS_TIMEOUT}ms   tries: ${DNS_TRIES}`);
  console.log(` Concurrency  : 1  (sequential)`);
  console.log(` Started      : ${startedAt}`);
  console.log('═'.repeat(64));

  // Query signal_facts_spf for HE-001 unknowns
  // All 40 originals were DNS_FAILURE — deduplicate by domain (most recent first)
  const client = getClient();
  const { data: nullRows, error } = await client
    .from('signal_facts_spf')
    .select('domain, spf_collection_error, collected_at')
    .is('spf_present', null)
    .order('collected_at', { ascending: false });

  if (error) {
    console.error('\n  ERROR querying database:', error.message);
    process.exit(1);
  }

  // Deduplicate — keep most recent row per domain
  const seenDomains = new Set();
  const unknownDomains = [];
  for (const row of (nullRows ?? [])) {
    if (!seenDomains.has(row.domain)) {
      seenDomains.add(row.domain);
      unknownDomains.push(row);
    }
  }

  if (unknownDomains.length === 0) {
    console.log('\n  No domains with spf_present IS NULL found.\n');
    process.exit(0);
  }

  console.log(`\n  ${unknownDomains.length} domains to re-test`);
  console.log(`  Original classification: all DNS_FAILURE\n`);
  console.log('  ' + '─'.repeat(72));
  console.log('  ' + 'Domain'.padEnd(36) + 'Time (ms)'.padEnd(12) + 'Result'.padEnd(10) + 'Raw error code');
  console.log('  ' + '─'.repeat(72));

  const results = [];

  for (const { domain } of unknownDomains) {
    const { facts, dns_resolution_time_ms, raw_error_code } = await collectWithDiagnostics(domain);
    const newResult = presenceLabel(facts.spf_present);
    const resolved  = facts.spf_present !== null;

    console.log(
      '  ' +
      domain.padEnd(36) +
      String(dns_resolution_time_ms).padStart(6) + 'ms'.padEnd(6) +
      newResult.padEnd(10) +
      (raw_error_code ?? 'null')
    );

    results.push({
      domain,
      previous_result: 'Unknown',
      new_result: newResult,
      dns_resolution_time_ms,
      raw_error_code,
      facts,
    });
  }

  console.log('  ' + '─'.repeat(72));

  printComparisonTable(results);
  printSummary(results);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
