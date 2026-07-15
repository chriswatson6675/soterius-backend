'use strict';

// generate-pilot-report.js — pure aggregation over an injected run bundle.
// No I/O, no hardcoded ground truth or cost assumptions — both are accepted
// as explicit parameters.

/**
 * generatePilotReport(bundle, options) -> report object.
 *
 * bundle: {
 *   candidates: [{ id, ... }],
 *   prefilterResults: [{ candidateId, finalBraveDecision, classification, freshnessCheck }],
 *   braveQueries: [{ candidateId }],   // one entry per Brave request actually made
 *   decisions: [{ candidateId, decisionState }],
 * }
 * options: {
 *   groundTruth: Map<candidateId, 'domain_exists'|'no_domain'|matchedDomain>  (optional),
 *   costPerBraveRequest: number (optional, no default guessed),
 * }
 */
function generatePilotReport(bundle, options = {}) {
  const candidates = bundle.candidates || [];
  const prefilterResults = bundle.prefilterResults || [];
  const braveQueries = bundle.braveQueries || [];
  const decisions = bundle.decisions || [];
  const groundTruth = options.groundTruth || null;
  const costPerBraveRequest = options.costPerBraveRequest ?? null;

  const braveRequestsMade = braveQueries.length;

  const skipped = prefilterResults.filter((r) => r.finalBraveDecision === 'SKIPPED');
  const searched = prefilterResults.filter((r) => r.finalBraveDecision === 'SEARCHED');

  const ambiguousPrefilterMatches = prefilterResults.filter((r) => r.classification === 'MULTIPLE_OR_AMBIGUOUS_MATCHES').length;
  const staleVerifiedDomains = prefilterResults.filter((r) => r.freshnessCheck && r.freshnessCheck.verdict === 'STALE').length;

  const totalCandidates = candidates.length || prefilterResults.length || 1;

  const accepted = decisions.filter((d) => d.decisionState === 'ACCEPTED_HIGH_CONFIDENCE');
  const review = decisions.filter((d) => d.decisionState === 'REVIEW_REQUIRED');
  const unresolved = decisions.filter((d) => d.decisionState === 'UNRESOLVED');
  const rejected = decisions.filter((d) => d.decisionState === 'REJECTED_CONFLICT');

  const reviewRate = decisions.length ? review.length / decisions.length : null;
  const unresolvedRate = decisions.length ? unresolved.length / decisions.length : null;

  // Recall / precision / false positives-negatives — only computed when
  // ground truth is supplied; otherwise honestly null (not invented).
  let candidateRecall = null;
  let acceptancePrecision = null;
  let falsePositives = null;
  let falseNegatives = null;

  if (groundTruth) {
    let truePositives = 0;
    let fpCount = 0;
    let fnCount = 0;
    let groundTruthDomainCount = 0;

    for (const d of decisions) {
      const truth = groundTruth.get(d.candidateId);
      const hasTrueDomain = truth && truth !== 'no_domain';
      if (hasTrueDomain) groundTruthDomainCount += 1;

      if (d.decisionState === 'ACCEPTED_HIGH_CONFIDENCE') {
        if (hasTrueDomain && (truth === d.matchedDomain || truth === true)) truePositives += 1;
        else fpCount += 1;
      } else if (hasTrueDomain) {
        fnCount += 1;
      }
    }

    candidateRecall = groundTruthDomainCount ? truePositives / groundTruthDomainCount : null;
    acceptancePrecision = accepted.length ? truePositives / accepted.length : null;
    falsePositives = fpCount;
    falseNegatives = fnCount;
  }

  const braveRequestsAvoided = skipped.length * 2; // 2 query templates per candidate, per DDP-QT-v1.0
  const estimatedCostSaved = costPerBraveRequest !== null ? braveRequestsAvoided * costPerBraveRequest : null;

  return {
    braveRequestsMade,
    recordsSkipped: skipped.length,
    recordsSearched: searched.length,
    ambiguousPrefilterMatches,
    staleVerifiedDomains,
    candidateRecall,
    acceptancePrecision,
    reviewRate,
    unresolvedRate,
    falsePositives,
    falseNegatives,
    braveRequestsAvoided,
    estimatedCostSaved,
    counts: {
      totalCandidates,
      accepted: accepted.length,
      review: review.length,
      unresolved: unresolved.length,
      rejected: rejected.length,
    },
  };
}

module.exports = { generatePilotReport };
