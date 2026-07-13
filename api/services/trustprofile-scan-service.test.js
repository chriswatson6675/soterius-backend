'use strict';

// Regression coverage for trustprofile-scan-service.js (ADR-SYS-011, Legacy
// Scanner Retirement) — proves POST /api/scan's new live-scan orchestrator
// (1) calls the canonical runOnDemandObservation + getObservatoryProfile
// exactly once each, composing rather than re-implementing them, (2) maps
// the Observatory's overallScore onto the SAME getRiskBand thresholds the
// legacy engine used, and (3) degrades to an honest empty presentation
// rather than throwing when the pipeline itself fails to start.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { executeTrustProfileScan } = require('./trustprofile-scan-service');
const { getRiskBand, TRUSTPROFILE_SCORING_VERSION } = require('./scan-derivation-service');

function fakeProfile(overrides = {}) {
  return {
    ok: true,
    overallScore: 82,
    grade: 'B',
    signalsObserved: 4,
    signalsTotal: 10,
    categories: [
      {
        category: 'Email Trust',
        averageScore: 82,
        signals: [{ key: 'spf', score: 90, label: 'strict', collectedAt: '2026-07-12T00:00:00.000Z' }],
      },
    ],
    fetchedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('executeTrustProfileScan — composition only, no re-implementation', () => {
  test('calls runOnDemandObservation and getObservatoryProfile exactly once each, for the given domain', async () => {
    let observationCalls = 0;
    let profileCalls = 0;

    const result = await executeTrustProfileScan('example.test', {
      runOnDemandObservationFn: async (domain) => {
        observationCalls += 1;
        assert.equal(domain, 'example.test');
        return { ok: true, sessionId: 'sess-1', resolutionOutcome: 'NOT_FOUND', organisationId: null, signals: [] };
      },
      getObservatoryProfileFn: async (domain) => {
        profileCalls += 1;
        assert.equal(domain, 'example.test');
        return fakeProfile();
      },
      now: () => '2026-07-12T12:00:00.000Z',
    });

    assert.equal(observationCalls, 1);
    assert.equal(profileCalls, 1);
    assert.equal(result.score, 82);
    assert.equal(result.riskLevel, getRiskBand(82));
    assert.equal(result.scoreObject.scoringVersion, TRUSTPROFILE_SCORING_VERSION);
    assert.equal(result.scoreObject.sessionId, 'sess-1');
    assert.equal(result.totalPoints, null);
    assert.equal(result.maxPoints, null);
  });

  test('maps overallScore onto the SAME risk-band thresholds getRiskBand uses — not a duplicated ladder', async () => {
    for (const score of [95, 80, 65, 40, 10]) {
      const result = await executeTrustProfileScan('example.test', {
        runOnDemandObservationFn: async () => ({ ok: true, sessionId: 's', resolutionOutcome: 'NOT_FOUND', organisationId: null, signals: [] }),
        getObservatoryProfileFn: async () => fakeProfile({ overallScore: score }),
        now: () => '2026-07-12T12:00:00.000Z',
      });
      assert.equal(result.riskLevel, getRiskBand(score));
    }
  });

  test('produces an honestly-empty presentation, not a throw, when the pipeline fails to open a session', async () => {
    const result = await executeTrustProfileScan('example.test', {
      runOnDemandObservationFn: async () => ({ ok: false, error: 'session creation failed: boom' }),
      getObservatoryProfileFn: async () => { throw new Error('must not be called when observation failed'); },
      now: () => '2026-07-12T12:00:00.000Z',
    });

    assert.equal(result.score, 0);
    assert.equal(result.riskLevel, 'Critical Risk');
    assert.deepEqual(result.scanners, []);
    assert.equal(result.scoreObject.scoringVersion, TRUSTPROFILE_SCORING_VERSION);
    assert.match(result.scoreObject.pipelineError, /session creation failed/);
  });

  test('per-category breakdown reuses getRiskBand for each category rating — not a second ladder', async () => {
    const result = await executeTrustProfileScan('example.test', {
      runOnDemandObservationFn: async () => ({ ok: true, sessionId: 's', resolutionOutcome: 'NOT_FOUND', organisationId: null, signals: [] }),
      getObservatoryProfileFn: async () => fakeProfile(),
      now: () => '2026-07-12T12:00:00.000Z',
    });

    assert.equal(result.scanners.length, 1);
    assert.equal(result.scanners[0].name, 'Email Trust');
    assert.equal(result.scanners[0].rating, getRiskBand(82));
    assert.equal(result.scanners[0].checks[0].name, 'spf');
    assert.equal(result.scanners[0].checks[0].status, 'PASS');
  });
});
