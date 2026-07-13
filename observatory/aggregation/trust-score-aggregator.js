'use strict';

/*
 * Canonical Trust Score Aggregator — ENG-026
 * ===========================================
 *
 * The missing aggregation layer: reads each signal's already-calibrated
 * signal_quality_*.final_score (0–100, produced by a frozen Quality Model)
 * and combines them, per SLG-014 category and TSW-METH-v1.0 weight, into
 * the canonical 001–999 Trust Score defined by SLG-030–038's aggregation
 * lineage (SLG-035 §2).
 *
 * Governing principle — aggregate, do not re-score (ENG-026 §0). This
 * layer's only computation is: weight, sum, normalize, floor-guard. It
 * never reads a signal_facts_* table and never re-implements a maturity
 * curve, threshold, or policy judgement any *-quality.js module already
 * owns — finalScore_i already encodes that calibrated assessment.
 *
 * Its only data source is getSignalsForDomain() (organisation/adapters/
 * observatory.js) — reused, not duplicated — and the active row of
 * trust_score_weight_sets (a governed, versioned artifact; weights are
 * NEVER hardcoded here, per SLG-135 §0).
 */

const { getClient } = require('../../infra/database');

// SLG-014 canonical category letters (ENG-026 §3, corrected mapping —
// mtasts is D, not the presentation-only "Email Trust" grouping).
const CATEGORY_OF = {
  spf: 'A', dkim: 'A', dmarc: 'A',
  dnssec: 'B', caa: 'B',
  securityheaders: 'C', securitytxt: 'C',
  tls: 'D', certificate: 'D', mtasts: 'D',
};
const CATEGORIES = ['A', 'B', 'C', 'D'];
const IN_SCOPE_SIGNALS = Object.keys(CATEGORY_OF);

// Frozen Quality Model identity per signal (backend/observatory/quality/*-quality.js
// MODEL_ID constants) — combined with the row's own quality_version for provenance
// (ENG-026 §8.1). Never used for scoring, explainability only.
const QM_PREFIX = {
  spf: 'SPF-QM', dkim: 'DKIM-QM', dmarc: 'DMARC-QM', dnssec: 'DNSSEC-QM', caa: 'CAA-QM',
  securityheaders: 'SECURITYHEADERS-QM', securitytxt: 'SECURITYTXT-QM',
  tls: 'TLS-QM', certificate: 'CERTIFICATE-QM', mtasts: 'MTASTS-QM',
};

const round_half_up = (x) => Math.floor(x + 0.5);
const round3 = (x) => Math.round(x * 1000) / 1000; // avoid float noise in earned/attainable output

let cachedWeightSet = null;

// The Aggregator must never hardcode a weight table (SLG-135 §0) — it reads
// the single active, versioned row of trust_score_weight_sets. In-process
// cached: weight-set changes are baseline-frequency events, not per-request.
async function getActiveWeightSet(deps = {}) {
  if (deps.weightSet) return deps.weightSet;
  if (cachedWeightSet && !deps.bypassCache) return cachedWeightSet;

  const sb = (deps.getClient || getClient)();
  const { data, error } = await sb
    .from('trust_score_weight_sets')
    .select('weight_set_id, method_version, weights')
    .eq('is_active', true)
    .limit(1);

  if (error) throw new Error(`trust_score_weight_sets: ${error.message}`);
  if (!data || !data.length) throw new Error('trust_score_weight_sets: no active weight set found');

  const row = data[0];
  const weightSet = { weightSetId: row.weight_set_id, methodVersion: row.method_version, weights: row.weights };
  cachedWeightSet = weightSet;
  return weightSet;
}

/*
 * computeTrustScore(domain, deps) — ENG-026 §10's sole exported entry point.
 *
 * deps (all optional, for testability / AC-2 purity verification):
 *   getSignalsForDomain(domain) → Array<per-signal object> (defaults to the
 *     canonical organisation/adapters/observatory.js implementation)
 *   weightSet — an already-resolved { weightSetId, methodVersion, weights }
 *     object, bypassing the DB read entirely (used by unit tests)
 */
async function computeTrustScore(domain, deps = {}) {
  const getSignals = deps.getSignalsForDomain || require('../../organisation/adapters/observatory').getSignalsForDomain;
  const [signalRows, weightSet] = await Promise.all([
    getSignals(domain),
    getActiveWeightSet(deps),
  ]);

  const byKey = new Map(signalRows.map((s) => [s.key, s]));

  const categories = {};
  for (const cat of CATEGORIES) categories[cat] = { earned: 0, attainable: 0, signals: [] };

  const signals = [];
  let E = 0, A = 0;

  for (const key of IN_SCOPE_SIGNALS) {
    const category = CATEGORY_OF[key];
    categories[category].signals.push(key);

    const weight = weightSet.weights[key];
    const row = byKey.get(key);
    const observed = !!(row && row.observed);

    if (!observed) {
      signals.push({ id: key, category, status: 'NON_OBSERVED', earned: 0, weight, qualityModelVersion: null, collectedAt: null });
      continue;
    }

    // finalScore_i (0–100) is already the frozen Quality Model's calibrated
    // assessment — this layer only weights and sums it (ENG-026 §4).
    const earned = round3((Number(row.score) / 100) * weight);
    E += earned;
    A += weight;
    categories[category].earned = round3(categories[category].earned + earned);
    categories[category].attainable += weight;

    signals.push({
      id: key,
      category,
      status: 'OBSERVED',
      earned,
      weight,
      qualityModelVersion: row.qualityVersion ? `${QM_PREFIX[key]}-v${row.qualityVersion}` : null,
      collectedAt: row.collectedAt || null,
    });
  }

  // FLOOR = 50% of the full in-scope weight universe must be OBSERVED (ENG-026 §6.1).
  const weightUniverse = IN_SCOPE_SIGNALS.reduce((sum, k) => sum + weightSet.weights[k], 0);
  const FLOOR = Math.ceil(0.5 * weightUniverse);

  let score, label;
  if (A < FLOOR) {
    score = 0;
    label = 'INSUFFICIENT_OBSERVATION';
  } else {
    const raw = (E / A) * 999;
    score = Math.min(999, Math.max(1, round_half_up(raw)));
    label = 'SCORED';
  }

  return {
    score,
    label,
    weightSetId: weightSet.weightSetId,
    methodVersion: weightSet.methodVersion,
    earned: round3(E),
    attainable: A,
    categories,
    signals,
  };
}

module.exports = { computeTrustScore, getActiveWeightSet, CATEGORY_OF, CATEGORIES, IN_SCOPE_SIGNALS };
