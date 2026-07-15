'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generatePilotReport } = require('./generate-pilot-report');

function sampleBundle() {
  return {
    candidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }],
    prefilterResults: [
      { candidateId: 'c1', finalBraveDecision: 'SKIPPED', classification: 'SINGLE_PROBABLE_MATCH', freshnessCheck: { verdict: 'CURRENT' } },
      { candidateId: 'c2', finalBraveDecision: 'SEARCHED', classification: 'MULTIPLE_OR_AMBIGUOUS_MATCHES', freshnessCheck: null },
      { candidateId: 'c3', finalBraveDecision: 'SEARCHED', classification: 'SINGLE_PROBABLE_MATCH', freshnessCheck: { verdict: 'STALE' } },
      { candidateId: 'c4', finalBraveDecision: 'SEARCHED', classification: 'NO_MATCH', freshnessCheck: null },
    ],
    braveQueries: [{ candidateId: 'c2' }, { candidateId: 'c2' }, { candidateId: 'c3' }, { candidateId: 'c3' }, { candidateId: 'c4' }, { candidateId: 'c4' }],
    decisions: [
      { candidateId: 'c1', decisionState: 'ACCEPTED_HIGH_CONFIDENCE', matchedDomain: 'c1.com' },
      { candidateId: 'c2', decisionState: 'REVIEW_REQUIRED', matchedDomain: 'c2.com' },
      { candidateId: 'c3', decisionState: 'UNRESOLVED', matchedDomain: null },
      { candidateId: 'c4', decisionState: 'REJECTED_CONFLICT', matchedDomain: null },
    ],
  };
}

test('generatePilotReport: basic counts', () => {
  const report = generatePilotReport(sampleBundle());
  assert.equal(report.braveRequestsMade, 6);
  assert.equal(report.recordsSkipped, 1);
  assert.equal(report.recordsSearched, 3);
  assert.equal(report.ambiguousPrefilterMatches, 1);
  assert.equal(report.staleVerifiedDomains, 1);
  assert.equal(report.reviewRate, 0.25);
  assert.equal(report.unresolvedRate, 0.25);
});

test('generatePilotReport: braveRequestsAvoided = 2 templates x skipped count', () => {
  const report = generatePilotReport(sampleBundle());
  assert.equal(report.braveRequestsAvoided, 2);
});

test('generatePilotReport: estimatedCostSaved is null unless costPerBraveRequest is supplied', () => {
  const withoutCost = generatePilotReport(sampleBundle());
  assert.equal(withoutCost.estimatedCostSaved, null);
  const withCost = generatePilotReport(sampleBundle(), { costPerBraveRequest: 0.005 });
  assert.equal(withCost.estimatedCostSaved, 0.01);
});

test('generatePilotReport: recall/precision/false positives-negatives are null without ground truth', () => {
  const report = generatePilotReport(sampleBundle());
  assert.equal(report.candidateRecall, null);
  assert.equal(report.acceptancePrecision, null);
  assert.equal(report.falsePositives, null);
  assert.equal(report.falseNegatives, null);
});

test('generatePilotReport: computes recall/precision when ground truth is supplied', () => {
  const groundTruth = new Map([
    ['c1', 'c1.com'],
    ['c2', 'c2.com'],
    ['c3', 'no_domain'],
    ['c4', 'c4.com'],
  ]);
  const report = generatePilotReport(sampleBundle(), { groundTruth });
  // Only c1 was ACCEPTED and correctly matches ground truth -> 1 true positive.
  assert.equal(report.acceptancePrecision, 1);
  // c2 and c4 have real domains per ground truth but were not accepted -> false negatives.
  assert.equal(report.falseNegatives, 2);
});
