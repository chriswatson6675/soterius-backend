'use strict';

/*
 * reacquire-sra.js — one-shot live re-acquisition of the full SRA register.
 *
 * Operational runner ONLY. It changes NOTHING in the frozen SRA Snapshot Collector
 * (`collection/sources/sra/*`, `sra-snapshot-collector/0.1.0`) — it composes the
 * exact same `collectSnapshot` pipeline the Railway worker uses, from the local
 * environment, to reproduce a sealed Collection Package after the original
 * `live-003` package was lost with its Railway run volume.
 *
 * Produces: runs/<runId>/ (raw/snapshot.json + manifest + structured + provenance + SEALED).
 *
 * Run: node backend/authority/reacquire-sra.js
 * Env (backend/.env): SRAP_API_KEY (production APIM subscription key) + SRA_URL
 * (the GetAll endpoint; its origin is used as SRA_BASE_URL).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { collectSnapshot } = require('../collection/sources/sra/run-snapshot');

// Map the existing (differently-named) credentials onto the collector's contract.
// The collector reads { baseUrl, subscriptionKey }; the .env stores the key as
// SRAP_API_KEY (production) and the full GetAll URL as SRA_URL.
const rawUrl = process.env.SRA_BASE_URL || process.env.SRA_URL;
if (!rawUrl) { console.error('Missing SRA_URL / SRA_BASE_URL in backend/.env'); process.exit(1); }
const subscriptionKey = process.env.SRA_SUBSCRIPTION_KEY || process.env.SRAP_API_KEY;
if (!subscriptionKey) { console.error('Missing SRAP_API_KEY / SRA_SUBSCRIPTION_KEY in backend/.env'); process.exit(1); }

const baseUrl = new URL(rawUrl).origin; // strip any /datashare/... path; datasetPath is appended by the source
const runRoot = process.env.SRA_RUN_ROOT || path.join(__dirname, '..', 'collection', 'sources', 'sra', 'runs');
const runId = process.env.SRA_RUN_ID || 'live-004';

console.error(`SRA re-acquisition → base ${baseUrl} | runRoot ${runRoot} | runId ${runId}`);
console.error('(subscription key present, not printed)\n');

(async () => {
  const result = await collectSnapshot({
    config: { baseUrl, subscriptionKey },
    runRoot,
    runId,
  });

  if (!result.ok) {
    console.error(`\nRE-ACQUISITION FAILED at stage "${result.failedStage}": ${result.error}`);
    process.exit(2);
  }

  const dir = result.dir;
  const rawPath = path.join(dir, 'raw', 'snapshot.json');
  const body = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const orgs = Array.isArray(body.Organisations) ? body.Organisations : [];
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex');

  console.error('\n════════════════ SRA RE-ACQUISITION SEALED ════════════════');
  console.error(`  runId               ${result.runId}`);
  console.error(`  package dir         ${dir}`);
  console.error(`  raw snapshot.json   ${fs.statSync(rawPath).size} bytes`);
  console.error(`  raw SHA-256         ${sha256}`);
  console.error(`  Count (payload)     ${body.Count}`);
  console.error(`  Organisations       ${orgs.length}`);
  console.error(`  integrity records   ${result.integrity ? result.integrity.records : '?'}`);
  console.error('═══════════════════════════════════════════════════════════');
  console.error('\nCompare vs recorded live-003 manifest:');
  console.error('  live-003 SHA-256    297e6de58757944b78d607071fac067b9b34aecc2266c74c08f54ae9bbf4e2c0');
  console.error('  live-003 orgs       25078  (14088 no-website, 636 invalid-domain, 10354 eligible)');
})().catch((e) => { console.error(e); process.exit(1); });
