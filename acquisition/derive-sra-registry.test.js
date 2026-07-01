'use strict';

// derive-sra-registry.test.js — unit tests for the SRA Organisation Registry builder.
// Pure transforms + derivation/validation over a tiny in-memory Collection Package.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normaliseDomain, isValidDomain, extractWebsite, derive, validate } = require('./derive-sra-registry');

test('normaliseDomain strips scheme/www/path and lowercases (FCA-consistent)', () => {
  assert.strictEqual(normaliseDomain('https://www.Example.com/path?q=1'), 'example.com');
  assert.strictEqual(normaliseDomain('HTTP://Foo.CO.UK'), 'foo.co.uk');
  assert.strictEqual(normaliseDomain('bar.example'), 'bar.example');
  assert.strictEqual(normaliseDomain('   '), null);
  assert.strictEqual(normaliseDomain(null), null);
});

test('isValidDomain accepts dotted hostnames, rejects non-domains', () => {
  assert.ok(isValidDomain('example.com'));
  assert.ok(isValidDomain('a.b.co.uk'));
  assert.ok(!isValidDomain('localhost'));   // no dot
  assert.ok(!isValidDomain('tbc'));          // no dot
  assert.ok(!isValidDomain(''));
  assert.ok(!isValidDomain('-bad.com'));     // invalid label
});

test('extractWebsite prefers org Websites, falls back to first office Website', () => {
  assert.strictEqual(extractWebsite({ Websites: 'org.example', Offices: [{ Website: 'off.example' }] }), 'org.example');
  assert.strictEqual(extractWebsite({ Websites: '', Offices: [{ Website: null }, { Website: 'off.example' }] }), 'off.example');
  assert.strictEqual(extractWebsite({ Websites: null, Offices: [] }), '');
});

function fixturePackage(orgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-reg-fix-'));
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw', 'snapshot.json'), JSON.stringify({ Count: orgs.length, Organisations: orgs }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    runId: 'fix', collectorVersion: 'x', sourceAuthority: 'Solicitors Regulation Authority',
    collectionCompletedAt: '2026-06-29T00:00:00Z', segments: [{ file: 'snapshot.json', sha256: 'deadbeef' }],
  }));
  return dir;
}

test('derive classifies eligible vs excluded and balances accounting', () => {
  const dir = fixturePackage([
    { SraNumber: 1, PracticeName: 'A Ltd', CompanyRegNo: '123', Websites: 'https://www.a.example/x', Offices: [] }, // eligible
    { SraNumber: 2, PracticeName: 'B', Websites: '', Offices: [{ Website: 'b.example' }] },                          // eligible (office)
    { SraNumber: 3, PracticeName: 'C', Websites: null, Offices: [{ Website: null }] },                               // no-website
    { SraNumber: 4, PracticeName: 'D', Websites: 'tbc', Offices: [] },                                               // invalid-domain
    { SraNumber: 5, PracticeName: 'E', CompanyRegNo: '', Websites: 'https://www.a.example/', Offices: [] },          // eligible, dup domain
  ]);
  const { orgsTotal, records, excluded } = derive(dir);

  assert.strictEqual(orgsTotal, 5);
  assert.strictEqual(records.length, 3);
  assert.deepStrictEqual(excluded, { 'no-website': 1, 'malformed-website': 0, 'invalid-domain': 1 });
  assert.strictEqual(records.length + Object.values(excluded).reduce((a, b) => a + b, 0), orgsTotal); // balanced

  const r1 = records[0];
  assert.deepStrictEqual(r1, { sraNumber: 1, companyNumber: '123', firmName: 'A Ltd', website: 'https://www.a.example/x', domain: 'a.example', last_scanned: null, persistedAt: '2026-06-29T00:00:00Z' });
  assert.strictEqual(records[1].domain, 'b.example');
  assert.strictEqual(records[2].companyNumber, null, 'empty CompanyRegNo → null');
});

test('validate detects shared domains and confirms identifier uniqueness', () => {
  const dir = fixturePackage([
    { SraNumber: 1, PracticeName: 'A', Websites: 'a.example', Offices: [] },
    { SraNumber: 2, PracticeName: 'B', Websites: 'a.example', Offices: [] },
    { SraNumber: 3, PracticeName: 'C', Websites: 'c.example', Offices: [] },
  ]);
  const { records } = derive(dir);
  const v = validate(records);
  assert.strictEqual(v.distinctDomains, 2);
  assert.strictEqual(v.duplicateDomainGroups, 1);
  assert.strictEqual(v.organisationsSharingADomain, 2);
  assert.strictEqual(v.duplicateIdentifierGroups, 0);
  assert.strictEqual(v.recordsMissingIdentifier, 0);
});
