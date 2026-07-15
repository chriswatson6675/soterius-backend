'use strict';

// run-prefilter.js — orchestrates the Domain Discovery Pilot's prefilter
// per the documented behaviour table. Read-only over Repository Authority;
// never calls Brave itself (only decides SEARCHED vs SKIPPED).

const { lookupCandidates } = require('./ra-lookup');
const { classifyMatch } = require('./match-classify');
const { checkFreshness } = require('./freshness-check');

/**
 * runPrefilter(candidate, deps) -> {
 *   classification, matchedOrganisationId, matchedDomainStatus,
 *   freshnessCheck, finalBraveDecision, decisionReason, raSearchCandidates
 * }
 */
async function runPrefilter(candidate, deps = {}) {
  const lookup = lookupCandidates({ name: candidate.businessName, tradingName: candidate.tradingName }, deps);
  const raCandidates = lookup.ok ? lookup.candidates : [];

  const { classification, matched } = classifyMatch(candidate, raCandidates);

  if (classification === 'NO_MATCH') {
    return finalise({ classification, matched: null, freshnessCheck: null, decision: 'SEARCHED', reason: 'NO_MATCH', raCandidates });
  }
  if (classification === 'MULTIPLE_OR_AMBIGUOUS_MATCHES') {
    return finalise({ classification, matched: null, freshnessCheck: null, decision: 'SEARCHED', reason: 'MULTIPLE_OR_AMBIGUOUS_MATCHES', raCandidates });
  }

  // SINGLE_PROBABLE_MATCH — branch on domainStatus.
  const domainStatus = matched.row.domainStatus || 'NO_DOMAIN';

  if (domainStatus === 'NO_DOMAIN' || domainStatus == null) {
    return finalise({ classification, matched, freshnessCheck: null, decision: 'SEARCHED', reason: 'SINGLE_PROBABLE_MATCH+NO_DOMAIN', raCandidates });
  }
  if (domainStatus === 'PENDING' || domainStatus === 'UNVERIFIED' || domainStatus === 'CANDIDATE') {
    return finalise({ classification, matched, freshnessCheck: null, decision: 'SEARCHED', reason: 'SINGLE_PROBABLE_MATCH+PENDING', raCandidates });
  }

  // VERIFIED — run the freshness check.
  const freshness = await checkFreshness(candidate, matched.row.domain, deps);
  const decision = freshness.verdict === 'CURRENT' ? 'SKIPPED' : 'SEARCHED';
  return finalise({
    classification, matched, freshnessCheck: freshness, decision,
    reason: `SINGLE_PROBABLE_MATCH+VERIFIED+${freshness.verdict}`, raCandidates,
  });
}

function finalise({ classification, matched, freshnessCheck, decision, reason, raCandidates }) {
  return {
    classification,
    matchedOrganisationId: matched ? matched.row.id : null,
    matchedDomainStatus: matched ? matched.row.domainStatus ?? null : null,
    freshnessCheck: freshnessCheck ? { resolves: freshnessCheck.resolves, evidence: freshnessCheck.evidence, verdict: freshnessCheck.verdict } : null,
    finalBraveDecision: decision,
    decisionReason: reason,
    raSearchCandidates: raCandidates,
    prefilterRuleVersion: 'DDP-PREFILTER-v1.0',
  };
}

module.exports = { runPrefilter };
