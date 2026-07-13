'use strict';

// Canonical Trust Profile Builder — ENG-029 v1.1 (Approved, ENG-014 WP-4).
//
// Pure composition function. Invokes five already-governed capabilities as
// opaque, unmodified calls — Organisation identity assembly, per-signal
// Quality Model outputs, Organisation History, the canonical Trust Score
// engine, and ENG-025's Provenance Builder — and assembles their outputs
// into one Trust Profile Instance conforming exactly to ENG-023 §6.
//
// Performs no observation, no identity resolution, no provenance
// construction, no scoring methodology definition, and no persistence
// (ENG-029 §0). Constitutional architecture is frozen (Architecture v1.0) —
// this module implements ENG-029 exactly as specified.
//
// IMPLEMENTATION NOTE (flagged, not silently resolved — see chat record):
// ENG-023/ENG-025/ENG-029 all model organisationDomains as a potentially
// multi-domain array, but the live Trust Score engine (`scoreTrust`,
// backend/observatory/baseline/trust-score.js, wrapping ENG-026's
// Aggregator) is domain-scoped — it takes exactly one domain, not an
// Organisation. No frozen document defines how to combine multiple domains'
// Trust Scores into one Organisation-level score, and inventing that
// aggregation here would be new scoring methodology this module is
// constitutionally forbidden from introducing (TI-P-3). Pragmatic choice,
// not an architectural one: score against organisationDomains[0] (the
// primary domain) when at least one domain exists. This is not presently a
// live-data risk — backend/organisation/assemble.js's assembleFromFacts
// only ever pushes at most one domain per Organisation today — but if
// multi-domain Organisations are ever populated, this needs an ADR-TI-001
// §4 amendment, not a silent guess here.

const { buildProvenance, ProvenanceMalformedInputError, ProvenanceVersionConflictError } = require('./provenance');

class TrustProfileMalformedInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrustProfileMalformedInputError';
    this.code = 'MALFORMED_INPUT';
  }
}

class ProvenanceConstructionError extends Error {
  constructor(cause) {
    super(`provenance construction failed: ${cause.message}`);
    this.name = 'ProvenanceConstructionError';
    this.code = 'PROVENANCE_CONSTRUCTION_FAILED';
    this.cause = cause;
  }
}

class TrustScoreEngineError extends Error {
  constructor(cause) {
    super(`Trust Score engine failed: ${cause.message}`);
    this.name = 'TrustScoreEngineError';
    this.code = 'TRUST_SCORE_ENGINE_FAILED';
    this.cause = cause;
  }
}

const VALID_TRIGGERS = ['scheduled', 'on-demand']; // 'exception-resolved' remains reserved, ADR-TI-001's deferred ruling

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// §6 — B-1, B-2, B-3 (this module's own input validation, narrower than and
// distinct from ENG-023 §16's full instance validation).
function validateInputs(organisationId, trigger, generatedAt) {
  if (!isNonEmptyString(organisationId)) {
    throw new TrustProfileMalformedInputError('organisationId must be a non-empty string');
  }
  if (!VALID_TRIGGERS.includes(trigger)) {
    throw new TrustProfileMalformedInputError(`trigger must be one of ${VALID_TRIGGERS.join(', ')}`);
  }
  if (!isNonEmptyString(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    throw new TrustProfileMalformedInputError('generatedAt must be a valid ISO-8601 timestamp');
  }
  if (Date.parse(generatedAt) > Date.now()) {
    throw new TrustProfileMalformedInputError('generatedAt must not be later than the current time');
  }
}

// The "zero observed everything" shape scoreTrust()'s own Aggregator
// deterministically produces when no signal is observed (A=0 < FLOOR,
// always true for any positive weight universe) — not a scoring decision of
// this module's own; applied only when there is no domain to call
// scoreTrust() against at all (see the module header note above).
function insufficientObservationDefault() {
  return {
    value: 'INSUFFICIENT_OBSERVATION',
    earned: 0,
    attainable: 0,
    completeness: 0,
    coreComplete: false,
    observedSignalCount: 0,
    componentBreakdown: [],
    categoryScores: {},
  };
}

/**
 * generateTrustProfile(organisationId, { trigger, generatedAt, deps }) →
 *   Promise<TrustProfileInstance>  (ENG-023 §6's nine fields)
 *
 * deps (all optional, defaulting to the canonical, already-governed
 * capabilities): assembleById, getSignalsForDomain, buildOrganisationHistory,
 * scoreTrust, RUBRIC, client (forwarded to buildOrganisationHistory),
 * includeIntegrityDigest.
 *
 * Throws TrustProfileMalformedInputError, ProvenanceConstructionError, or
 * TrustScoreEngineError — never returns a partial instance (ENG-029 §7).
 */
async function generateTrustProfile(organisationId, { trigger, generatedAt, deps = {} } = {}) {
  validateInputs(organisationId, trigger, generatedAt);

  const assembleById = deps.assembleById || require('../organisation/assemble').assembleById;
  const getSignalsForDomain = deps.getSignalsForDomain || require('../organisation/adapters/observatory').getSignalsForDomain;
  const buildOrganisationHistory = deps.buildOrganisationHistory || require('../observatory/projections/organisation-history').buildOrganisationHistory;
  const scoreTrust = deps.scoreTrust || require('../observatory/baseline/trust-score').scoreTrust;
  const RUBRIC = deps.RUBRIC || require('../observatory/baseline/trust-score').RUBRIC;

  // 1. Organisation identity — asserted once, treated as fixed (ADR-SYS-010 OC-6).
  const identity = await assembleById(organisationId);
  if (!identity.ok) {
    throw new TrustProfileMalformedInputError(`Organisation identity could not be resolved: ${identity.error}`);
  }
  const organisationDomains = (identity.organisation.domains || []).map((d) => d.domain);

  // 2. Per-domain Quality Model signal data — one read per domain, reused
  // unmodified for both the Trust Score call (domain 0 only, see header) and
  // the Provenance Builder (§4 step 3's no-transformation rule: the same
  // fetched rows feed both, never a second independent read).
  //
  // getSignalsForDomain's own field names (observed/score/qualityVersion) are
  // the Trust Score engine's expected shape and are passed through to it
  // unmodified below. ENG-025's Provenance Builder expects a differently-
  // named shape (qualityModelVersion/sourceRowRef) that this adapter did not
  // previously expose a stable row reference for at all — `rowId` was added
  // to observatory.js specifically to satisfy ENG-025 §8's already-frozen
  // sourceRowRef requirement (additive adapter fix, not a contract change).
  // The qualityModelVersion string (`<KEY>-QM-v<version>`) is a mechanical
  // label transform, not independent knowledge — it matches the Aggregator's
  // own internal QM_PREFIX convention exactly (every entry there is
  // `key.toUpperCase() + '-QM'`), restated here because that internal table
  // isn't exported, never reimplementing what version was assigned.
  const signalsByDomain = {};
  const provenanceSignalsByDomain = {};
  for (const domain of organisationDomains) {
    const rows = await getSignalsForDomain(domain);
    signalsByDomain[domain] = rows;
    provenanceSignalsByDomain[domain] = rows.map((row) => ({
      key: row.key,
      observed: !!row.observed,
      qualityModelVersion: row.observed && row.qualityVersion != null ? `${row.key.toUpperCase()}-QM-v${row.qualityVersion}` : undefined,
      collectedAt: row.observed ? row.collectedAt : undefined,
      sourceRowRef: row.observed && row.rowId != null ? String(row.rowId) : undefined,
    }));
  }

  // 3. Organisation History — the bounded, identifiable subset consumed.
  //
  // client defaults to the live Supabase client, exactly like every other
  // capability above — but ONLY when buildOrganisationHistory itself is also
  // the real (non-injected) implementation. When a caller injects its own
  // buildOrganisationHistory (unit tests), that mock owns its own contract
  // with `client` and this module must not force a real connection just to
  // populate an argument the mock doesn't need (BUG-1, found while validating
  // this module against live Repository Authority populations: every real
  // caller — runScheduledSweep, runOnDemandRegeneration, the API route — left
  // deps.client unset, so buildOrganisationHistory's own required-client
  // check threw for every single Organisation in production).
  const client = deps.client || (deps.buildOrganisationHistory ? undefined : require('../infra/database').getClient());
  const history = await buildOrganisationHistory(organisationId, { client });
  const organisationHistoryRefs = history.entries
    .map((e) => e.observationId)
    .filter((id) => id !== null && id !== undefined)
    .map(String);

  // 4. Canonical Trust Score — invoked once, as an opaque capability, reusing
  // the exact signal data already fetched in step 2 (never a second,
  // independent read) — see the module header's flagged domain-scoping note.
  let trustScoreResult;
  if (organisationDomains.length === 0) {
    trustScoreResult = insufficientObservationDefault();
  } else {
    const primaryDomain = organisationDomains[0];
    let raw;
    try {
      raw = await scoreTrust(primaryDomain, { getSignalsForDomain: async () => signalsByDomain[primaryDomain] });
    } catch (cause) {
      throw new TrustScoreEngineError(cause);
    }
    const insufficient = raw.label === 'INSUFFICIENT_OBSERVATION' || raw.score === 'INSUFFICIENT_OBSERVATION';
    trustScoreResult = {
      value: insufficient ? 'INSUFFICIENT_OBSERVATION' : raw.score,
      band: insufficient ? undefined : raw.band,
      earned: raw.earned,
      attainable: raw.attainable,
      completeness: raw.completeness,
      coreComplete: raw.coreComplete,
      observedSignalCount: raw.observedSignalCount,
      componentBreakdown: (raw.signals || []).map((s) => ({
        id: s.id,
        category: s.category,
        weight: s.weight,
        observed: s.status ? s.status === 'OBSERVED' : !!s.observed,
        earned: s.earned,
      })),
      categoryScores: Object.fromEntries(
        Object.entries(raw.categories || {}).map(([letter, v]) => [letter, { earned: v.earned, attainable: v.attainable }]),
      ),
    };
  }

  // 5. Provenance — delegated entirely to ENG-025's builder (§4). Single
  // invocation per generation call; failure propagated, never suppressed.
  let provenance;
  try {
    provenance = buildProvenance({
      organisationId,
      organisationDomains,
      generatedAt,
      trigger,
      signalsByDomain: provenanceSignalsByDomain,
      organisationHistoryRefs,
      aggregationMethodVersion: RUBRIC,
    }, { includeIntegrityDigest: !!deps.includeIntegrityDigest });
  } catch (cause) {
    if (cause instanceof ProvenanceMalformedInputError || cause instanceof ProvenanceVersionConflictError) {
      throw new ProvenanceConstructionError(cause);
    }
    throw cause;
  }

  // 6. Assemble the canonical nine-field instance (ENG-023 §6) — single pass,
  // organisationId/generatedAt/trigger set once here and supplied identically
  // to the Provenance Builder above, discharging ENG-023 V-11 (ENG-029 §10.3).
  const trustScoreOut = { value: trustScoreResult.value };
  if (trustScoreResult.band !== undefined) trustScoreOut.band = trustScoreResult.band;
  trustScoreOut.earned = trustScoreResult.earned;
  trustScoreOut.attainable = trustScoreResult.attainable;
  trustScoreOut.completeness = trustScoreResult.completeness;
  trustScoreOut.coreComplete = trustScoreResult.coreComplete;
  trustScoreOut.observedSignalCount = trustScoreResult.observedSignalCount;

  return {
    organisationId,
    organisationDomains,
    generatedAt,
    trigger,
    provenanceVector: provenance.provenanceVector,
    provenanceManifest: provenance.provenanceManifest,
    trustScore: trustScoreOut,
    componentBreakdown: trustScoreResult.componentBreakdown,
    categoryScores: trustScoreResult.categoryScores,
  };
}

module.exports = {
  generateTrustProfile,
  TrustProfileMalformedInputError,
  ProvenanceConstructionError,
  TrustScoreEngineError,
};
