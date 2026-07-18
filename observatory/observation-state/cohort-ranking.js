'use strict';

// Deterministic provisioning cohort selection — OBS-103 controlled rollout.
//
// The governed answer to "which NEW organisations enter the population next,
// and in what order". Pure, database-independent, and reproducible: given the
// same eligible population and the same already-provisioned set, it returns the
// same ordered cohort on every machine and every run — independent of
// authority-file order, database-return order, insertion order, locale, and
// randomness.
//
// This deliberately does NOT reuse the OBS-102 `cohort-selection.js`
// (`selectCohort`), which slices a LEXICOGRAPHIC sort for a bounded manual DNS
// observation run. Alphabetical order is exactly what a governed rollout must
// NOT use (it clusters by name/registrar and is trivially gameable by renaming);
// this module ranks by an unbiased FNV-1a hash under the `:cohort:v1` salt
// instead. The two are separate concerns and stay separate modules.
//
// Cumulative by construction: because the rank is a GLOBAL property of the
// immutable organisation id (never a within-batch position), excluding the
// already-provisioned set and taking the next N always yields the next block of
// the one global order. Selecting 100 then, after provisioning those, selecting
// 900 produces exactly the same first 1,000 as a single 1,000-selection from the
// original baseline.

const { cohortRank } = require('./shard-assignment');

const ELIGIBILITY_BASIS = 'single-verified-uncontested-resolvable-domain';

class CohortSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CohortSelectionError';
  }
}

// A defensive upper bound so a fat-fingered `--cohort-size 1000000000` is
// rejected as a validation error rather than silently attempting an absurd
// provisioning run. Comfortably above any real controlled-rollout phase
// (Phase 1A = 100, Phase 1B cumulative target = 1,000).
const MAX_COHORT_SIZE = 1_000_000;

function validateSize(size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new CohortSelectionError(`--cohort-size must be a positive integer, got ${JSON.stringify(size)}`);
  }
  if (size > MAX_COHORT_SIZE) {
    throw new CohortSelectionError(`--cohort-size ${size} exceeds the safety bound ${MAX_COHORT_SIZE}`);
  }
}

/**
 * selectCohortByRank(eligibleOrganisations, options) → {
 *   selected,                     // [{ position, rank, organisationId, organisationName, domain, eligibilityBasis }]
 *   requestedSize,
 *   eligibleCount,                // eligible organisations supplied (deduped)
 *   alreadyProvisionedCount,      // of those eligible, how many were excluded as already provisioned
 *   eligibleUnprovisionedCount,   // eligibleCount - alreadyProvisionedCount
 *   selectedCount,
 *   sufficient,                   // eligibleUnprovisionedCount >= requestedSize
 *   lowestRank, highestRank,      // of the selected block (null when nothing selected)
 * }
 *
 * options: { size, alreadyProvisionedOrganisationIds }
 *
 * Pure. Performs no I/O and never reads a database — the caller supplies both
 * the eligible population and the already-provisioned id set. `size` bounds the
 * NEW (unprovisioned) organisations selected — never the considered set — so N
 * genuinely means "N new organisations" (fixing the legacy `--limit` defect
 * where already-provisioned orgs were only skipped after the slice).
 */
function selectCohortByRank(eligibleOrganisations = [], { size, alreadyProvisionedOrganisationIds = [] } = {}) {
  validateSize(size);
  if (!Array.isArray(eligibleOrganisations)) {
    throw new CohortSelectionError('eligibleOrganisations must be an array');
  }

  const provisioned = new Set(alreadyProvisionedOrganisationIds.map((id) => String(id)));

  // Dedupe eligible by organisation id (first occurrence wins) so an
  // organisation can never appear twice in a cohort even if the upstream
  // enumeration accidentally repeated it.
  const seen = new Set();
  const eligible = [];
  for (const org of eligibleOrganisations) {
    const id = String(org.organisationId);
    if (seen.has(id)) continue;
    seen.add(id);
    eligible.push(org);
  }

  const excludedProvisioned = eligible.filter((org) => provisioned.has(String(org.organisationId)));
  const unprovisioned = eligible.filter((org) => !provisioned.has(String(org.organisationId)));

  // Total order: ascending unsigned cohort rank, then ascending organisationId
  // as the deterministic tie-breaker. String comparison is by UTF-16 code unit
  // (locale-independent) and organisation ids are unique, so the order is total
  // and stable — Array.prototype.sort's own stability is not even relied upon.
  const ranked = unprovisioned
    .map((org) => ({ org, rank: cohortRank(org.organisationId) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const ai = String(a.org.organisationId);
      const bi = String(b.org.organisationId);
      if (ai < bi) return -1;
      if (ai > bi) return 1;
      return 0;
    });

  const chosen = ranked.slice(0, size);
  const selected = chosen.map(({ org, rank }, i) => ({
    position: i + 1,
    rank,
    organisationId: org.organisationId,
    organisationName: org.organisationName ?? null,
    domain: org.domain ?? null,
    eligibilityBasis: org.eligibilityBasis || ELIGIBILITY_BASIS,
  }));

  return {
    requestedSize: size,
    eligibleCount: eligible.length,
    alreadyProvisionedCount: excludedProvisioned.length,
    eligibleUnprovisionedCount: unprovisioned.length,
    selectedCount: selected.length,
    sufficient: unprovisioned.length >= size,
    lowestRank: selected.length ? selected[0].rank : null,
    highestRank: selected.length ? selected[selected.length - 1].rank : null,
    selected,
  };
}

/**
 * buildCohortManifest(selectionResult) → a deterministic, credential-free,
 * timestamp-free manifest object suitable for byte-equivalent comparison across
 * repeated dry runs. Contains only immutable selection facts (position, global
 * hash rank, id, name, domain, eligibility basis) — no mutable production-only
 * state (status, evidence pointers, next_due_at) and nothing secret.
 */
function buildCohortManifest(selectionResult) {
  return {
    schema: 'obs-103-cohort-manifest/v1',
    cohortSalt: require('./shard-assignment').COHORT_SALT,
    requestedSize: selectionResult.requestedSize,
    selectedCount: selectionResult.selectedCount,
    eligibleUnprovisionedCount: selectionResult.eligibleUnprovisionedCount,
    sufficient: selectionResult.sufficient,
    entries: selectionResult.selected.map((s) => ({
      position: s.position,
      rank: s.rank,
      organisationId: s.organisationId,
      organisationName: s.organisationName,
      domain: s.domain,
      eligibilityBasis: s.eligibilityBasis,
    })),
  };
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * manifestToCsv(manifest) → deterministic CSV (LF line endings, fixed column
 * order, no timestamp). Header + one row per selected organisation.
 */
function manifestToCsv(manifest) {
  const header = ['position', 'rank', 'organisationId', 'organisationName', 'domain', 'eligibilityBasis'];
  const lines = [header.join(',')];
  for (const e of manifest.entries) {
    lines.push([e.position, e.rank, e.organisationId, e.organisationName, e.domain, e.eligibilityBasis].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  ELIGIBILITY_BASIS,
  MAX_COHORT_SIZE,
  CohortSelectionError,
  selectCohortByRank,
  buildCohortManifest,
  manifestToCsv,
};
