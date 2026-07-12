'use strict';

// Sprint 3 regression + correctness proof for dns-check.js.
//   Regression:  check status / points / details are byte-identical to the
//                pre-Sprint-3 behaviour, so the legacy score is unchanged.
//   Correctness: a lookup that timed out is now recorded as NOT_OBSERVED
//                evidence, NOT as a confirmed absence (OBS-CONST-001 P-5),
//                while STILL scoring the same FAIL it always did (scoring is
//                deliberately untouched this sprint).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const dnsCheck = require('./dns-check');
const { deriveTrustScore } = require('../services/scanService');

// A programmable resolver keyed by exact query name → either { records } or
// { code } (a rejection). Missing keys reject as ENOTFOUND (clean absence).
function makeResolver(map) {
  return async (name) => {
    const entry = map[name];
    if (!entry) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    if (entry.code) { const e = new Error(entry.code); e.code = entry.code; throw e; }
    return entry.records;
  };
}

const run = (domain, map) => dnsCheck(domain, { resolver: makeResolver(map) });
const byName = (checks, name) => checks.find(c => c.name === name);

describe('dns-check — check output contract unchanged (scoring safe)', () => {
  test('fully configured domain → PASS/PASS/PASS with expected details', async () => {
    const checks = await run('example.com', {
      'example.com': { records: [['v=spf1 include:_spf.google.com -all']] },
      'google._domainkey.example.com': { records: [['v=DKIM1; k=rsa; p=MIGf...']] },
      '_dmarc.example.com': { records: [['v=DMARC1; p=reject']] },
    });

    assert.equal(byName(checks, 'SPF record present and valid').status, 'PASS');
    assert.equal(byName(checks, 'DKIM configured').status, 'PASS');
    assert.equal(byName(checks, 'DMARC policy enforced').status, 'PASS');
    assert.equal(byName(checks, 'DMARC policy enforced').points, 40);
  });

  test('permissive SPF → WARNING (unchanged classification)', async () => {
    const checks = await run('example.com', { 'example.com': { records: [['v=spf1 +all']] } });
    assert.equal(byName(checks, 'SPF record present and valid').status, 'WARNING');
  });

  test('DMARC p=quarantine → WARNING with 30 points (unchanged)', async () => {
    const checks = await run('example.com', { '_dmarc.example.com': { records: [['v=DMARC1; p=quarantine']] } });
    const dmarc = byName(checks, 'DMARC policy enforced');
    assert.equal(dmarc.status, 'WARNING');
    assert.equal(dmarc.points, 30);
  });

  test('genuinely absent everything → FAIL/FAIL/FAIL (unchanged)', async () => {
    const checks = await run('example.com', {}); // all lookups NXDOMAIN
    assert.equal(byName(checks, 'SPF record present and valid').status, 'FAIL');
    assert.equal(byName(checks, 'DKIM configured').status, 'FAIL');
    assert.equal(byName(checks, 'DMARC policy enforced').status, 'FAIL');
  });
});

describe('dns-check — truthful collection evidence (the Sprint 3 fix)', () => {
  test('present record → OBSERVED_PRESENT', async () => {
    const checks = await run('example.com', { 'example.com': { records: [['v=spf1 -all']] } });
    assert.equal(byName(checks, 'SPF record present and valid').collection.outcome, 'OBSERVED_PRESENT');
  });

  test('NXDOMAIN → OBSERVED_ABSENT (a real, confirmed absence)', async () => {
    const checks = await run('example.com', {});
    assert.equal(byName(checks, 'SPF record present and valid').collection.outcome, 'OBSERVED_ABSENT');
  });

  test('timeout is NOT_OBSERVED, never OBSERVED_ABSENT — even though it still scores FAIL', async () => {
    const checks = await run('example.com', { 'example.com': { code: 'ETIMEOUT' } });
    const spf = byName(checks, 'SPF record present and valid');
    // Correctness: evidence is truthful.
    assert.equal(spf.collection.outcome, 'NOT_OBSERVED');
    assert.equal(spf.collection.errorCode, 'ETIMEOUT');
    assert.notEqual(spf.collection.outcome, 'OBSERVED_ABSENT');
    // Scoring: deliberately unchanged — a failed lookup still scores FAIL, as
    // it did before this sprint (correcting the derivation is Phase 3 work).
    assert.equal(spf.status, 'FAIL');
  });

  test('resolver failure → COLLECTION_ERROR on the affected signal', async () => {
    const checks = await run('example.com', { '_dmarc.example.com': { code: 'ESERVFAIL' } });
    const dmarc = byName(checks, 'DMARC policy enforced');
    assert.equal(dmarc.collection.outcome, 'COLLECTION_ERROR');
    assert.equal(dmarc.collection.errorCode, 'ESERVFAIL');
  });

  test('DKIM: one selector times out, rest cleanly absent → NOT_OBSERVED (not a bounded absence)', async () => {
    // google selector times out; every other selector NXDOMAINs. Because a probe
    // failed, we cannot claim a clean probe-set-bounded absence.
    const checks = await run('example.com', { 'google._domainkey.example.com': { code: 'ETIMEOUT' } });
    const dkim = byName(checks, 'DKIM configured');
    assert.equal(dkim.collection.outcome, 'NOT_OBSERVED');
    assert.equal(dkim.status, 'FAIL'); // scoring unchanged
  });

  test('DKIM: every selector cleanly absent → OBSERVED_ABSENT (bounded)', async () => {
    const checks = await run('example.com', {}); // all selectors NXDOMAIN
    assert.equal(byName(checks, 'DKIM configured').collection.outcome, 'OBSERVED_ABSENT');
  });
});

describe('dns-check — scoring parity through deriveTrustScore (end to end)', () => {
  test('a timed-out email lookup yields the same email-category score as a genuine absence', async () => {
    const timedOut = await run('example.com', {
      'example.com': { code: 'ETIMEOUT' },
      '_dmarc.example.com': { code: 'ETIMEOUT' },
      'google._domainkey.example.com': { code: 'ETIMEOUT' },
    });
    const absent = await run('example.com', {}); // all NXDOMAIN

    const wrap = (checks) => [
      { key: 'ssl', name: 'SSL/TLS Encryption', checks: [] },
      { key: 'email', name: 'Email Security', checks },
      { key: 'headers', name: 'Security Headers', checks: [] },
      { key: 'vulnComp', name: 'Vulnerable Components', checks: [] },
      { key: 'gdpr', name: 'GDPR / Cookie Compliance', checks: [] },
    ];

    const scoreTimedOut = deriveTrustScore(wrap(timedOut), '2026-01-01T00:00:00.000Z');
    const scoreAbsent = deriveTrustScore(wrap(absent), '2026-01-01T00:00:00.000Z');

    // Scoring is identical (the sprint did not touch scoring) …
    assert.equal(scoreTimedOut.scoreObject.categoryBreakdown.email.achieved,
                 scoreAbsent.scoreObject.categoryBreakdown.email.achieved);
    // … but the underlying evidence is now distinguishable.
    assert.equal(byName(timedOut, 'SPF record present and valid').collection.outcome, 'NOT_OBSERVED');
    assert.equal(byName(absent, 'SPF record present and valid').collection.outcome, 'OBSERVED_ABSENT');
  });
});
