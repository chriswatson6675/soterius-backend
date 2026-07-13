'use strict';

// Public/Authenticated projections — ENG-023 §13/§14. Strict, mechanical
// redactions of one canonical Trust Profile Instance (ADR-SYS-010 OC-7) —
// never a second computation. This module computes nothing about an
// Organisation's trust; it only selects and relabels fields already present
// on the instance handed to it.

// The Public Projection's signalFlags subset (ENG-023 §13: "a fixed, small,
// non-sensitive subset ... named by product decision outside this
// document's authority"). Chosen here, as the first concrete choice: which
// signal was observed, never its score/weight/earned value — the smallest
// selection that is still informative without exposing scored detail.
function publicProjection(instance) {
  const headlineScore = instance.trustScore.value;
  const projection = { headlineScore };
  if (instance.trustScore.band !== undefined) projection.band = instance.trustScore.band;
  projection.signalFlags = instance.componentBreakdown.map((c) => ({ id: c.id, observed: c.observed }));
  return projection;
}

// The Authenticated Projection — the full canonical instance, verbatim, plus
// an optional, clearly-labelled live overlay (ENG-023 §14). benchmarkOverlay
// is never merged into the instance's own fields.
function authenticatedProjection(instance, benchmarkOverlay) {
  const projection = { ...instance };
  if (benchmarkOverlay !== undefined && benchmarkOverlay !== null) {
    projection.benchmarkOverlay = { ...benchmarkOverlay, live: true };
  }
  return projection;
}

module.exports = { publicProjection, authenticatedProjection };
