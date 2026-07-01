'use strict';

// Ad-hoc DKIM collector run against live domains.
// Usage: node backend/signal-lab/signals/dkim/run-example.js

const { collectDkim, SIGNAL_ID, SIGNAL_VERSION } = require('./dkim-collector');

const DOMAINS = [
  'gov.uk',
  'google.com',
  'bbc.co.uk',
  'leeds.ac.uk',
];

async function main() {
  console.log(`Signal: ${SIGNAL_ID}  version: ${SIGNAL_VERSION}\n`);

  for (const domain of DOMAINS) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`Domain: ${domain}`);
    console.log('─'.repeat(64));
    const start = Date.now();
    const facts  = await collectDkim(domain);
    const elapsed = Date.now() - start;

    console.log(`dkim_present          : ${facts.dkim_present}`);
    console.log(`dkim_collection_status: ${facts.dkim_collection_status}`);
    console.log(`dkim_record_count     : ${facts.dkim_record_count}`);
    console.log(`dkim_selectors_found  : ${facts.dkim_selectors_found.join(', ') || '(none)'}`);
    console.log(`elapsed               : ${elapsed}ms`);

    for (const key of facts.dkim_keys) {
      console.log(`\n  Selector: ${key.selector}`);
      console.log(`  key_type: ${key.key_type}  key_bits: ${key.key_bits ?? 'n/a'}  public_key_present: ${key.public_key_present}`);
      console.log(`  parse_success: ${key.parse_success}  errors: ${key.syntax_errors.length}`);
      if (key.syntax_errors.length > 0) {
        for (const e of key.syntax_errors) console.log(`    [${e.code}] ${e.message}`);
      }
    }
  }
  console.log('\n' + '─'.repeat(64) + '\n');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
