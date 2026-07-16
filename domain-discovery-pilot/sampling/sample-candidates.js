'use strict';

// sample-candidates.js — orchestrates the Domain Discovery Pilot's stratified,
// deterministic, exactly-100-record sample (Step 1 of the approved pilot
// spec). No I/O of its own beyond what is explicitly injected — the HMRC
// adapter and dataset bytes are passed in by the caller (run-pilot.js in
// production, fixtures in tests), so this module is trivially testable
// offline and its output is a pure function of its inputs.
//
// Source-of-truth note: the HMRC adapter's normalise() output (index.js) is
// the canonical Organisation-source shape and does NOT carry postcode (by
// design — postcode is not part of that canonical record). Since this
// pilot's classification needs postcode, this module calls parse() ->
// validateStructure() -> normalise() exactly as specified, and additionally
// keeps the parsed/validated row (which still has postcode) alongside each
// normalised record, joining the two 1:1 by array index — both normalise()
// and validateStructure().valid are order-preserving maps over the same
// input array, so this join is safe and introduces no guessing.

const { normaliseRegisterId } = require('../../authority/lib/normalise');
const { classifyCandidate, DERIVED_CATEGORIES, postcodeCompletenessClass } = require('./classify-candidate');

const TARGET_SAMPLE_SIZE = 100;
const CATEGORY_FLOOR = 4;

// Fixed version tag for the representative-selection rule below — bump this
// (never silently change behaviour under the same tag) if the rule changes.
const DEDUP_RULE_VERSION = 'DDP-DEDUP-v1.0';

// Lower rank = more complete = preferred. Matches classify-candidate.js's
// own POSTCODE_COMPLETE > POSTCODE_PARTIAL > POSTCODE_MISSING ordering.
const POSTCODE_COMPLETENESS_RANK = { POSTCODE_COMPLETE: 0, POSTCODE_PARTIAL: 1, POSTCODE_MISSING: 2 };

/**
 * deduplicateByRegistrationNumber(rawPool) -> [{ ...oneRecordPerGroup,
 *   sourceRowCount, representsMultipleBranches, representativeSelectionRuleVersion }]
 *
 * The real HMRC AML register represents a multi-branch business (e.g. a
 * nationwide retail chain) as one row PER BRANCH, all sharing the same
 * registrationNumber — confirmed against the live dataset, where a single
 * registration accounted for 6,733 rows. Sampling before this fix operated
 * at the row level, so such a chain could dominate a sample slot for slot.
 * This groups the raw pool by normalised registrationNumber and picks
 * exactly one deterministic representative per group, BEFORE any
 * stratified classification runs — stratification and selection then see
 * one candidate per real-world registration, never per branch row.
 *
 * Representative-selection rule (fixed, deterministic, no randomness/clock):
 *   1. Most complete postcode wins (POSTCODE_COMPLETE > PARTIAL > MISSING).
 *   2. Among ties, a non-empty tradingName is preferred over an empty one.
 *   3. Among ties, the earliest original source-row order wins (stable).
 *   4. Final tie-break: lexical postcode string comparison.
 * This does not merge or rewrite the underlying HMRC source rows — it only
 * selects which single row represents the registration in the pilot's own
 * sample; every row the adapter emitted remains exactly as emitted.
 */
function deduplicateByRegistrationNumber(rawPool) {
  const groups = new Map(); // normalised registrationNumber (or a unique fallback key) -> rows[]
  for (const row of rawPool) {
    const key = normaliseRegisterId(row.registrationNumber) || `__NO_REG_NUM__${row.__poolIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const representatives = [];
  for (const rows of groups.values()) {
    const sourceRowCount = rows.length;
    const best = [...rows].sort((a, b) => {
      const rankA = POSTCODE_COMPLETENESS_RANK[postcodeCompletenessClass(a.postcode)];
      const rankB = POSTCODE_COMPLETENESS_RANK[postcodeCompletenessClass(b.postcode)];
      if (rankA !== rankB) return rankA - rankB;

      const hasTradingA = String(a.tradingName || '').trim().length > 0 ? 0 : 1;
      const hasTradingB = String(b.tradingName || '').trim().length > 0 ? 0 : 1;
      if (hasTradingA !== hasTradingB) return hasTradingA - hasTradingB;

      if (a.__poolIndex !== b.__poolIndex) return a.__poolIndex - b.__poolIndex;

      const pcA = String(a.postcode || '');
      const pcB = String(b.postcode || '');
      return pcA < pcB ? -1 : pcA > pcB ? 1 : 0;
    })[0];

    representatives.push({
      ...best,
      sourceRowCount,
      representsMultipleBranches: sourceRowCount > 1,
      representativeSelectionRuleVersion: DEDUP_RULE_VERSION,
    });
  }
  return representatives;
}

// Pass-1 floor targets, in fixed priority order. Each entry names either a
// single classification value or a set of values ("states") that jointly
// count toward one floor (POSTCODE_MISSING combined with POSTCODE_PARTIAL).
const FLOOR_SPECS = [
  { label: 'POSTCODE_MISSING_OR_PARTIAL', dimension: 'postcodeCompletenessClass', states: ['POSTCODE_MISSING', 'POSTCODE_PARTIAL'], target: 10 },
  { label: 'NAME_DIVERGENT', dimension: 'nameDivergenceClass', states: ['NAME_DIVERGENT'], target: 20 },
  { label: 'HIGHLY_GENERIC', dimension: 'nameAmbiguityClass', states: ['HIGHLY_GENERIC'], target: 15 },
  { label: 'MODERATELY_AMBIGUOUS', dimension: 'nameAmbiguityClass', states: ['MODERATELY_AMBIGUOUS'], target: 15 },
  { label: 'DISTINCTIVE', dimension: 'nameAmbiguityClass', states: ['DISTINCTIVE'], target: 15 },
  { label: 'CORPORATE_FORM', dimension: 'entityFormClass', states: ['CORPORATE_FORM'], target: 15 },
  { label: 'SOLE_TRADER_OR_OTHER', dimension: 'entityFormClass', states: ['SOLE_TRADER_OR_OTHER'], target: 15 },
  { label: 'RURAL', dimension: 'urbanRuralClass', states: ['RURAL'], target: 10 },
];

function regionFloorSpecsForCohort(classified) {
  const regionsPresent = new Set(classified.map((c) => c.classification.regionClass));
  return [...regionsPresent].sort().map((region) => ({
    label: `REGION_${region}`, dimension: 'regionClass', states: [region], target: 1,
  }));
}

/**
 * Largest-remainder (Hare-quota) apportionment across categories present in
 * the cohort, with a floor of min(4, count_C) per category, remaining slots
 * apportioned proportional to count_C, capped at count_C per category.
 */
function apportionCategoryTargets(countsByCategory, totalSlots) {
  const categories = DERIVED_CATEGORIES.filter((c) => (countsByCategory[c] || 0) > 0);
  const totalPool = categories.reduce((sum, c) => sum + countsByCategory[c], 0);
  const sampleSize = Math.min(totalSlots, totalPool);

  const floors = {};
  let floorSum = 0;
  for (const c of categories) {
    floors[c] = Math.min(CATEGORY_FLOOR, countsByCategory[c]);
    floorSum += floors[c];
  }

  const targets = {};
  for (const c of DERIVED_CATEGORIES) targets[c] = 0;
  Object.assign(targets, floors);
  let remaining = sampleSize - floorSum;

  if (remaining > 0) {
    // Proportional share of the remainder, by count_C, largest-remainder rounding.
    const shares = categories.map((c) => {
      const capacityLeft = countsByCategory[c] - floors[c];
      const exactShare = totalPool > 0 ? (remaining * countsByCategory[c]) / totalPool : 0;
      return { category: c, capacityLeft, exact: exactShare, floor: Math.floor(exactShare) };
    });

    let allocated = 0;
    for (const s of shares) {
      const grant = Math.min(s.floor, s.capacityLeft);
      targets[s.category] += grant;
      allocated += grant;
    }

    let leftover = remaining - allocated;
    // Distribute leftover by largest remainder, tie-broken by fixed category
    // priority order (DERIVED_CATEGORIES order), skipping categories at
    // capacity. Repeated round-robin passes (not a single pass) so that
    // leftover skipped past a capacity-exhausted category is still placed
    // somewhere with room, rather than being silently dropped.
    const byRemainder = shares
      .map((s) => ({ ...s, remainder: s.exact - Math.floor(s.exact) }))
      .sort((a, b) => {
        if (b.remainder !== a.remainder) return b.remainder - a.remainder;
        return DERIVED_CATEGORIES.indexOf(a.category) - DERIVED_CATEGORIES.indexOf(b.category);
      });

    let progress = true;
    while (leftover > 0 && progress) {
      progress = false;
      for (const s of byRemainder) {
        if (leftover <= 0) break;
        const capacityLeft = countsByCategory[s.category] - targets[s.category];
        if (capacityLeft <= 0) continue;
        targets[s.category] += 1;
        leftover -= 1;
        progress = true;
      }
    }
    // If capacity across every category is exhausted before leftover is
    // fully placed (only possible when totalPool < sampleSize, already
    // handled by sampleSize = min(totalSlots, totalPool) above), the while
    // loop above simply terminates with progress=false — no further action.
  }

  return { targets, sampleSize };
}

/**
 * Two-pass deterministic selection over an already-classified pool.
 * pool: [{ registrationNumber, businessName, tradingName, postcode, classification }]
 */
function selectSample(pool, sampleSize, categoryTargets) {
  const byRegNum = (a, b) => {
    const ra = normaliseRegisterId(a.registrationNumber) || '';
    const rb = normaliseRegisterId(b.registrationNumber) || '';
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  };

  const sortedPool = [...pool].sort(byRegNum);
  const selected = new Map(); // key -> record
  const selectedKey = (r) => `${normaliseRegisterId(r.registrationNumber) || ''}#${r.__poolIndex}`;

  const categoryRemainingCapacity = {};
  for (const c of DERIVED_CATEGORIES) categoryRemainingCapacity[c] = categoryTargets[c] || 0;

  const floorPassSelectedKeys = new Set();
  const unreachableFloors = [];

  function tryAdd(record) {
    const key = selectedKey(record);
    if (selected.has(key)) return false;
    const cat = record.classification.derivedCategory;
    if ((categoryRemainingCapacity[cat] || 0) <= 0) return false;
    selected.set(key, record);
    categoryRemainingCapacity[cat] -= 1;
    return true;
  }

  // ── Pass 1: floor guarantee ────────────────────────────────────────────
  const allFloorSpecs = [...FLOOR_SPECS, ...regionFloorSpecsForCohort(pool.map((r) => ({ classification: r.classification })))];

  for (const spec of allFloorSpecs) {
    let currentCount = [...selected.values()].filter((r) => spec.states.includes(r.classification[spec.dimension])).length;
    // Overall target counts existing selections plus new picks needed.
    let reached = currentCount >= spec.target;
    let anyEligible = false;
    while (!reached) {
      const candidate = sortedPool.find((r) => {
        if (selected.has(selectedKey(r))) return false;
        if (!spec.states.includes(r.classification[spec.dimension])) return false;
        const cat = r.classification.derivedCategory;
        return (categoryRemainingCapacity[cat] || 0) > 0;
      });
      if (!candidate) break;
      anyEligible = true;
      tryAdd(candidate);
      floorPassSelectedKeys.add(selectedKey(candidate));
      currentCount += 1;
      reached = currentCount >= spec.target;
    }
    if (!reached && !anyEligible && currentCount === 0) {
      unreachableFloors.push(spec.label);
    } else if (!reached) {
      unreachableFloors.push(`${spec.label} (partial: ${currentCount}/${spec.target})`);
    }
  }

  // ── Pass 2: category fill ─────────────────────────────────────────────
  for (const cat of DERIVED_CATEGORIES) {
    const target = categoryTargets[cat] || 0;
    let currentCount = [...selected.values()].filter((r) => r.classification.derivedCategory === cat).length;
    if (currentCount >= target) continue;
    const catPoolSorted = sortedPool.filter((r) => r.classification.derivedCategory === cat);
    for (const record of catPoolSorted) {
      if (currentCount >= target) break;
      if (selected.size >= sampleSize) break;
      if (selected.has(selectedKey(record))) continue;
      if (tryAdd(record)) currentCount += 1;
    }
    if (selected.size >= sampleSize) break;
  }

  // ── Final ordering + sample_rank ──────────────────────────────────────
  const finalSelected = [...selected.values()].sort(byRegNum);
  finalSelected.forEach((record, idx) => {
    record.sampleRank = idx + 1;
    record.floorPassSelected = floorPassSelectedKeys.has(selectedKey(record));
  });

  return { selected: finalSelected, unreachableFloors };
}

/**
 * sampleCandidates({ rawOdsBuffer, hmrcAdapter, context }) -> {
 *   candidates: [...], sampleSize, totalValidRecords, categoryTargets,
 *   unreachableFloors, exceptionApplied
 * }
 *
 * hmrcAdapter: injectable (defaults to the real backend/pae/adapters/hmrc-aml
 * module) — { parse, validateStructure, normalise }.
 */
async function sampleCandidates({ rawOdsBuffer, hmrcAdapter, context = {} } = {}) {
  const adapter = hmrcAdapter || require('../../pae/adapters/hmrc-aml');

  const parsedRows = await adapter.parse(rawOdsBuffer);
  const { valid } = adapter.validateStructure(parsedRows);
  const normalised = adapter.normalise(valid, context);

  const rawPool = valid.map((rawRow, i) => {
    const canonical = normalised[i] || {};
    return {
      registrationNumber: rawRow.registrationNumber,
      businessName: canonical.name || rawRow.businessName,
      tradingName: canonical.tradingName ?? rawRow.tradingName,
      postcode: rawRow.postcode,
      __poolIndex: i,
    };
  });

  // Deduplicate BEFORE classification/stratification — one candidate per
  // real-world HMRC registration, never one per branch row (see
  // deduplicateByRegistrationNumber's own header comment).
  const pool = deduplicateByRegistrationNumber(rawPool).map((record) => {
    record.classification = classifyCandidate(record);
    return record;
  });

  const totalValidRecords = pool.length;
  const sampleSizeTarget = Math.min(TARGET_SAMPLE_SIZE, totalValidRecords);
  const exceptionApplied = totalValidRecords < TARGET_SAMPLE_SIZE;

  const countsByCategory = {};
  for (const c of DERIVED_CATEGORIES) countsByCategory[c] = 0;
  for (const r of pool) countsByCategory[r.classification.derivedCategory] += 1;

  const { targets, sampleSize } = apportionCategoryTargets(countsByCategory, sampleSizeTarget);
  const { selected, unreachableFloors } = selectSample(pool, sampleSize, targets);

  const candidates = selected.map((r) => ({
    hmrcRegistrationNumber: r.registrationNumber,
    businessName: r.businessName,
    tradingName: r.tradingName,
    postcode: r.postcode,
    sampleRank: r.sampleRank,
    derivedCategory: r.classification.derivedCategory,
    nameAmbiguityClass: r.classification.nameAmbiguityClass,
    nameDivergenceClass: r.classification.nameDivergenceClass,
    entityFormClass: r.classification.entityFormClass,
    postcodeCompletenessClass: r.classification.postcodeCompletenessClass,
    regionClass: r.classification.regionClass,
    urbanRuralClass: r.classification.urbanRuralClass,
    floorPassSelected: r.floorPassSelected,
    samplingRuleVersion: r.classification.samplingRuleVersion,
    sourceRowCount: r.sourceRowCount,
    representsMultipleBranches: r.representsMultipleBranches,
    representativeSelectionRuleVersion: r.representativeSelectionRuleVersion,
  }));

  return {
    candidates,
    sampleSize: candidates.length,
    // totalValidRecords now counts DISTINCT registrations post-dedup (what
    // stratification actually sees) — totalValidSourceRows preserves the
    // original raw HMRC row count so neither figure is silently lost.
    totalValidRecords,
    totalValidSourceRows: valid.length,
    categoryTargets: targets,
    unreachableFloors,
    exceptionApplied,
  };
}

module.exports = {
  TARGET_SAMPLE_SIZE,
  CATEGORY_FLOOR,
  FLOOR_SPECS,
  DEDUP_RULE_VERSION,
  apportionCategoryTargets,
  deduplicateByRegistrationNumber,
  selectSample,
  sampleCandidates,
};
