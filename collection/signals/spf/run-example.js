'use strict';

// Example execution of the SPF collector against live domains.
// Run with: node backend/signal-lab/signals/spf/run-example.js

const { collectSpf, SIGNAL_ID, SIGNAL_VERSION } = require('./spf-collector');

const DOMAINS = [
  // spf_present: true — well-known records
  { domain: 'google.com',    note: 'expected: present, ~all' },
  { domain: 'gov.uk',        note: 'expected: present, -all' },
  // spf_present: false — DNS responds but no SPF record
  { domain: 'example.com',   note: 'expected: present or absent' },
  // spf_present: false — domain does not exist (NXDOMAIN → definitive absence)
  { domain: 'nonexistent-signal-lab-test.invalid', note: 'expected: absent (NXDOMAIN)' },
];

async function main() {
  console.log(`Signal: ${SIGNAL_ID}  version: ${SIGNAL_VERSION}\n`);
  console.log('spf_present states:  true = present  |  false = absent (DNS resolved)  |  null = unknown (DNS failed)\n');

  for (const { domain, note } of DOMAINS) {
    process.stdout.write(`Collecting ${domain} (${note}) ... `);
    const start = Date.now();

    try {
      const facts = await collectSpf(domain);
      const elapsed = Date.now() - start;
      console.log(`${elapsed}ms\n${JSON.stringify(facts, null, 2)}\n`);
    } catch (err) {
      console.log(`UNCAUGHT ERROR: ${err.message}\n`);
    }
  }
}

main();
