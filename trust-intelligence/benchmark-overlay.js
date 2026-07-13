'use strict';

// Benchmark Overlay — ENG-014 WP-8, per ENG-023 §14 and ENG-008 §8,
// TI-CONST-001 TI-P-9/TI-P-10. No new constitutional specification.
//
// IMPLEMENTATION NOTE (flagged, not silently resolved): TI-P-9/ENG-008 §8
// require benchmark comparison to be computed live, against whichever
// Benchmark Cohort(s) currently apply — but no frozen document (ENG-023,
// ENG-025, ENG-029, ENG-032, ENG-008) defines what a "Benchmark Cohort" is
// for Trust Profile data specifically, or how cohort membership is
// determined. ENG-023 §14 itself says the overlay's shape is "owned by the
// Benchmarking capability, not this document" — that capability does not
// yet exist for Trust Profile Instances (only a legacy scans/prospects-based
// one does, backend/api/services/benchmarkAggregation.js, which ENG-008 §8
// explicitly notes is a separate, unmigrated read path). Inventing a
// cohort-comparison computation here would be new architecture this module
// has no authority to introduce.
//
// The honest, correct behaviour given that gap: this module always resolves
// to "no statistically valid benchmark currently exists" (ENG-008 §8's own
// prescribed wording) unless a real comparator is injected — never an
// error, never a blocked read (TI-P-9). This is not a placeholder pretending
// to be complete; it is the constitutionally required behaviour for the
// state that presently, honestly holds: no Trust-Profile-scoped Benchmark
// Cohort mechanism has been built yet. Building one is a separate, future
// capability, not a hole in this module.

/**
 * getBenchmarkOverlay(instance, deps) → object | null
 *
 * Returns the raw comparison payload (never yet labelled `live: true` — that
 * labelling is projections.js's job, applied once, at the point the overlay
 * is attached to the Authenticated Projection) or null if no valid
 * comparison currently exists for this instance.
 *
 * deps.compareToCohort(instance) — optional injection point for a future
 * Benchmarking capability; defaults to "no cohort exists" (see note above).
 */
async function getBenchmarkOverlay(instance, deps = {}) {
  const compareToCohort = deps.compareToCohort || (async () => null);
  const result = await compareToCohort(instance);
  return result || null;
}

module.exports = { getBenchmarkOverlay };
