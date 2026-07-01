'use strict';

// firm-commit.test.js — exactly-once firm commit verification (offline, stubbed transport).
//
// Proves, against a real collection pipeline driven by a stub fetch:
//   1. a committed firm cannot be committed twice (idempotent skip);
//   2. interruption BEFORE commit causes recollection;
//   3. interruption AFTER commit causes the firm to be skipped;
//   4. duplicate evidence cannot be appended to the package (incl. the orphan window);
//   5. integrity verification continues to pass on committed evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyRun } = require('./provenance');
const {
  collectAndCommitFirm, collectFirmIntoStaging, loadCommitted,
  committedFirmDir, stagedFirmDir, firmsDir, ledgerPath,
} = require('./firm-commit');

const FRN = '123456';

// Faithful stub of fca-client's transport contract; records every URL requested.
function makeStubFetch(requested) {
  return async function _fetch(url) {
    requested.push(url);
    const payload = /\/Address(\?|$)/.test(url)
      ? { Status: 'FSR-API-02-02-00', ResultInfo: {}, Data: [{ 'Website Address': 'www.example-firm.co.uk', 'Address Line 1': '1 Test Street', Town: 'Testville', Country: 'UNITED KINGDOM', 'Address Type': 'Principal Place of Business' }] }
      : { Status: 'FSR-API-01-01-00', ResultInfo: {}, Data: [{ 'Organisation Name': 'Example Firm Ltd', FRN, 'Companies House Number': '01234567', Status: 'Authorised' }] };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(payload)) };
  };
}

const CONFIG = { baseUrl: 'https://register.example.test/services/V0.1', email: 'observer@example.test', apiKey: 'TEST_KEY', apiVersion: 'V0.1' };
function tmpPkg() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fca-pkg-')); }
function lines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0; }
function rawLines(pkgRoot, ep) { return lines(path.join(committedFirmDir(pkgRoot, FRN), 'raw', `${ep}.ndjson`)); }

test('happy path: firm commits once, integrity passes, evidence single-copy', async () => {
  const pkg = tmpPkg(); const requested = [];
  try {
    const r = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(r.status, 'committed');
    assert.strictEqual(requested.length, 2, 'exactly firm + firm.address requested');
    assert.strictEqual(lines(ledgerPath(pkg)), 1, 'ledger has exactly one entry');
    assert.strictEqual(rawLines(pkg, 'firm'), 1, 'firm raw single line');
    assert.strictEqual(rawLines(pkg, 'firm.address'), 1, 'firm.address raw single line');
    // (5) integrity verification continues to pass on the committed evidence.
    const integ = verifyRun(committedFirmDir(pkg, FRN));
    assert.ok(integ.total > 0 && integ.verified === integ.total, 'committed evidence verifies');
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});

test('a committed firm cannot be committed twice (idempotent skip, no duplicate, no new requests)', async () => {
  const pkg = tmpPkg(); const requested = [];
  try {
    const first = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(first.status, 'committed');
    assert.strictEqual(requested.length, 2);

    const second = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(second.status, 'skipped');
    assert.strictEqual(second.reason, 'already-committed');

    assert.strictEqual(requested.length, 2, 'second attempt made NO requests (skipped before collection)');
    assert.strictEqual(lines(ledgerPath(pkg)), 1, 'ledger still exactly one entry');
    assert.strictEqual(rawLines(pkg, 'firm'), 1, 'no duplicate firm evidence appended');
    assert.strictEqual(rawLines(pkg, 'firm.address'), 1, 'no duplicate firm.address evidence appended');
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});

test('interruption BEFORE commit → firm is recollected on resume (not in ledger)', async () => {
  const pkg = tmpPkg(); const requested = [];
  try {
    // Simulate a crash after staging but before commit: stage only.
    await collectFirmIntoStaging(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.ok(fs.existsSync(stagedFirmDir(pkg, FRN)), 'staged evidence present');
    assert.ok(!fs.existsSync(committedFirmDir(pkg, FRN)), 'nothing committed to the package');
    assert.strictEqual(loadCommitted(pkg).has(FRN), false, 'firm absent from the ledger');
    assert.strictEqual(requested.length, 2, 'one staging collection so far');

    // Resume: the firm is not committed → it is recollected and then committed.
    const r = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(r.status, 'committed');
    assert.strictEqual(requested.length, 4, 'resume recollected the firm (2 more requests)');
    assert.strictEqual(lines(ledgerPath(pkg)), 1, 'committed exactly once');
    assert.strictEqual(rawLines(pkg, 'firm'), 1, 'single copy despite recollection');
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});

test('interruption AFTER commit → worker restart skips the firm', async () => {
  const pkg = tmpPkg(); const requested = [];
  try {
    await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    // A fresh entry-point call models a worker restart: state is read from the ledger
    // on disk, so the committed firm is skipped with no recollection.
    const afterRestart = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(afterRestart.status, 'skipped');
    assert.strictEqual(requested.length, 2, 'no recollection after restart');
    assert.strictEqual(lines(ledgerPath(pkg)), 1);
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});

test('orphan window (rename done, ledger not written) → orphan discarded, no duplicate', async () => {
  const pkg = tmpPkg(); const requested = [];
  try {
    // Simulate a crash between the atomic rename and the ledger append: produce a
    // committed dir with NO ledger entry, by hand.
    await collectFirmIntoStaging(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    fs.mkdirSync(firmsDir(pkg), { recursive: true });
    fs.renameSync(stagedFirmDir(pkg, FRN), committedFirmDir(pkg, FRN)); // rename happened; ledger append did NOT
    assert.ok(fs.existsSync(committedFirmDir(pkg, FRN)), 'orphan committed dir exists');
    assert.strictEqual(lines(ledgerPath(pkg)), 0, 'but it is NOT in the ledger (orphan)');
    assert.strictEqual(rawLines(pkg, 'firm'), 1);

    // Resume: orphan is not authoritative (absent from ledger) → discarded + recollected.
    const r = await collectAndCommitFirm(CONFIG, pkg, FRN, { _fetch: makeStubFetch(requested) });
    assert.strictEqual(r.status, 'committed');
    assert.strictEqual(lines(ledgerPath(pkg)), 1, 'committed exactly once');
    assert.strictEqual(rawLines(pkg, 'firm'), 1, 'orphan replaced, NOT accumulated → no duplicate');
    assert.strictEqual(rawLines(pkg, 'firm.address'), 1, 'no duplicate firm.address evidence');
    const integ = verifyRun(committedFirmDir(pkg, FRN));
    assert.ok(integ.total > 0 && integ.verified === integ.total, 'integrity still passes');
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});
