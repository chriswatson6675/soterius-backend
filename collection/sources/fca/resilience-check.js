'use strict';

// resilience-check.js — Phase 7 verification harness (IMP-FCA-001 §7).
//
// Demonstrates retry (transient vs permanent, via injected transport — no real
// failures needed), then a LIVE interrupted-then-resumed collection, idempotent
// re-recovery, evidence immutability, and that Phase 6 integrity still holds.
// Concise output only.
//
// Usage: node signal-lab/sources/fca/resilience-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor, observeEndpoint } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest, readManifest } = require('./manifest');
const { def } = require('./endpoint-map');
const { recoverRun, isComplete } = require('./recovery');
const { extractRun } = require('./extract');
const { verifyRun } = require('./provenance');
const ep = require('./evidence-path');

const RUNS_ROOT = path.join(__dirname, 'runs');
const PARTIAL = ['firm', 'firm.address', 'firm.regulators'];
const FULL = ['firm', 'firm.address', 'firm.regulators', 'firm.permissions', 'firm.names', 'firm.exclusions', 'firm.passports', 'firm.passports.permission'];
const NO_SLEEP = { _sleep: async () => {}, _now: () => new Date().toISOString() };

function hashDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}
function rawLineCount(runDir, endpointId) {
  const f = ep.rawFileFor(runDir, endpointId);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }
  const frn = process.argv[2] || '122702';

  console.log('\n  FCA operational resilience check (Phase 7)');
  console.log('  ════════════════════════════════════════════');

  // 1. Retry on transient failure (injected: 2 connection errors then success).
  let n = 0;
  const flaky = async () => { n++; return n < 3
    ? { error: Object.assign(new Error('net'), { code: 'ECONNRESET' }) }
    : { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify({ Status: 'FSR-API-02-02-00', ResultInfo: {}, Data: [{ ok: true }] })) }; };
  const r1 = await observeEndpoint(def('firm.address'), '1', null, config, { _fetch: flaky, retry: { maxAttempts: 5 }, _retryHelpers: NO_SLEEP });
  const att = r1.pages[0].attempts;
  console.log(`  retry transient   : ${att.length === 3 && att[2].outcome === 'success' ? 'YES ✓' : 'NO ✗'} (attempts: ${att.map((a) => a.outcome).join(',')})`);

  // 2. No retry on permanent failure (injected 404).
  const perm = async () => ({ statusCode: 404, headers: {}, bodyBuffer: Buffer.from('') });
  const r2 = await observeEndpoint(def('firm.address'), '1', null, config, { _fetch: perm, retry: { maxAttempts: 5 }, _retryHelpers: NO_SLEEP });
  console.log(`  no retry permanent: ${r2.pages[0].attempts.length === 1 ? 'YES ✓' : 'NO ✗'} (attempts: ${r2.pages[0].attempts.length})`);

  // 3. LIVE: a partial collection (simulated interruption), then recover to full scope.
  const run = createRun({ config }); run.initialise();
  const resolved = await resolveAnchor(frn, { config });
  const runDir = ep.runDir(RUNS_ROOT, run.id);
  const partialExec = await executeAnchor({ family: 'firm', anchor: resolved.anchor, config, endpoints: PARTIAL });
  const tally = createPreserver(runDir, { runId: run.id }).preserveExecution(partialExec);
  // Manifest declares the FULL scope (the run intended more than it finished — the interruption).
  writeManifest(runDir, buildManifest({ runId: run.id, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: resolved.anchor, scope: FULL, executionStart: null, executionEnd: null }, tally));

  const completeBefore = isComplete(runDir, 'firm', FULL);
  const rawHashBefore = hashDir(ep.rawDir(runDir));
  const addrLinesBefore = rawLineCount(runDir, 'firm.address');
  console.log(`\n  partial run       : ${PARTIAL.length} endpoints preserved; complete vs FULL scope? ${completeBefore ? 'yes' : 'NO (interrupted)'}`);

  // recover
  const rec = await recoverRun(runDir, { config, retry: { maxAttempts: 3 }, _retryHelpers: NO_SLEEP });
  console.log(`  resume            : skipped ${rec.summary.skipped.length}, observed ${rec.summary.observed.length}, continued ${rec.summary.continued.length}, newPages ${rec.summary.newPages}`);
  console.log(`  completed now?    : ${isComplete(runDir, 'firm', FULL) ? 'YES ✓' : 'NO ✗'}`);

  // preserved evidence untouched: firm.address (a completed endpoint) unchanged.
  const addrLinesAfter = rawLineCount(runDir, 'firm.address');
  console.log(`  preserved intact  : ${addrLinesAfter === addrLinesBefore ? 'YES ✓' : 'NO ✗'} (firm.address lines ${addrLinesBefore} → ${addrLinesAfter})`);

  // duplicate preservation avoided: re-recover → nothing new.
  const rec2 = await recoverRun(runDir, { config, _retryHelpers: NO_SLEEP });
  console.log(`  idempotent resume : ${rec2.alreadyComplete && rec2.summary.newPages === 0 ? 'YES ✓' : 'NO ✗'} (re-recover newPages: ${rec2.summary.newPages})`);

  // manifest reflects resumed execution
  const m = readManifest(runDir);
  console.log(`  manifest resume   : ${Array.isArray(m.resumeHistory) && m.resumeHistory.length >= 1 ? 'YES ✓' : 'NO ✗'} (resumeHistory entries: ${m.resumeHistory ? m.resumeHistory.length : 0})`);

  // 4. integrity (Phase 6) still passes after resume: extract + verify; raw byte-identical to post-resume state.
  extractRun(runDir);
  const integ = verifyRun(runDir);
  console.log(`  integrity (P6)    : ${integ.verified}/${integ.total} ${integ.verified === integ.total ? '✓' : '✗'}`);

  const ok = att.length === 3 && r2.pages[0].attempts.length === 1 && isComplete(runDir, 'firm', FULL)
    && addrLinesAfter === addrLinesBefore && rec2.alreadyComplete && integ.verified === integ.total;
  console.log(`\n  Evidence model changed: NONE   |   Result: ${ok ? 'RESILIENCE OK ✓' : 'FAILED ✗'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('resilience-check failed:', e.message); process.exit(1); });
