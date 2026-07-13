'use strict';

// Regression coverage for the Phase 1 (ADR-SYS-009 implementation programme)
// extraction of deriveTrustScore() out of executeScan(). The scoring math
// itself is copy-pasted, not rewritten — these tests prove that move didn't
// change any output, and pin the v1.0 methodology (SCORING.md) against silent
// drift going forward.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  executeScan, collect, deriveTrustScore, getRiskLevel, getRiskBand, SCANNERS, MAX_POINTS,
} = require('./legacy-scan-engine');

// Synthetic scannerResults fixture — deriveTrustScore only cares about
// { key, checks }, so tests never need real network-derived check output.
function fixture(overrides = {}) {
  return SCANNERS.map(def => ({
    key: def.key,
    name: def.name,
    checks: overrides[def.key] ?? [],
  }));
}

describe('MAX_POINTS — v1.0 methodology total (SCORING.md)', () => {
  test('ssl(40) + email(56) + headers(50) + vulnComp(48) + gdpr(12) = 206', () => {
    assert.equal(MAX_POINTS, 206);
  });
});

describe('deriveTrustScore — pure function, deterministic', () => {
  test('empty checks everywhere → 0 points, score 0, Critical Risk', () => {
    const result = deriveTrustScore(fixture(), '2026-01-01T00:00:00.000Z');
    assert.equal(result.totalPoints, 0);
    assert.equal(result.score, 0);
    assert.equal(result.riskLevel, 'Critical Risk');
    assert.equal(result.scoreObject.achievedPoints, 0);
    assert.equal(result.scoreObject.totalMaximum, 206);
    assert.equal(result.scoreObject.scoringVersion, 'v1.0');
  });

  test('every scanner at full marks via explicit points → score 100, Excellent', () => {
    const result = deriveTrustScore(fixture({
      ssl:      [{ name: 'c', status: 'PASS', points: 40 }],
      email:    [{ name: 'c', status: 'PASS', points: 56 }],
      headers:  [{ name: 'c', status: 'PASS', points: 50 }],
      vulnComp: [{ name: 'c', status: 'PASS', points: 48 }],
      gdpr:     [{ name: 'c', status: 'PASS', points: 12 }],
    }), '2026-01-01T00:00:00.000Z');

    assert.equal(result.totalPoints, 206);
    assert.equal(result.score, 100);
    assert.equal(result.riskLevel, 'Excellent');
    assert.equal(result.scoreObject.categoryBreakdown.ssl.percentage, 100);
    assert.equal(result.scoreObject.categoryBreakdown.ssl.rating, 'Excellent');
  });

  test('status-based scoring uses def.pts table when points is absent', () => {
    // ssl: def.pts = { PASS: 10, WARNING: 5, FAIL: 0 }, 2 checks
    const result = deriveTrustScore(fixture({
      ssl: [
        { name: 'a', status: 'PASS' },
        { name: 'b', status: 'WARNING' },
      ],
    }), '2026-01-01T00:00:00.000Z');

    const sslCategory = result.scanners.find(s => s.name === 'SSL/TLS Encryption');
    assert.equal(sslCategory.checks.length, 2);
    // 10 (PASS) + 5 (WARNING) = 15 of 40 → round(15/40*100) = 38%
    assert.equal(result.scoreObject.categoryBreakdown.ssl.achieved, 15);
    assert.equal(result.scoreObject.categoryBreakdown.ssl.percentage, 38);
  });

  test('explicit points on a check overrides the status-based def.pts table', () => {
    // Mirrors dns-check.js's DMARC check, which sets `points` alongside `status`.
    const result = deriveTrustScore(fixture({
      email: [{ name: 'DMARC policy enforced', status: 'WARNING', points: 30 }],
    }), '2026-01-01T00:00:00.000Z');

    // def.pts.WARNING for 'email' is 4 — if points were ignored, achieved would be 4, not 30.
    assert.equal(result.scoreObject.categoryBreakdown.email.achieved, 30);
  });

  test('a scanner missing from scannerResults falls back to a FAIL placeholder, not a crash', () => {
    const partial = fixture().filter(r => r.key !== 'gdpr'); // drop gdpr entirely
    const result = deriveTrustScore(partial, '2026-01-01T00:00:00.000Z');

    assert.equal(result.scoreObject.categoryBreakdown.gdpr.achieved, 0);
    const gdprCategory = result.scanners.find(s => s.name === 'GDPR / Cookie Compliance');
    assert.equal(gdprCategory.checks[0].name, 'Scanner error');
    assert.equal(gdprCategory.checks[0].status, 'FAIL');
  });

  test('same input twice → identical scoreObject (pure function, no hidden state)', () => {
    const input = fixture({ ssl: [{ name: 'c', status: 'PASS', points: 20 }] });
    const a = deriveTrustScore(input, '2026-01-01T00:00:00.000Z');
    const b = deriveTrustScore(input, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(a.scoreObject, b.scoreObject);
  });

  test('scannedAt defaults to now() when not passed, but is otherwise unused in the math', () => {
    const result = deriveTrustScore(fixture());
    assert.equal(typeof result.scannedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(result.scannedAt)));
  });
});

describe('getRiskLevel / getRiskBand — v1.0 band thresholds (unchanged)', () => {
  test('band boundaries', () => {
    for (const fn of [getRiskLevel, getRiskBand]) {
      assert.equal(fn(100), 'Excellent');
      assert.equal(fn(90), 'Excellent');
      assert.equal(fn(89), 'Good');
      assert.equal(fn(75), 'Good');
      assert.equal(fn(74), 'Moderate Risk');
      assert.equal(fn(60), 'Moderate Risk');
      assert.equal(fn(59), 'High Risk');
      assert.equal(fn(40), 'High Risk');
      assert.equal(fn(39), 'Critical Risk');
      assert.equal(fn(0), 'Critical Risk');
    }
  });
});

describe('executeScan — composition of collect() + deriveTrustScore() is wired correctly', () => {
  test('executeScan output is identical to calling collect() then deriveTrustScore() directly', async () => {
    // Stub SCANNERS[*].fn in place (mutating the exported array's elements, not
    // reassigning the array) so collect()'s internal closure picks up the stubs —
    // proves the wiring without any network call.
    const originalFns = SCANNERS.map(s => s.fn);
    SCANNERS.forEach((s, i) => {
      s.fn = async () => [{ name: `${s.key}-stub`, status: i === 0 ? 'PASS' : 'FAIL', points: i === 0 ? s.maxPoints : 0 }];
    });

    try {
      const viaExecuteScan = await executeScan('example.test');
      const scannerResults = await collect('example.test');
      const viaComposition = deriveTrustScore(scannerResults, viaExecuteScan.scannedAt);

      assert.deepEqual(viaExecuteScan.scoreObject, viaComposition.scoreObject);
      assert.equal(viaExecuteScan.score, viaComposition.score);
      assert.equal(viaExecuteScan.riskLevel, viaComposition.riskLevel);
    } finally {
      SCANNERS.forEach((s, i) => { s.fn = originalFns[i]; });
    }
  });

  test('collect() output shape matches deriveTrustScore()\'s expected input (key, name, checks)', async () => {
    const originalFns = SCANNERS.map(s => s.fn);
    SCANNERS.forEach(s => { s.fn = async () => [{ name: 'stub', status: 'PASS' }]; });

    try {
      const results = await collect('example.test');
      assert.equal(results.length, SCANNERS.length);
      results.forEach((r, i) => {
        assert.equal(r.key, SCANNERS[i].key);
        assert.equal(r.name, SCANNERS[i].name);
        assert.ok(Array.isArray(r.checks));
      });
    } finally {
      SCANNERS.forEach((s, i) => { s.fn = originalFns[i]; });
    }
  });
});
