'use strict';

// score-and-decide.js — scoring and final-decision state machine for the
// Domain Discovery Pilot (Step 6). Pure function of its inputs; no I/O.

const { normaliseName } = require('../../authority/lib/normalise');

const SCORING_RULE_VERSION = 'DDP-SCORE-v1.0';

function nameTokenOverlap(candidateName, evidenceName) {
  if (!evidenceName) return 0;
  const a = new Set((normaliseName(candidateName) || '').split(' ').filter(Boolean));
  const b = new Set((normaliseName(evidenceName) || '').split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * scoreEvidence(candidate, evidence) -> { breakdown, total, disqualified, disqualifierReason }
 *
 * candidate: { businessName, postcode, companyNumber? (known HMRC-side
 *   company number, if any, for the conflict check) }
 * evidence: extract-evidence.js output for the best surviving page.
 */
function scoreEvidence(candidate, evidence) {
  const breakdown = {};

  const overlap = nameTokenOverlap(candidate.businessName, evidence.legalName);
  breakdown.nameMatch = overlap >= 0.8 ? 40 : 0;

  const candidatePostcode = (candidate.postcode || '').replace(/\s+/g, '').toUpperCase();
  const evidencePostcode = (evidence.postcodeFound || '').replace(/\s+/g, '').toUpperCase();
  const postcodeMatch = !!candidatePostcode && !!evidencePostcode && candidatePostcode === evidencePostcode;
  breakdown.postcodeMatch = postcodeMatch ? 25 : 0;

  const addressMatch = !!evidence.addressFound && postcodeMatch;
  breakdown.addressMatch = addressMatch ? 15 : 0;

  breakdown.telephoneValid = evidence.telephoneFound ? 10 : 0;
  breakdown.categoryConsistency = evidence.categoryConsistency ? 10 : 0;

  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);

  let disqualified = false;
  let disqualifierReason = null;
  if (
    candidate.companyNumber && evidence.companyNumber
    && String(candidate.companyNumber).replace(/\D/g, '') !== String(evidence.companyNumber).replace(/\D/g, '')
  ) {
    disqualified = true;
    disqualifierReason = 'CONFLICTING_COMPANY_NUMBER';
  }

  return {
    breakdown, total, disqualified, disqualifierReason,
    postcodeOrAddressCorroborated: postcodeMatch || addressMatch,
  };
}

/**
 * decide(candidate, evidenceList) -> {
 *   decisionState, scoreTotal, scoreBreakdown, matchedDomain,
 *   disqualifierReason, scoringRuleVersion
 * }
 *
 * evidenceList: [{ domain, evidence }] — the surviving candidate domains'
 * best evidence each, already extracted upstream. Empty array (zero
 * surviving candidates / all fetches failed / zero Brave results) -> UNRESOLVED.
 */
function decide(candidate, evidenceList) {
  if (!evidenceList || evidenceList.length === 0) {
    return { decisionState: 'UNRESOLVED', scoreTotal: 0, scoreBreakdown: {}, matchedDomain: null, disqualifierReason: null, scoringRuleVersion: SCORING_RULE_VERSION };
  }

  const scored = evidenceList.map((entry) => ({ ...entry, score: scoreEvidence(candidate, entry.evidence) }));

  const disqualifier = scored.find((s) => s.score.disqualified);
  if (disqualifier) {
    return {
      decisionState: 'REJECTED_CONFLICT', scoreTotal: disqualifier.score.total, scoreBreakdown: disqualifier.score.breakdown,
      matchedDomain: disqualifier.domain, disqualifierReason: disqualifier.score.disqualifierReason, scoringRuleVersion: SCORING_RULE_VERSION,
    };
  }

  const best = scored.reduce((top, s) => (s.score.total > top.score.total ? s : top), scored[0]);
  const { total, breakdown, postcodeOrAddressCorroborated } = best.score;

  let decisionState;
  if (total < 35) decisionState = 'REJECTED_CONFLICT';
  else if (total >= 65 && postcodeOrAddressCorroborated) decisionState = 'ACCEPTED_HIGH_CONFIDENCE';
  else decisionState = 'REVIEW_REQUIRED';

  return {
    decisionState, scoreTotal: total, scoreBreakdown: breakdown, matchedDomain: best.domain,
    disqualifierReason: decisionState === 'REJECTED_CONFLICT' && total < 35 ? 'SCORE_BELOW_THRESHOLD' : null,
    scoringRuleVersion: SCORING_RULE_VERSION,
  };
}

module.exports = { scoreEvidence, decide, nameTokenOverlap, SCORING_RULE_VERSION };
