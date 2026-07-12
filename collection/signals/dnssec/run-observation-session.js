'use strict';

// SOT-DNSSEC-001 — Canonical Observation collection run.
//
// The reference OPERATIONAL entry point for DNSSEC under the Observatory's
// canonical Observation model (ADR-SYS-009 programme, Sprint 7). It runs one
// Collection Run under the standing National DNSSEC programme and persists one
// canonical Observation (envelope + payload) per domain, with full ownership.
//
// Unlike run-he-001.js (which writes payload-only rows and prints a cohort
// analysis — left untouched), this script exercises the complete ownership chain:
//   Collection Programme → Collection Run → Observation.
//
// Usage:
//   node collection/signals/dnssec/run-observation-session.js [domain ...]
// With no args it runs a small built-in validation set.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { runDnssecCollectionSession } = require('./dnssec-collection-session');
const { getClient } = require('../../../infra/database');

// A small, deliberately mixed validation set (signed and unsigned) — enough to
// prove the chain and the truthful-outcome distinction, not a national baseline.
const DEFAULT_DOMAINS = [
  'cloudflare.com', 'iana.org', 'ietf.org', 'verisign.com',
  'gov.uk', 'nic.cz', 'google.com', 'bbc.co.uk',
];

async function main() {
  const domains = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DOMAINS;
  const client = getClient();

  const startedAt = new Date();
  console.log(`\nDNSSEC canonical Observation run — ${domains.length} domains`);
  console.log(`started: ${startedAt.toISOString()}\n`);

  const t0 = Date.now();
  const result = await runDnssecCollectionSession({
    runLabel: `OBS-DNSSEC-VALIDATION-${startedAt.toISOString().slice(0, 10)}`,
    domains,
    deps: { client },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`Programme : ${result.programme.programme_key}  (${result.programme.id})`);
  console.log(`Run       : ${result.run.run_label}  (${result.run.id})  status=${result.run.status}`);
  console.log(`Counts    : ${JSON.stringify(result.counts)}\n`);
  for (const o of result.observations) {
    console.log(`  ${o.domain.padEnd(20)} ${o.id ? 'obs=' + o.id : 'ERROR: ' + o.error}`);
  }
  console.log(`\ncompleted in ${elapsed}s`);
  return result;
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
