'use strict';

// Sprint 10 — canonical Organisation Resolution Service (resolveOrganisationByDomain).
// Runs against a controlled Repository Authority dataset (temp ndjson pointed at
// via env), so every outcome and scenario is deterministic and hermetic. The
// dataset shapes mirror Repository Authority's real domains.ndjson /
// organisations.ndjson, including representative remediation-programme cases
// (approved replacement domain, merger/acquisition into a surviving id, dissolved
// company, contested domain).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolve = require('./resolve');
const { RESOLUTION_OUTCOME: R } = resolve;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-resolve-'));
const orgPath = path.join(dir, 'organisations.ndjson');
const domPath = path.join(dir, 'domains.ndjson');

const ORGS = [
  { organisationId: 'ORG-CLEAN', organisationName: 'Clean Co LLP', identifiers: {}, companiesHouse: { companyStatus: 'active' } },
  { organisationId: 'ORG-SURVIVOR', organisationName: 'Survivor LLP', identifiers: {}, companiesHouse: { companyStatus: 'active' } },
  { organisationId: 'ORG-DISSOLVED', organisationName: 'Gone Ltd', identifiers: {}, companiesHouse: { companyStatus: 'dissolved' } },
  { organisationId: 'ORG-A', organisationName: 'Alpha LLP', identifiers: {}, companiesHouse: null },
  { organisationId: 'ORG-B', organisationName: 'Beta LLP', identifiers: {}, companiesHouse: null },
];

const V = { status: 'verified', source: 'sra-website', method: 'authoritative-registry-field', verificationDate: '2026-01-01T00:00:00.000Z', contested: false, competingOrganisationIds: [] };
const DOMAINS = [
  { domain: 'clean.co.uk', organisationId: 'ORG-CLEAN', ...V },                          // canonical
  { domain: 'clean-alias.co.uk', organisationId: 'ORG-CLEAN', ...V, source: 'fca-website' }, // alias: 2nd domain, same org
  { domain: 'newname.com', organisationId: 'ORG-SURVIVOR', ...V },                        // approved replacement (old domain absent below)
  { domain: 'acquired.com', organisationId: 'ORG-SURVIVOR', ...V, source: 'companies-house' }, // merger: acquired firm's domain → surviving id
  { domain: 'gone.co.uk', organisationId: 'ORG-DISSOLVED', ...V },                        // dissolved company (still resolves)
  { domain: 'contested.co.uk', organisationId: 'ORG-A', status: 'verified', contested: true, competingOrganisationIds: ['ORG-B'] }, // ambiguous
  { domain: 'candidate.co.uk', organisationId: 'ORG-CLEAN', status: 'candidate', contested: false, competingOrganisationIds: [] },  // unverified candidate
];

function writeDatasets(domains) {
  fs.writeFileSync(orgPath, ORGS.map(o => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(domPath, domains.map(d => JSON.stringify(d)).join('\n') + '\n');
  resolve.reload();
}

before(() => {
  process.env.ORGANISATION_DATASET_PATH = orgPath;
  process.env.AUTHORITY_DOMAINS_PATH = domPath;
  writeDatasets(DOMAINS);
});
after(() => {
  delete process.env.ORGANISATION_DATASET_PATH;
  delete process.env.AUTHORITY_DOMAINS_PATH;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const rd = (d) => resolve.resolveOrganisationByDomain(d);

describe('RESOLVED — a single verified, uncontested claim', () => {
  test('canonical domain resolves with provenance', () => {
    const r = rd('clean.co.uk');
    assert.equal(r.outcome, R.RESOLVED);
    assert.equal(r.organisationId, 'ORG-CLEAN');
    assert.equal(r.provenance.reason, 'VERIFIED_DOMAIN_CLAIM');
    assert.equal(r.provenance.source, 'sra-website');
    assert.equal(r.provenance.method, 'authoritative-registry-field');
    assert.ok(r.provenance.authorityVersion);
  });

  test('normalises scheme / www / case before resolving', () => {
    assert.equal(rd('https://WWW.Clean.co.uk/path').organisationId, 'ORG-CLEAN');
  });

  test('alias — a second verified domain of the same organisation', () => {
    assert.equal(rd('clean-alias.co.uk').organisationId, 'ORG-CLEAN');
  });

  test('approved replacement domain resolves; the retired domain is simply NOT_FOUND', () => {
    assert.equal(rd('newname.com').organisationId, 'ORG-SURVIVOR');
    assert.equal(rd('oldname.com').outcome, R.NOT_FOUND);   // retired/never-claimed
  });

  test('merger/acquisition — acquired firm domain resolves to the surviving id', () => {
    assert.equal(rd('acquired.com').organisationId, 'ORG-SURVIVOR');
  });

  test('dissolved organisation still resolves, with dissolution surfaced in provenance', () => {
    const r = rd('gone.co.uk');
    assert.equal(r.outcome, R.RESOLVED);
    assert.equal(r.organisationId, 'ORG-DISSOLVED');
    assert.equal(r.provenance.lifecycleStatus, 'dissolved');
    assert.equal(r.provenance.dissolved, true);
  });
});

describe('NOT_FOUND — no authoritative claim (never guessed)', () => {
  test('unknown domain', () => {
    const r = rd('nobody-knows-this.example');
    assert.equal(r.outcome, R.NOT_FOUND);
    assert.equal(r.organisationId, null);
    assert.equal(r.provenance.reason, 'NO_VERIFIED_DOMAIN_CLAIM');
  });

  test('an unverified candidate does NOT resolve — but is disclosed', () => {
    const r = rd('candidate.co.uk');
    assert.equal(r.outcome, R.NOT_FOUND);
    assert.equal(r.organisationId, null);
    assert.equal(r.provenance.reason, 'UNVERIFIED_CANDIDATE_ONLY');
    assert.equal(r.provenance.candidateOrganisationId, 'ORG-CLEAN');
  });
});

describe('AMBIGUOUS — more than one claimant, never assigned', () => {
  test('contested domain returns candidates, no organisationId', () => {
    const r = rd('contested.co.uk');
    assert.equal(r.outcome, R.AMBIGUOUS);
    assert.equal(r.organisationId, null);
    assert.deepEqual(r.candidates.sort(), ['ORG-A', 'ORG-B']);
    assert.equal(r.provenance.reason, 'CONTESTED_DOMAIN');
  });
});

describe('INVALID — the input is not a resolvable domain', () => {
  for (const bad of ['', 'localhost', 'a b.com', null, undefined, 'http://', '.']) {
    test(`${JSON.stringify(bad)} → INVALID`, () => {
      const r = rd(bad);
      assert.equal(r.outcome, R.INVALID);
      assert.equal(r.organisationId, null);
      assert.equal(r.provenance.reason, 'INPUT_NOT_A_DOMAIN');
    });
  }
});

describe('invariants', () => {
  test('every outcome carries provenance with a reason', () => {
    for (const d of ['clean.co.uk', 'unknown.example', 'contested.co.uk', '']) {
      assert.ok(rd(d).provenance && rd(d).provenance.reason, `provenance for ${d}`);
    }
  });

  test('no non-RESOLVED outcome ever carries an organisationId', () => {
    for (const d of ['unknown.example', 'contested.co.uk', 'candidate.co.uk', '']) {
      assert.equal(rd(d).organisationId, null);
    }
  });

  test('deterministic — same input yields a deep-equal result', () => {
    assert.deepEqual(rd('clean.co.uk'), rd('clean.co.uk'));
    assert.deepEqual(rd('contested.co.uk'), rd('contested.co.uk'));
  });
});

describe('Repository Authority changes immediately affect future resolution', () => {
  test('a domain is NOT_FOUND, then RESOLVED after RA is updated and reloaded', () => {
    assert.equal(rd('brandnew.com').outcome, R.NOT_FOUND);

    // Simulate an approved Repository Authority update: a new verified claim.
    writeDatasets([...DOMAINS, { domain: 'brandnew.com', organisationId: 'ORG-CLEAN', ...V }]);

    const r = rd('brandnew.com');
    assert.equal(r.outcome, R.RESOLVED);
    assert.equal(r.organisationId, 'ORG-CLEAN');

    // restore for any later tests
    writeDatasets(DOMAINS);
  });
});
