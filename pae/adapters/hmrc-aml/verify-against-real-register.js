'use strict';

// verify-against-real-register.js — a one-off, manually-run proof that this
// adapter transforms the actual HMRC AML Supervised Business Register export
// (datasets/hmrc-aml/Supervised_Business_Register.ods, ~67,900 rows) into
// canonical Organisation records end to end. Not part of `npm test` — the
// real file is large enough (173MB decompressed) that parsing it on every
// test run would be slow; index.test.js covers behaviour against small
// synthetic fixtures built to the same confirmed column shape. Run manually:
//   node backend/pae/adapters/hmrc-aml/verify-against-real-register.js

const fs = require('fs');
const path = require('path');
const adapter = require('./index');
const { runBatchAdapter, validateCanonicalRecord } = require('../../batch-adapter-contract');

async function main() {
  const filePath = path.join(__dirname, '..', '..', '..', '..', 'datasets', 'hmrc-aml', 'Supervised_Business_Register.ods');
  const buffer = fs.readFileSync(filePath);
  console.log(`read ${buffer.length} bytes from ${filePath}`);

  const startedAt = Date.now();
  const result = await runBatchAdapter(adapter, buffer, { sourceDate: new Date().toISOString().slice(0, 10) });
  console.log(`ran in ${Date.now() - startedAt}ms`);

  console.log({
    stage: result.stage,
    fatalError: result.fatalError,
    rowsParsed: result.rowsParsed,
    rowsRejected: result.rowsRejected,
    recordsEmitted: result.recordsEmitted,
  });

  if (result.fatalError) process.exit(1);

  const shapeErrors = result.records.flatMap((r, i) => validateCanonicalRecord(r, i));
  console.log(`canonical-shape violations among emitted records: ${shapeErrors.length}`);

  const anchored = result.records.filter((r) => r.hmrcAml).length;
  const withDomain = result.records.filter((r) => r.domainRaw).length;
  console.log(`records with a non-null MLR anchor: ${anchored}/${result.records.length}`);
  console.log(`records asserting a domain (must be 0): ${withDomain}`);

  console.log('sample records:');
  console.log(JSON.stringify(result.records.slice(0, 2), null, 2));
  console.log('sample rejections:');
  console.log(JSON.stringify(result.rejections.slice(0, 5), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
