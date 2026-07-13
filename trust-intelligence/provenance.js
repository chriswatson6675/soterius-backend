'use strict';

// Provenance Builder — ENG-025 v1.1 (Approved, ENG-014 WP-3).
//
// Pure, side-effect-free construction of the provenanceVector and
// provenanceManifest structures ENG-023 §7-§8 define. Performs no I/O of its
// own (ENG-025 §1) — every input below is already-fetched data handed in by
// the caller (generate-trust-profile.js). Compose only; this module invents
// no field, no structure, and no scoring/interpretation logic (TI-P-3).
//
// Constitutional architecture is frozen (Architecture v1.0). This module
// implements ENG-025 exactly as specified; any apparent gap encountered
// during this implementation is called out in a comment, not silently
// resolved by inventing new rules here.

const crypto = require('crypto');

class ProvenanceMalformedInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvenanceMalformedInputError';
    this.code = 'MALFORMED_INPUT';
  }
}

class ProvenanceVersionConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvenanceVersionConflictError';
    this.code = 'VERSION_CONFLICT';
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// §6 Validation Sequence (V-A ... V-G). Throws before any construction step
// runs (ENG-025 §3 step 1) — no partial output is ever produced.
function validate(input) {
  const { organisationDomains, signalsByDomain, organisationHistoryRefs, aggregationMethodVersion } = input;

  // V-A
  if (!Array.isArray(organisationDomains) || organisationDomains.some((d) => !isNonEmptyString(d))) {
    throw new ProvenanceMalformedInputError('organisationDomains must be an array of non-empty strings');
  }
  if (new Set(organisationDomains).size !== organisationDomains.length) {
    throw new ProvenanceMalformedInputError('organisationDomains must not contain duplicate entries (V-A)');
  }

  // V-F: signalsByDomain must have exactly one entry per organisationDomains
  // element, and no extra domain keys — closes the Unknown-vs-Absent gap
  // OBS-CONST-001 P-5 / ADR-SYS-010 OC-4 forbid collapsing one layer down.
  const domainSet = new Set(organisationDomains);
  const suppliedDomains = Object.keys(signalsByDomain || {});
  if (suppliedDomains.length !== domainSet.size || !suppliedDomains.every((d) => domainSet.has(d))) {
    throw new ProvenanceMalformedInputError('signalsByDomain must carry exactly one entry per organisationDomains element, and none extra (V-F)');
  }

  // V-B, V-G
  for (const domain of organisationDomains) {
    const signals = signalsByDomain[domain] || [];
    if (!Array.isArray(signals)) {
      throw new ProvenanceMalformedInputError(`signalsByDomain[${domain}] must be an array`);
    }
    const seenKeys = new Set();
    for (const s of signals) {
      if (!s || !isNonEmptyString(s.key)) {
        throw new ProvenanceMalformedInputError(`every signal entry for domain ${domain} must carry a non-empty key`);
      }
      if (s.observed) {
        if (!isNonEmptyString(s.qualityModelVersion) || !isNonEmptyString(s.collectedAt) || !isNonEmptyString(s.sourceRowRef)) {
          throw new ProvenanceMalformedInputError(`observed signal ${s.key} for domain ${domain} must carry qualityModelVersion, collectedAt, and sourceRowRef (V-B)`);
        }
        if (seenKeys.has(s.key)) {
          throw new ProvenanceMalformedInputError(`duplicate observed signal key ${s.key} within domain ${domain} (V-G)`);
        }
        seenKeys.add(s.key);
      }
    }
  }

  // V-C
  if (!Array.isArray(organisationHistoryRefs) || organisationHistoryRefs.some((r) => !isNonEmptyString(r))) {
    throw new ProvenanceMalformedInputError('organisationHistoryRefs must be an array of non-empty strings');
  }
  if (new Set(organisationHistoryRefs).size !== organisationHistoryRefs.length) {
    throw new ProvenanceMalformedInputError('organisationHistoryRefs must not contain duplicate references (V-C)');
  }

  // V-E
  if (!isNonEmptyString(aggregationMethodVersion)) {
    throw new ProvenanceMalformedInputError('aggregationMethodVersion must be a non-empty string');
  }
}

// §5 Version Vector construction — fold with conflict detection (V-D).
function buildVector(organisationDomains, signalsByDomain, aggregationMethodVersion) {
  const qualityModelVersions = {};
  for (const domain of organisationDomains) {
    for (const s of signalsByDomain[domain]) {
      if (!s.observed) continue;
      if (qualityModelVersions[s.key] === undefined) {
        qualityModelVersions[s.key] = s.qualityModelVersion;
      } else if (qualityModelVersions[s.key] !== s.qualityModelVersion) {
        throw new ProvenanceVersionConflictError(
          `signal ${s.key} observed with inconsistent qualityModelVersion across domains (V-D): ${qualityModelVersions[s.key]} vs ${s.qualityModelVersion}`,
        );
      }
    }
  }
  return { aggregationMethodVersion, qualityModelVersions };
}

// §3 steps 3-4: filter to observed===true, sort ascending by key.
function observedSorted(signals) {
  return signals
    .filter((s) => s.observed)
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((s) => ({ key: s.key, qualityModelVersion: s.qualityModelVersion, collectedAt: s.collectedAt, sourceRowRef: s.sourceRowRef }));
}

// §8.1 canonicalisation: object keys sorted lexicographically at every
// nesting level; arrays keep their already-deterministic order; no whitespace.
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * buildProvenance(input, opts) → { provenanceVector, provenanceManifest }
 *
 * input: { organisationId, organisationDomains, generatedAt, trigger,
 *          signalsByDomain: { [domain]: [{key, observed, qualityModelVersion,
 *          collectedAt, sourceRowRef}] }, organisationHistoryRefs,
 *          aggregationMethodVersion }
 * opts: { includeIntegrityDigest? boolean }
 *
 * Throws ProvenanceMalformedInputError or ProvenanceVersionConflictError —
 * never returns a partial result (ENG-025 §7).
 */
function buildProvenance(input, opts = {}) {
  validate(input);

  const { organisationId, organisationDomains, generatedAt, trigger, signalsByDomain, organisationHistoryRefs, aggregationMethodVersion } = input;

  const provenanceVector = buildVector(organisationDomains, signalsByDomain, aggregationMethodVersion);

  const domains = organisationDomains.map((domain) => ({
    domain,
    signals: observedSorted(signalsByDomain[domain]),
  }));

  const provenanceManifest = {
    organisationId,
    generatedAt,
    trigger,
    provenanceVector,
    domains,
    organisationHistoryRefs: organisationHistoryRefs.slice(),
  };

  if (opts.includeIntegrityDigest) {
    const canonical = canonicalStringify(provenanceManifest);
    provenanceManifest.integrityDigest = crypto.createHash('sha256').update(canonical).digest('hex');
  }

  return { provenanceVector, provenanceManifest };
}

module.exports = { buildProvenance, ProvenanceMalformedInputError, ProvenanceVersionConflictError };
