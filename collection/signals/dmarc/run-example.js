'use strict';

// SOT-DMARC-001 Phase 2 — Live domain validation
//
// Demonstrates all observable DMARC collection states:
//   Present     — domain has a valid DMARC record
//   Absent      — domain definitively has no DMARC record
//   Unknown     — covered by unit tests (requires non-responsive DNS server)
//   Multiple    — covered by unit tests (RFC violation; rare in live DNS)
//
// Usage:
//   node backend/signal-lab/signals/dmarc/run-example.js

const { collectDmarc, SIGNAL_ID, SIGNAL_VERSION } = require('./dmarc-collector');

const DOMAINS = [
  // Expected present -- strong DMARC policies
  { domain: 'gov.uk',             expected: 'present' },
  { domain: 'google.com',         expected: 'present' },
  { domain: 'microsoft.com',      expected: 'present' },
  // Expected present with rua/ruf
  { domain: 'bbc.co.uk',          expected: 'present' },
  // May be absent -- test against a registrar root
  { domain: 'example.com',        expected: 'possibly absent' },
  // Expected absent -- fictional / definitely no MX / no DMARC
  { domain: 'this-domain-definitely-does-not-have-dmarc.invalid', expected: 'absent (NXDOMAIN)' },
];

function formatField(label, value, width = 26) {
  return `  ${label.padEnd(width)}: ${value === null ? 'null' : value === undefined ? 'undefined' : JSON.stringify(value)}`;
}

async function run() {
  const hr  = '='.repeat(70);
  const div = '-'.repeat(70);

  console.log('\n' + hr);
  console.log(` SOT-DMARC-001  Phase 2 -- Live Domain Validation`);
  console.log(` Signal: ${SIGNAL_ID}  version: ${SIGNAL_VERSION}`);
  console.log(hr + '\n');

  for (const { domain, expected } of DOMAINS) {
    console.log(div);
    console.log(` Domain   : ${domain}`);
    console.log(` Expected : ${expected}`);
    console.log(div);

    const start   = Date.now();
    const r       = await collectDmarc(domain);
    const elapsed = Date.now() - start;

    // Three-state presence
    console.log(formatField('dmarc_present',          r.dmarc_present));
    console.log(formatField('dmarc_collection_error', r.dmarc_collection_error));

    // Evidence
    console.log(formatField('dmarc_record_count',     r.dmarc_record_count));
    console.log(formatField('dmarc_multiple_records', r.dmarc_multiple_records));
    if (r.dmarc_records.length > 0) {
      console.log(`  dmarc_records[0]          : ${r.dmarc_records[0].substring(0, 100)}${r.dmarc_records[0].length > 100 ? '...' : ''}`);
      if (r.dmarc_records.length > 1) {
        for (let i = 1; i < r.dmarc_records.length; i++) {
          console.log(`  dmarc_records[${i}]          : ${r.dmarc_records[i].substring(0, 100)}`);
        }
      }
    }

    // Parse result
    console.log(formatField('dmarc_parse_success',    r.dmarc_parse_success));
    if (r.dmarc_syntax_errors.length > 0) {
      console.log(`  dmarc_syntax_errors:`);
      for (const e of r.dmarc_syntax_errors) {
        console.log(`    [${e.code}] ${e.message}`);
      }
    } else {
      console.log(formatField('dmarc_syntax_errors', '[]'));
    }

    // Required tags
    console.log(formatField('dmarc_version',          r.dmarc_version));
    console.log(formatField('dmarc_policy',           r.dmarc_policy));

    // Optional policy tags (null if absent — no RFC defaults applied)
    console.log(formatField('dmarc_subdomain_policy', r.dmarc_subdomain_policy));
    console.log(formatField('dmarc_adkim',            r.dmarc_adkim));
    console.log(formatField('dmarc_aspf',             r.dmarc_aspf));
    console.log(formatField('dmarc_pct',              r.dmarc_pct));

    // Reporting
    console.log(formatField('dmarc_rua',              r.dmarc_rua ? r.dmarc_rua.substring(0, 60) + (r.dmarc_rua.length > 60 ? '...' : '') : null));
    console.log(formatField('dmarc_rua_count',        r.dmarc_rua_count));
    console.log(formatField('dmarc_ruf',              r.dmarc_ruf));
    console.log(formatField('dmarc_ruf_count',        r.dmarc_ruf_count));
    console.log(formatField('dmarc_fo',               r.dmarc_fo));
    console.log(formatField('dmarc_ri',               r.dmarc_ri));
    console.log(formatField('dmarc_rf',               r.dmarc_rf));

    console.log(`  elapsed                   : ${elapsed}ms\n`);
  }

  console.log(hr);
  console.log(' Phase 2 complete.');
  console.log(' Unknown state and multiple-record handling: see unit tests.');
  console.log(hr + '\n');
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
