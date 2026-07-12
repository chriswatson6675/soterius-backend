'use strict';

// lifecycle.js — derives Organisation lifecycle, per the Organisation
// Discovery review §1. Pure function: lifecycle is DERIVED from facts
// already on the assembled Organisation (OC-5), never asserted or stored
// separately. Milestones accumulate (non-exclusive); status is terminal
// (exclusive). `merged` cannot be derived — it requires a persisted
// correction record from the governed Repository Authority correction
// path (ADR-COL-010) that does not exist until Phase B. Not implemented
// here; deliberately absent rather than faked.

/**
 * @param {import('./schema').Organisation} organisation
 * @returns {{milestones: string[], status: 'active'|'retired', supersededBy: null}}
 */
function deriveLifecycle(organisation) {
  const milestones = ['DISCOVERED'];

  const verifiedIdentity = organisation.provenance.some(
    (p) => (p.section === 'legalEntities[0]' || p.section === 'regulators[0]') && p.confidence === 'verified'
  );
  if (verifiedIdentity && organisation.identifiers.length > 0) milestones.push('VERIFIED');

  if (organisation.classification && organisation.classification.length > 0) milestones.push('CLASSIFIED');

  // BENCHMARKED is structurally unreachable until the Benchmarking Experience
  // and cohort definitions exist (Phase B) — deliberately never pushed here.

  const status = isRetired(organisation) ? 'retired' : 'active';

  return { milestones, status, supersededBy: null };
}

function isRetired(organisation) {
  return organisation.legalEntities.some((le) => le.status === 'dissolved')
    || organisation.regulators.some((r) => r.status === 'CEASE');
}

module.exports = { deriveLifecycle };
