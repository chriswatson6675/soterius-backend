'use strict';

// run-example.js — run the Companies House collector against one real anchor.
//
// Targeted-Snapshot mode only (CCS-COMPHOUSE-001 §4.1). Emits evidence objects
// and a coverage record to stdout; it does NOT persist anything (the collector
// stops at the Preserve boundary — storage is a separate concern, CCS §0.2).
//
// Usage:
//   CH_API_KEY=xxxx node signal-lab/sources/companies-house/run-example.js 00000006
//   CH_API_KEY=xxxx node .../run-example.js 00000006 --no-docs
//   CH_API_KEY=xxxx node .../run-example.js --disq natural/AbC123   (EO-10)
//
// Get a free API key from https://developer.company-information.service.gov.uk/

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const { observe, createRateManager } = (() => {
  const c = require('./companieshouse-collector');
  const { createRateManager } = require('./ch-client');
  return { observe: c.observe, createRateManager };
})();

async function main() {
  const args = process.argv.slice(2);
  const apiKey = process.env.CH_API_KEY;
  if (!apiKey) { console.error('Set CH_API_KEY (free key from developer.company-information.service.gov.uk)'); process.exit(2); }

  const noDocs = args.includes('--no-docs');
  const disqIdx = args.indexOf('--disq');

  let request;
  if (disqIdx !== -1) {
    const spec = args[disqIdx + 1] || '';
    const [officerType, value] = spec.split('/');
    if (!value) { console.error('usage: --disq natural/<officer_id>  (or corporate/<officer_id>)'); process.exit(2); }
    request = { anchor: { type: 'disqualified-officer', value, officerType }, mode: 'targeted-snapshot' };
  } else {
    const companyNumber = args.find(a => !a.startsWith('--'));
    if (!companyNumber) { console.error('usage: run-example.js <company_number> [--no-docs]'); process.exit(2); }
    request = {
      anchor: { type: 'company', value: companyNumber },
      scope: {
        objects: ['EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-07', 'EO-08', 'EO-09'],
        includeDocuments: !noDocs,
      },
      mode: 'targeted-snapshot',
    };
  }

  const rateManager = createRateManager();
  const started = Date.now();
  const result = await observe(request, { apiKey, rateManager });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n=== Coverage ===');
  console.log(JSON.stringify(result.coverage, null, 2));
  console.log('\n=== Metrics ===');
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log('\n=== Emitted objects ===');
  for (const e of result.emitted) {
    const id = e.observationIdentity.objectIdentity;
    console.log(`  ${e.objectType} [${e.emissionClass}] id=${JSON.stringify(idShort(id))} hash=${e.observationIdentity.contentHash.slice(0, 19)}…`);
  }
  if (result.crossLinks.length) {
    console.log('\n=== Recorded cross-links (NOT traversed) ===');
    for (const x of result.crossLinks) console.log(`  ${x.link.type}=${x.link.value} from ${x.from.objectType}:${x.from.objectId ?? ''}`);
  }
  if (result.nonObservations.length) {
    console.log('\n=== Non-observations ===');
    for (const x of result.nonObservations) console.log(`  ${x.objectType}: ${x.reason}`);
  }
  console.log(`\nDone in ${elapsed}s — ${result.metrics.emitted} emitted, ${result.metrics.observedAbsences} observed-absences, ${result.metrics.nonObservations} non-observations.`);
}

function idShort(id) {
  return id.objectId ?? id.company_number ?? id.document_id ?? id.officer_id ?? id;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
