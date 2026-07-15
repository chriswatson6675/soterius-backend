'use strict';

// postcode-normalise.js — a new, pilot-local postcode normaliser. No
// postcode normaliser exists in authority/lib/normalise.js (verified in
// Step 0) — this is deliberately new, small, and scoped to this pilot only.

const UK_POSTCODE_CORE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

/**
 * normalisePostcode(raw) -> canonical "OUTWARD INWARD" string, or null if
 * the input is not a plausible UK postcode shape. Uppercases, strips all
 * whitespace, then reinserts a single space before the last 3 characters
 * (the inward code is always exactly 3 characters: digit + 2 letters).
 */
function normalisePostcode(raw) {
  if (raw === null || raw === undefined) return null;
  const stripped = String(raw).toUpperCase().replace(/\s+/g, '');
  if (stripped.length < 5 || stripped.length > 7) return null;
  if (!UK_POSTCODE_CORE_RE.test(stripped)) return null;
  const inward = stripped.slice(-3);
  const outward = stripped.slice(0, -3);
  return `${outward} ${inward}`;
}

module.exports = { normalisePostcode };
