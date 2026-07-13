'use strict';

// change-indicator.js — ENG-014 Portfolio Management: a small pure function
// over an Organisation's Trust Profile History (store.getHistory()'s own
// return shape — Array<{ generatedAt, instance }>, ENG-023 §11). Computes no
// trust score of its own; it only compares two already-computed
// `trustScore.value`s (ENG-023 §9) pulled from existing instances.
//
// Honesty note (TI-CONST-001 TI-P-9 / ENG-023 §9,§12): `trustScore.value` can
// be the literal string "INSUFFICIENT_OBSERVATION" instead of a number. This
// function never coerces that into 0 or drops it — `current`/`previous` are
// passed through verbatim, and `delta`/`direction` are only computed when
// both values are actually numeric; otherwise they stay `null` rather than
// imply a numeric comparison that didn't really happen.

function scoreValueOf(entry) {
  return entry.instance.trustScore.value;
}

/**
 * computeChangeIndicator(history) — history is store.getHistory()'s return
 * value for one organisation. Does not assume array order (the store
 * currently returns oldest-first, but this function re-sorts defensively by
 * generatedAt so it stays correct even if that ordering ever changes).
 */
function computeChangeIndicator(history) {
  if (!history || history.length === 0) {
    return { status: 'no-data' };
  }

  const sorted = [...history].sort(
    (a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime(),
  );

  if (sorted.length === 1) {
    return {
      status: 'new',
      current: scoreValueOf(sorted[sorted.length - 1]),
      previous: null,
      delta: null,
      direction: null,
    };
  }

  const current = scoreValueOf(sorted[sorted.length - 1]);
  const previous = scoreValueOf(sorted[sorted.length - 2]);

  let delta = null;
  let direction = null;
  if (typeof current === 'number' && typeof previous === 'number') {
    // Round to 2dp — scores in this codebase are not guaranteed integers
    // (e.g. weighted composites), and raw floating-point subtraction can
    // produce noise like 0.30000000000000004.
    delta = Math.round((current - previous) * 100) / 100;
    direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  }

  return { status: 'ok', current, previous, delta, direction };
}

module.exports = { computeChangeIndicator };
