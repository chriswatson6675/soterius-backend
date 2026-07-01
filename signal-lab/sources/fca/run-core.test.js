'use strict';

// run-core.test.js — offline verification of the Core collection profile.
//
// Drives collectCoreFirm() end-to-end through a STUB transport (no network, no
// credentials). Proves: (a) Core requests ONLY firm + firm.address; (b) no mega
// endpoint and no mega sizing probe is ever requested; (c) the full constitutional
// pipeline (preserve → manifest → extract → provenance → integrity → reports) runs
// and integrity verifies.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectCoreFirm, CORE_SCOPE } = require('./run-core');

const FRN = '123456';

// Faithful stub of fca-client's transport contract (_request → fetchFn):
// returns { statusCode, headers, bodyBuffer }. Records every URL requested.
function makeStubFetch(requested) {
  return async function _fetch(url /*, o */) {
    requested.push(url);
    let payload;
    if (/\/Address(\?|$)/.test(url)) {
      payload = { Status: 'FSR-API-02-02-00', ResultInfo: {}, Data: [
        { 'Website Address': 'www.example-firm.co.uk', 'Address Line 1': '1 Test Street', Town: 'Testville', Country: 'UNITED KINGDOM', 'Address Type': 'Principal Place of Business' },
      ] };
    } else { // /Firm/{frn}
      payload = { Status: 'FSR-API-01-01-00', ResultInfo: {}, Data: [
        { 'Organisation Name': 'Example Firm Ltd', FRN: FRN, 'Companies House Number': '01234567', Status: 'Authorised' },
      ] };
    }
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(payload)) };
  };
}

test('Core profile: collects only firm + firm.address, no mega, no probe, full pipeline verifies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-core-'));
  const requested = [];
  const config = { baseUrl: 'https://register.example.test/services/V0.1', email: 'observer@example.test', apiKey: 'TEST_KEY', apiVersion: 'V0.1' };

  try {
    const result = await collectCoreFirm(config, FRN, 'Example Firm Ltd', { root, _fetch: makeStubFetch(requested) });

    // (a) Exactly the Core scope was executed, in canonical order.
    assert.deepStrictEqual(CORE_SCOPE, ['firm', 'firm.address']);
    assert.deepStrictEqual(result.order, ['firm', 'firm.address']);

    // (b) Exactly two HTTP requests were made: /Firm/{frn} and /Firm/{frn}/Address.
    assert.strictEqual(requested.length, 2, `expected 2 requests, got ${requested.length}: ${requested.join(' , ')}`);
    assert.ok(requested.some((u) => /\/Firm\/123456$/.test(u)), 'firm endpoint requested');
    assert.ok(requested.some((u) => /\/Firm\/123456\/Address$/.test(u)), 'firm.address endpoint requested');

    // (c) No mega endpoint and NO mega sizing probe was ever requested.
    for (const forbidden of ['/CF', '/Individuals', '/Permissions', '/Requirements', '/AR', '/Passports', '/Waivers', '/Exclusions', '/DisciplinaryHistory', '/Regulators', '/Names']) {
      assert.ok(!requested.some((u) => u.includes(forbidden)), `Core must never request ${forbidden}`);
    }

    // (d) Manifest records the Core scope only.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, FRN, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.scope, ['firm', 'firm.address']);

    // (e) Raw + structured contain only the two Core artefacts (no mega files on disk).
    const rawFiles = fs.readdirSync(path.join(root, FRN, 'raw')).sort();
    assert.deepStrictEqual(rawFiles, ['firm.address.ndjson', 'firm.ndjson']);
    const structFiles = fs.readdirSync(path.join(root, FRN, 'structured')).sort();
    assert.deepStrictEqual(structFiles, ['firm.address.ndjson', 'firm.ndjson']);

    // (f) Provenance lineage + the three reports were produced.
    assert.ok(fs.existsSync(path.join(root, FRN, 'provenance', 'lineage.ndjson')), 'lineage written');
    for (const r of ['collection-report.json', 'coverage-report.json', 'health-report.json']) {
      assert.ok(fs.existsSync(path.join(root, FRN, 'reports', r)), `${r} written`);
    }

    // (g) Integrity verified every structured record (verified === total > 0).
    assert.ok(result.integrity.total > 0, 'structured records present');
    assert.ok(result.integrity.ok, 'integrity verified == total');
    assert.strictEqual(result.integrity.verified, result.integrity.total);
    assert.strictEqual(result.coverageComplete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
