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

const crypto = require('node:crypto');
const { cohortRank, COHORT_SALT } = require('./shard-assignment');

const ELIGIBILITY_BASIS = 'single-verified-uncontested-resolvable-domain';
const MANIFEST_SCHEMA = 'obs-103-cohort-manifest/v1';

class CohortSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CohortSelectionError';
  }
}

// Raised for any manifest defect: malformed shape, wrong schema/salt, a digest
// that does not match the content (tamper/corruption), or live drift away from
// the reviewed cohort. Distinct from CohortSelectionError so the CLI can report
// "this manifest is not safe to provision" separately from "this selection
// request is invalid".
class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * computeCohortDigest({ cohortSalt, requestedSize, entries }) → sha256 hex over a
 * canonical, order-sensitive serialisation of the cohort. This is the manifest's
 * IDENTITY: it pins the exact ordered set of (rank, organisationId) the human
 * reviewed, so a later production run can prove it is provisioning that cohort
 * and nothing else. Deterministic and timestamp-free.
 */
function computeCohortDigest({ cohortSalt, requestedSize, entries }) {
  const canonical = [
    `salt=${cohortSalt}`,
    `size=${requestedSize}`,
    ...entries.map((e) => `${e.position}:${e.rank}:${e.organisationId}`),
  ].join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
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
  const entries = selectionResult.selected.map((s) => ({
    position: s.position,
    rank: s.rank,
    organisationId: s.organisationId,
    organisationName: s.organisationName,
    domain: s.domain,
    eligibilityBasis: s.eligibilityBasis,
  }));
  const cohortSalt = COHORT_SALT;
  const requestedSize = selectionResult.requestedSize;
  return {
    schema: MANIFEST_SCHEMA,
    cohortSalt,
    requestedSize,
    selectedCount: selectionResult.selectedCount,
    eligibleUnprovisionedCount: selectionResult.eligibleUnprovisionedCount,
    sufficient: selectionResult.sufficient,
    // Identity of the reviewed cohort — recomputed and checked on load.
    cohortDigest: computeCohortDigest({ cohortSalt, requestedSize, entries }),
    entries,
  };
}

/**
 * validateManifest(obj) → the manifest, or throws ManifestError. Checks shape
 * only (schema, current salt, well-formed entries with unique ids). Does NOT
 * verify the digest — that is verifyManifestIdentity's job.
 */
function validateManifest(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ManifestError('manifest must be a JSON object');
  }
  if (obj.schema !== MANIFEST_SCHEMA) {
    throw new ManifestError(`unsupported manifest schema ${JSON.stringify(obj.schema)} (expected ${MANIFEST_SCHEMA})`);
  }
  if (obj.cohortSalt !== COHORT_SALT) {
    throw new ManifestError(`manifest cohortSalt ${JSON.stringify(obj.cohortSalt)} does not match the current ranking salt ${COHORT_SALT} — refusing to provision under a different ranking`);
  }
  if (!Number.isInteger(obj.requestedSize) || obj.requestedSize <= 0) {
    throw new ManifestError(`manifest requestedSize must be a positive integer, got ${JSON.stringify(obj.requestedSize)}`);
  }
  if (typeof obj.cohortDigest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.cohortDigest)) {
    throw new ManifestError('manifest cohortDigest must be a 64-hex sha256 string');
  }
  if (!Array.isArray(obj.entries)) {
    throw new ManifestError('manifest entries must be an array');
  }
  const seen = new Set();
  obj.entries.forEach((e, i) => {
    if (e == null || typeof e !== 'object') throw new ManifestError(`entry ${i} must be an object`);
    if (typeof e.organisationId !== 'string' || e.organisationId.length === 0) {
      throw new ManifestError(`entry ${i} has an invalid organisationId`);
    }
    if (!Number.isInteger(e.position) || !Number.isInteger(e.rank)) {
      throw new ManifestError(`entry ${i} (${e.organisationId}) has a non-integer position/rank`);
    }
    if (seen.has(e.organisationId)) throw new ManifestError(`entry ${i} duplicates organisationId ${e.organisationId}`);
    seen.add(e.organisationId);
  });
  return obj;
}

/**
 * verifyManifestIdentity(manifest) → throws ManifestError if the recomputed
 * digest does not match the stored one, or if an entry's rank does not match
 * the canonical cohortRank of its organisationId (so a manifest cannot claim a
 * different ranking than the deterministic function actually produces).
 */
function verifyManifestIdentity(manifest) {
  const recomputed = computeCohortDigest({
    cohortSalt: manifest.cohortSalt,
    requestedSize: manifest.requestedSize,
    entries: manifest.entries,
  });
  if (recomputed !== manifest.cohortDigest) {
    throw new ManifestError(`manifest digest mismatch: content hashes to ${recomputed} but manifest claims ${manifest.cohortDigest} — the manifest has been altered`);
  }
  for (const e of manifest.entries) {
    const trueRank = cohortRank(e.organisationId);
    if (e.rank !== trueRank) {
      throw new ManifestError(`manifest entry ${e.organisationId} claims rank ${e.rank} but cohortRank is ${trueRank} — inconsistent ranking`);
    }
  }
  return manifest;
}

/**
 * reconcileManifestAgainstLive(manifest, eligibleOrganisations, provisionedIds)
 *   → { targetOrgIds, drift, driftReason, idealOrgIds }
 *
 * Determines whether the reviewed manifest is still the governed choice given
 * the CURRENT eligible population and provisioned set, WITHOUT letting a partial
 * prior write look like drift. It recomputes the ideal cohort treating the
 * manifest's own organisations as still-selectable (i.e. excluding from the
 * "provisioned" set exactly the manifest orgs), so:
 *   - a fresh run reproduces the manifest;
 *   - a retry after a partial write STILL reproduces the manifest (the already-
 *     written manifest orgs are added back as candidates);
 *   - genuine drift (a lower-ranked eligible org appeared, or a manifest org
 *     lost eligibility) makes the ideal set differ → drift = true.
 * The provisioning target is ALWAYS exactly the manifest's org ids — never the
 * recomputed set — so this can only ever REFUSE, never expand.
 */
function reconcileManifestAgainstLive(manifest, eligibleOrganisations = [], provisionedIds = []) {
  const manifestOrgIds = manifest.entries.map((e) => e.organisationId);
  const manifestSet = new Set(manifestOrgIds);
  const provisionedExceptManifest = provisionedIds.filter((id) => !manifestSet.has(String(id)));

  const ideal = selectCohortByRank(eligibleOrganisations, {
    size: manifest.requestedSize,
    alreadyProvisionedOrganisationIds: provisionedExceptManifest,
  });
  const idealOrgIds = ideal.selected.map((s) => s.organisationId);
  const idealSet = new Set(idealOrgIds);

  let drift = false;
  let driftReason = null;
  const missingFromIdeal = manifestOrgIds.filter((id) => !idealSet.has(id));
  const extraInIdeal = idealOrgIds.filter((id) => !manifestSet.has(id));
  if (missingFromIdeal.length || extraInIdeal.length) {
    drift = true;
    const bits = [];
    if (missingFromIdeal.length) bits.push(`${missingFromIdeal.length} manifest org(s) no longer in the deterministic top-${manifest.requestedSize} (e.g. ${missingFromIdeal[0]})`);
    if (extraInIdeal.length) bits.push(`${extraInIdeal.length} lower-ranked eligible org(s) would now displace the manifest (e.g. ${extraInIdeal[0]})`);
    driftReason = `live selection has drifted from the reviewed manifest: ${bits.join('; ')}`;
  }

  return { targetOrgIds: manifestOrgIds, drift, driftReason, idealOrgIds };
}

function csvCell(value) {
  let str = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula injection: a value an operator opens in
  // Excel/Sheets that begins with = + - @ (or a leading tab/CR that shifts the
  // parse) is prefixed with a single quote so it is treated as literal text.
  // Organisation names/domains come from external authority data, so this is a
  // real vector for the exact human-review step the manifest exists for.
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
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
  MANIFEST_SCHEMA,
  MAX_COHORT_SIZE,
  CohortSelectionError,
  ManifestError,
  selectCohortByRank,
  computeCohortDigest,
  buildCohortManifest,
  validateManifest,
  verifyManifestIdentity,
  reconcileManifestAgainstLive,
  manifestToCsv,
};
