'use strict';

// SOT-DKIM-001-A — DNS Failure Investigation
//
// Re-tests the 6 domains that returned DNS_FAILURE in the initial HE-001
// collection run. Applies the SPF investigation methodology:
//   - Concurrency 1 (sequential — eliminates resolver contention)
//   - Public DNS resolvers (8.8.8.8 / 1.1.1.1 — bypasses system resolver)
//   - 10-second timeout with 3 retries per probe
//   - Per-probe raw error code capture
//
// Does NOT write to signal_facts_dkim (diagnostic run only).
// Does NOT modify probe strategy, schema, or scoring.
//
// Usage:
//   node backend/signal-lab/signals/dkim/investigate-failures.js

const dns = require('node:dns');
const { collectDkim, PROBE_SELECTORS } = require('./dkim-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const DNS_TIMEOUT = 10000;
const DNS_TRIES   = 3;
const DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

const INVESTIGATION_DOMAINS = [
  'ed.ac.uk',
  'rgu.ac.uk',
  'open.ac.uk',
  'bucks.ac.uk',
  'dur.ac.uk',
  'strath.ac.uk',
];

// ── Diagnostic resolver ───────────────────────────────────────────────────────
//
// Wraps dns.promises.Resolver with per-probe error capture.
// Records the raw Node.js error code for every probe that fails,
// keyed by selector name, before the collector's classifyDnsError sees it.

function makeDiagnosticResolver() {
  const resolver = new dns.promises.Resolver({ timeout: DNS_TIMEOUT, tries: DNS_TRIES });
  resolver.setServers(DNS_SERVERS);

  const perProbeErrors = {}; // { selector: errorCode }

  const dnsResolver = {
    resolveTxt: async (qname) => {
      try {
        return await resolver.resolveTxt(qname);
      } catch (err) {
        const selector = qname.split('._domainkey.')[0];
        perProbeErrors[selector] = err.code ?? 'UNKNOWN';
        throw err;
      }
    },
  };

  return { dnsResolver, perProbeErrors };
}

// ── Collection with diagnostics ───────────────────────────────────────────────

async function collectWithDiagnostics(domain) {
  const { dnsResolver, perProbeErrors } = makeDiagnosticResolver();

  const start = Date.now();
  const facts = await collectDkim(domain, { dnsResolver });
  const elapsed = Date.now() - start;

  // Summarise per-probe errors
  const errorCodes = Object.values(perProbeErrors);
  const uniqueErrorCodes = [...new Set(errorCodes)];

  // Dominant error = the code that appeared most frequently
  const errorFreq = {};
  for (const code of errorCodes) {
    errorFreq[code] = (errorFreq[code] ?? 0) + 1;
  }
  const dominantErrorCode = errorCodes.length > 0
    ? Object.entries(errorFreq).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  return {
    facts,
    dns_resolution_time_ms: elapsed,
    per_probe_errors:       perProbeErrors,
    unique_error_codes:     uniqueErrorCodes,
    dominant_error_code:    dominantErrorCode,
    probes_with_errors:     errorCodes.length,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function outcomeLabel(facts) {
  if (facts.dkim_present === true)   return 'Exposed';
  if (facts.dkim_collection_status === 'NOT_DETECTED') return 'NOT_DETECTED';
  return facts.dkim_collection_status ?? 'Unknown';
}

function stats(nums) {
  if (nums.length === 0) return { min: 'n/a', avg: 'n/a', max: 'n/a' };
  return {
    min: Math.min(...nums),
    avg: Math.round(nums.reduce((s, n) => s + n, 0) / nums.length),
    max: Math.max(...nums),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  const hr  = '='.repeat(72);
  const div = '-'.repeat(72);

  console.log('\n' + hr);
  console.log(' SOT-DKIM-001-A  DNS FAILURE INVESTIGATION');
  console.log(` DNS servers  : ${DNS_SERVERS.join(', ')}  (public resolvers)`);
  console.log(` DNS timeout  : ${DNS_TIMEOUT}ms   tries: ${DNS_TRIES}`);
  console.log(` Concurrency  : 1  (sequential)`);
  console.log(` Domains      : ${INVESTIGATION_DOMAINS.length}`);
  console.log(` Started      : ${startedAt}`);
  console.log(hr + '\n');

  const results = [];

  for (const domain of INVESTIGATION_DOMAINS) {
    process.stdout.write(`  Testing ${domain.padEnd(24)} ... `);

    const diag       = await collectWithDiagnostics(domain);
    const newOutcome = outcomeLabel(diag.facts);
    const selectors  = diag.facts.dkim_selectors_found.join(', ') || '(none)';

    console.log(`${newOutcome}  ${diag.dns_resolution_time_ms}ms`);

    if (diag.probes_with_errors > 0) {
      console.log(`    Probes with errors: ${diag.probes_with_errors}  codes: ${diag.unique_error_codes.join(', ')}`);
    }
    if (diag.facts.dkim_present === true) {
      console.log(`    Selectors found : ${selectors}`);
    }

    results.push({
      domain,
      previous_result:        'DNS_FAILURE',
      new_result:             newOutcome,
      dns_resolution_time_ms: diag.dns_resolution_time_ms,
      dominant_error_code:    diag.dominant_error_code,
      unique_error_codes:     diag.unique_error_codes,
      probes_with_errors:     diag.probes_with_errors,
      facts:                  diag.facts,
    });
  }

  // ── Comparison table ────────────────────────────────────────────────────────

  const COL = {
    domain:   20,
    prev:     12,
    next:     14,
    time:     10,
    err:      16,
    sel:      0,
  };

  console.log('\n' + hr);
  console.log(' COMPARISON TABLE');
  console.log(hr);
  console.log(
    '  ' +
    'Domain'.padEnd(COL.domain) +
    'Previous'.padEnd(COL.prev) +
    'New'.padEnd(COL.next) +
    'Time(ms)'.padEnd(COL.time) +
    'Error code'.padEnd(COL.err) +
    'Selectors found'
  );
  console.log('  ' + div);

  for (const r of results) {
    const changed = r.new_result !== 'DNS_FAILURE';
    const newCol  = changed ? `${r.new_result} <-` : r.new_result;
    const selFound = r.facts.dkim_selectors_found.join(', ') || '(none)';
    console.log(
      '  ' +
      r.domain.padEnd(COL.domain) +
      r.previous_result.padEnd(COL.prev) +
      newCol.padEnd(COL.next) +
      String(r.dns_resolution_time_ms).padStart(6) + 'ms'.padEnd(4) +
      (r.dominant_error_code ?? 'null').padEnd(COL.err) +
      selFound
    );
  }
  console.log('  ' + div);

  // ── Summary ─────────────────────────────────────────────────────────────────

  const exposed     = results.filter(r => r.facts.dkim_present === true);
  const notDetected = results.filter(r => r.new_result === 'NOT_DETECTED');
  const stillFailed = results.filter(r => r.facts.dkim_present === null && r.new_result !== 'NOT_DETECTED');

  const allSelectors = {};
  for (const r of exposed) {
    for (const sel of r.facts.dkim_selectors_found) {
      allSelectors[sel] = (allSelectors[sel] ?? 0) + 1;
    }
  }

  const { min, avg, max } = stats(results.map(r => r.dns_resolution_time_ms));

  console.log('\n' + hr);
  console.log(' SUMMARY');
  console.log(hr);

  console.log('\n 1. OUTCOME DISTRIBUTION\n');
  console.log(`    DNS_FAILURE -> Exposed       : ${String(exposed.length).padStart(3)}`);
  console.log(`    DNS_FAILURE -> NOT_DETECTED  : ${String(notDetected.length).padStart(3)}`);
  console.log(`    DNS_FAILURE -> DNS_FAILURE   : ${String(stillFailed.length).padStart(3)}`);
  console.log(`    Total re-tested              : ${String(results.length).padStart(3)}`);

  console.log('\n' + div);
  console.log('\n 2. RESOLUTION TIME\n');
  console.log(`    Minimum : ${min}ms`);
  console.log(`    Average : ${avg}ms`);
  console.log(`    Maximum : ${max}ms`);

  console.log('\n' + div);
  console.log('\n 3. SELECTORS DISCOVERED DURING INVESTIGATION\n');
  if (Object.keys(allSelectors).length === 0) {
    console.log('    (none)');
  } else {
    for (const [sel, count] of Object.entries(allSelectors).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${sel.padEnd(24)} : ${count}`);
    }
  }

  console.log('\n' + div);
  console.log('\n 4. DOMAINS REMAINING UNRESOLVED\n');
  if (stillFailed.length === 0) {
    console.log('    none — all domains resolved on re-test');
  } else {
    for (const r of stillFailed) {
      console.log(`    * ${r.domain.padEnd(24)} [${r.new_result}]  raw: ${r.dominant_error_code ?? 'null'}  ${r.dns_resolution_time_ms}ms`);
      if (r.probes_with_errors > 0) {
        console.log(`      probe error codes: ${r.unique_error_codes.join(', ')}`);
      }
    }
  }

  // Per-probe error detail for any remaining failures
  if (stillFailed.length > 0) {
    console.log('\n' + div);
    console.log('\n 5. PER-PROBE ERROR DETAIL  (remaining failures)\n');
    for (const r of stillFailed) {
      console.log(`    ${r.domain}`);
      const entries = Object.entries(
        results.find(x => x.domain === r.domain)?.per_probe_errors ?? {}
      );
      if (entries.length === 0) {
        console.log('      (no per-probe errors captured)');
      } else {
        const byCode = {};
        for (const [sel, code] of entries) {
          byCode[code] = byCode[code] ?? [];
          byCode[code].push(sel);
        }
        for (const [code, sels] of Object.entries(byCode)) {
          console.log(`      ${code.padEnd(20)} (${sels.length} probes): ${sels.slice(0, 5).join(', ')}${sels.length > 5 ? ` +${sels.length - 5} more` : ''}`);
        }
      }
    }
  }

  console.log('\n' + hr + '\n');
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
