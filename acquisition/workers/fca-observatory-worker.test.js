'use strict';

// fca-observatory-worker.test.js — one-cycle worker orchestration (offline, stubbed transport).
//
// Proves: a package is created; firms are processed exactly once; interruption resumes
// correctly; committed firms are skipped; package-level integrity runs; run-level
// reports are produced.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCollectionCycle, packageJsonPath, reportsDir, readPackage } = require('./fca-observatory-worker');
const { loadCommitted, committedFirmDir } = require('../../collection/sources/fca/firm-commit');
const { isSealed } = require('../../collection/sources/fca/package-seal');

function makeStubFetch(requested) {
  return async function _fetch(url) {
    requested.push(url);
    let payload;
    if (/\/Address(\?|$)/.test(url)) payload = { Status: 'FSR-API-02-02-00', ResultInfo: {}, Data: [{ 'Website Address': 'www.example-firm.co.uk', 'Address Line 1': '1 Test Street', Town: 'Testville', Country: 'UNITED KINGDOM' }] };
    else if (/\/Permissions(\?|$)/.test(url)) payload = { Status: 'FSR-API-02-03-00', ResultInfo: {}, Data: { 'Accepting Deposits': [{ 'Accepting Deposits': ['1'] }] } };
    else payload = { Status: 'FSR-API-01-01-00', ResultInfo: {}, Data: [{ 'Organisation Name': 'Example Firm Ltd', 'Companies House Number': '01234567', Status: 'Authorised' }] };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(payload)) };
  };
}

const CONFIG = { baseUrl: 'https://register.example.test/services/V0.1', email: 'observer@example.test', apiKey: 'TEST_KEY', apiVersion: 'V0.1' };
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fca-obs-')); }
function lines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0; }
function cohortOf(n) { return Array.from({ length: n }, (_, i) => ({ frn: String(100001 + i), name: `Firm ${i + 1}` })); }

test('one full cycle: creates package, commits every firm once, verifies integrity, writes reports, then SEALS', async () => {
  const runRoot = tmpRoot(); const requested = [];
  try {
    const cohort = cohortOf(3);
    const r = await runCollectionCycle({ config: CONFIG, runRoot, cohort, packageId: 'pkg-1', _fetch: makeStubFetch(requested) });

    // package created + SEALED (authoritative)
    const pkgDir = path.join(runRoot, 'pkg-1');
    assert.ok(fs.existsSync(packageJsonPath(pkgDir)), 'package descriptor created');
    assert.strictEqual(r.status, 'sealed');
    assert.strictEqual(r.sealed, true);
    assert.strictEqual(readPackage(pkgDir).status, 'sealed');
    assert.ok(isSealed(pkgDir), 'SEALED marker written');
    assert.ok(fs.existsSync(path.join(pkgDir, 'manifest.json')), 'run-level manifest written');

    // every firm processed exactly once
    assert.strictEqual(r.committed, 3);
    assert.strictEqual(r.skipped, 0);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(requested.length, 6, '3 firms × (firm + firm.address)');
    assert.strictEqual(loadCommitted(pkgDir).size, 3, 'ledger has 3 firms');

    // package-level integrity executed successfully (the seal precondition)
    assert.ok(r.integrity.ok, 'package integrity ok');
    assert.strictEqual(r.integrity.firms, 3);
    assert.strictEqual(r.integrity.firmsOk, 3);
    assert.ok(r.integrity.total > 0 && r.integrity.verified === r.integrity.total);

    // run-level reports produced (also a seal precondition)
    for (const rep of ['collection-report.json', 'coverage-report.json', 'health-report.json']) {
      assert.ok(fs.existsSync(path.join(reportsDir(pkgDir), rep)), `${rep} produced`);
    }
    const coverage = JSON.parse(fs.readFileSync(path.join(reportsDir(pkgDir), 'coverage-report.json'), 'utf8'));
    assert.strictEqual(coverage.coverageComplete, true);
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }); }
});

test('registry profile collects firm + firm.address + firm.permissions (3 endpoints/firm), seals, integrity ok', async () => {
  const runRoot = tmpRoot(); const requested = [];
  try {
    const cohort = cohortOf(2);
    const r = await runCollectionCycle({ config: CONFIG, runRoot, cohort, packageId: 'reg-1', profile: 'registry', _fetch: makeStubFetch(requested) });

    const pkgDir = path.join(runRoot, 'reg-1');
    assert.strictEqual(readPackage(pkgDir).profile, 'registry', 'package records registry profile');
    assert.deepStrictEqual(readPackage(pkgDir).scope, ['firm', 'firm.address', 'firm.permissions']);
    assert.strictEqual(r.status, 'sealed');
    assert.strictEqual(r.committed, 2);
    assert.strictEqual(requested.length, 6, '2 firms × 3 endpoints');
    assert.ok(requested.some((u) => /\/Permissions$/.test(u)), 'permissions endpoint collected');

    // each committed firm preserves exactly the three registry artefacts
    for (const c of cohort) {
      const raw = fs.readdirSync(path.join(committedFirmDir(pkgDir, c.frn), 'raw')).sort();
      assert.deepStrictEqual(raw, ['firm.address.ndjson', 'firm.ndjson', 'firm.permissions.ndjson']);
    }
    assert.ok(r.integrity.ok && r.integrity.firms === 2);
    assert.ok(isSealed(pkgDir));
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }); }
});

test('re-running a sealed package does not reseal or reprocess it (immutable, no new requests)', async () => {
  const runRoot = tmpRoot(); const requested = [];
  try {
    const cohort = cohortOf(3);
    const first = await runCollectionCycle({ config: CONFIG, runRoot, cohort, packageId: 'pkg-2', _fetch: makeStubFetch(requested) });
    assert.strictEqual(first.status, 'sealed');
    assert.strictEqual(requested.length, 6);
    const pkgDir = path.join(runRoot, 'pkg-2');
    const sealedBytes = fs.readFileSync(path.join(pkgDir, 'SEALED'), 'utf8');

    const again = await runCollectionCycle({ config: CONFIG, runRoot, cohort, packageId: 'pkg-2', _fetch: makeStubFetch(requested) });
    assert.strictEqual(again.status, 'sealed');
    assert.strictEqual(again.alreadySealed, true);
    assert.strictEqual(again.committed, 0);
    assert.strictEqual(again.skipped, 0, 'sealed package is not reprocessed');
    assert.strictEqual(requested.length, 6, 'no new requests against a sealed package');

    assert.strictEqual(loadCommitted(pkgDir).size, 3, 'ledger unchanged');
    assert.strictEqual(fs.readFileSync(path.join(pkgDir, 'SEALED'), 'utf8'), sealedBytes, 'SEALED unchanged (not resealed)');
    for (const c of cohort) assert.strictEqual(lines(path.join(committedFirmDir(pkgDir, c.frn), 'raw', 'firm.ndjson')), 1, 'no duplicate evidence');
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }); }
});

test('interruption mid-cycle preserves the package + ledger and resumes from the first uncommitted firm', async () => {
  const runRoot = tmpRoot(); const requested = [];
  try {
    const cohort = cohortOf(4);

    // Interrupt: throw from the progress hook after the 2nd firm commits (models a crash).
    let interrupted = null;
    await assert.rejects(
      runCollectionCycle({
        config: CONFIG, runRoot, cohort, packageId: 'pkg-3', _fetch: makeStubFetch(requested),
        onProgress: (p) => { if (p.index === 1) { interrupted = p; throw new Error('SIMULATED INTERRUPTION'); } },
      }),
      /SIMULATED INTERRUPTION/,
    );

    const pkgDir = path.join(runRoot, 'pkg-3');
    assert.ok(fs.existsSync(packageJsonPath(pkgDir)), 'partial package preserved');
    assert.strictEqual(readPackage(pkgDir).status, 'collecting', 'package still in-progress (not finalized)');
    assert.strictEqual(loadCommitted(pkgDir).size, 2, 'ledger preserved with the 2 committed firms');
    const requestsAtInterrupt = requested.length; // 2 firms × 2 = 4

    // Resume by discovery (no packageId): the open package is found and continued.
    const r = await runCollectionCycle({ config: CONFIG, runRoot, cohort, _fetch: makeStubFetch(requested) });
    assert.strictEqual(r.packageId, 'pkg-3', 'resumed the same in-progress package');
    assert.strictEqual(r.skipped, 2, 'the 2 already-committed firms were skipped');
    assert.strictEqual(r.committed, 2, 'the 2 remaining firms were collected');
    assert.strictEqual(requested.length, requestsAtInterrupt + 4, 'only the uncommitted firms were recollected');

    // exactly-once across the whole run: all 4 firms, single-copy evidence, integrity ok
    assert.strictEqual(loadCommitted(pkgDir).size, 4);
    for (const c of cohort) assert.strictEqual(lines(path.join(committedFirmDir(pkgDir, c.frn), 'raw', 'firm.ndjson')), 1, 'no duplicate evidence after resume');
    assert.ok(r.integrity.ok && r.integrity.firms === 4);
    assert.strictEqual(r.status, 'sealed', 'completed resumed cycle seals');
    assert.strictEqual(readPackage(pkgDir).status, 'sealed');
    assert.ok(isSealed(pkgDir), 'SEALED marker written after resume completes the run');
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }); }
});
