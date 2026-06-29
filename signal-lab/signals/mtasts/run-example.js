'use strict';

// SOT-MTASTS-001 — Live Domain Validation
//
// Demonstrates all observable MTA-STS collection states:
//
//   DNS present + Policy present + TLS valid   — full MTA-STS deployment
//   DNS present + Policy absent                — DNS record but no policy file
//   DNS absent                                 — no MTA-STS DNS record
//   DNS unknown                                — covered in unit tests (requires unresponsive DNS)
//   TLS invalid + Policy retrieved via Pass 2  — covered in unit tests (requires bad-cert server)
//   TLS handshake failure                      — covered in unit tests (requires broken TLS server)
//
// Usage:
//   node backend/signal-lab/signals/mtasts/run-example.js

const { collectMtaSts, SIGNAL_ID, SIGNAL_VERSION } = require('./mtasts-collector');

const DOMAINS = [
  // Expected: DNS present + policy present (enforce) + TLS valid
  { domain: 'google.com',         expected: 'DNS present, policy present (enforce)' },
  { domain: 'gov.uk',             expected: 'DNS present, policy present' },
  // Expected: DNS present + policy present (testing mode common for newer deployments)
  { domain: 'fastmail.com',       expected: 'DNS present, policy present' },
  // Expected: DNS absent (no MTA-STS deployment)
  { domain: 'example.com',        expected: 'DNS absent (no MTA-STS)' },
  // Expected: DNS absent (fictional domain)
  { domain: 'this-domain-has-no-mta-sts.invalid', expected: 'DNS absent (NXDOMAIN)' },
];

function fv(value, width = 28) {
  const s = value === null      ? 'null'
          : value === undefined ? 'undefined'
          : Array.isArray(value) ? `[${value.length} items]`
          : typeof value === 'object' ? JSON.stringify(value)
          : JSON.stringify(value);
  return `  ${String('').padEnd(width - s.length)}${s}`;
}

function field(label, value, width = 30) {
  const s = value === null      ? 'null'
          : value === undefined ? 'undefined'
          : Array.isArray(value) ? (value.length === 0 ? '[]' : `[${value.length}] ${JSON.stringify(value).slice(0, 60)}`)
          : typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 60)
          : JSON.stringify(value);
  return `  ${label.padEnd(width)}: ${s}`;
}

function printTlsState(r) {
  if (r.policy_tls_valid === true)  return 'valid';
  if (r.policy_tls_valid === false) return `INVALID (${r.policy_tls_error ?? 'unknown'})`;
  return 'null (not established)';
}

async function run() {
  const hr  = '='.repeat(72);
  const div = '-'.repeat(72);

  console.log('\n' + hr);
  console.log(` SOT-MTASTS-001  Phase 2 -- Live Domain Validation`);
  console.log(` Signal: ${SIGNAL_ID}  version: ${SIGNAL_VERSION}`);
  console.log(hr + '\n');

  for (const { domain, expected } of DOMAINS) {
    console.log(div);
    console.log(` Domain   : ${domain}`);
    console.log(` Expected : ${expected}`);
    console.log(div);

    const start   = Date.now();
    const r       = await collectMtaSts(domain);
    const elapsed = Date.now() - start;

    // ── DNS layer ──────────────────────────────────────────────────────────

    console.log('\n  [ DNS ]');
    console.log(field('dns_sts_present',          r.dns_sts_present));
    console.log(field('dns_collection_error',     r.dns_collection_error));
    console.log(field('dns_record_count',         r.dns_record_count));
    console.log(field('dns_sts_record_count',     r.dns_sts_record_count));
    console.log(field('dns_multiple_sts_records', r.dns_multiple_sts_records));

    if (r.dns_records.length > 0) {
      for (let i = 0; i < r.dns_records.length; i++) {
        const rec = r.dns_records[i];
        console.log(`  dns_records[${i}]`.padEnd(32) + `: ${rec.length > 70 ? rec.slice(0, 67) + '...' : rec}`);
      }
    }

    console.log(field('dns_parse_success',        r.dns_parse_success));
    if (r.dns_syntax_errors.length > 0) {
      console.log('  dns_syntax_errors:');
      for (const e of r.dns_syntax_errors) console.log(`    [${e.code}] ${e.message}`);
    } else {
      console.log(field('dns_syntax_errors',      '[]'));
    }
    console.log(field('dns_version',              r.dns_version));
    console.log(field('dns_id',                   r.dns_id));
    if (Object.keys(r.dns_unknown_tags).length > 0) {
      console.log(field('dns_unknown_tags',       JSON.stringify(r.dns_unknown_tags)));
    } else {
      console.log(field('dns_unknown_tags',       '{}'));
    }

    // ── HTTPS layer ────────────────────────────────────────────────────────

    console.log('\n  [ HTTPS ]');
    console.log(field('policy_fetch_attempted',   r.policy_fetch_attempted));
    console.log(field('policy_present',           r.policy_present));
    console.log(field('policy_http_status',       r.policy_http_status));
    console.log(field('policy_fetch_error',       r.policy_fetch_error));
    console.log(`  ${'policy_tls_valid'.padEnd(30)}: ${printTlsState(r)}`);
    console.log(field('policy_redirect_count',    r.policy_redirect_count));
    console.log(field('policy_content_type',      r.policy_content_type));
    console.log(field('policy_body_tls_validated',r.policy_body_tls_validated));

    if (r.policy_body_raw) {
      const preview = r.policy_body_raw.slice(0, 120).replace(/\n/g, ' | ');
      console.log(`  ${'policy_body_raw'.padEnd(30)}: "${preview}${r.policy_body_raw.length > 120 ? '...' : ''}"`);
    } else {
      console.log(field('policy_body_raw',        null));
    }

    // ── Policy parsed fields ───────────────────────────────────────────────

    if (r.policy_present === true) {
      console.log('\n  [ Policy Parsed Fields ]');
      console.log(field('policy_parse_success',   r.policy_parse_success));
      if (r.policy_syntax_errors.length > 0) {
        console.log('  policy_syntax_errors:');
        for (const e of r.policy_syntax_errors) console.log(`    [${e.code}] ${e.message}`);
      } else {
        console.log(field('policy_syntax_errors', '[]'));
      }
      console.log(field('policy_version',         r.policy_version));
      console.log(field('policy_mode',            r.policy_mode));
      console.log(field('policy_max_age',         r.policy_max_age));
      console.log(field('policy_mx_count',        r.policy_mx_count));
      for (let i = 0; i < r.policy_mx_patterns.length; i++) {
        console.log(`  policy_mx_patterns[${i}]`.padEnd(32) + `: ${r.policy_mx_patterns[i]}`);
      }
      if (Object.keys(r.policy_unknown_fields).length > 0) {
        console.log(field('policy_unknown_fields', JSON.stringify(r.policy_unknown_fields)));
      }
    }

    console.log(`\n  elapsed: ${elapsed}ms\n`);
  }

  console.log(hr);
  console.log(' Phase 2 complete.');
  console.log(' TLS invalid and handshake failure scenarios: see unit tests.');
  console.log(' DNS unknown state: requires unresponsive DNS; see unit tests.');
  console.log(hr + '\n');
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
