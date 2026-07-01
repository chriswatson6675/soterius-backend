'use strict';
// observation-writer.js — SOT-RETENTIONTRANSPARENCY-001 (H-SIG-002) evidence construction.
//
// Mirrors the H-SIG-001 (disclosurecurrency) observation writer. Maintains the EM-H-D1
// separation between PROCESS state (located_state) and EVIDENCE state:
//   - non-located rows carry NO evidence_state (NULL) — structurally enforced by the DB
//     CHECK constraint evidence_only_when_located in migration 020;
//   - located rows with empty/partial content -> `indeterminate` (cannot assert absence);
//   - located rows with content -> the detector's evidence fact.
//
// No scores, ratings, confidence, or interpretation are produced.

const crypto = require('crypto');

function sha256(value) {
  return value ? crypto.createHash('sha256').update(value).digest('hex') : null;
}

// Persistence-layer robustness (shared): strip bytes PostgreSQL cannot store as text/JSON —
// the NUL code point (U+0000, the "unsupported Unicode escape sequence" cause) and lone
// surrogates — before content_observed is detected-on and stored. Deterministic; preserves all
// other content exactly. Does NOT affect detector behaviour (these match no detector pattern);
// keeping detector input == stored content preserves the re-derivation invariant.
// NUL matcher is built from a code point (not a source escape/byte) to keep the source clean.
const NUL_RE = new RegExp(String.fromCharCode(0), 'g');
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g;

function sanitizeForPg(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(NUL_RE, '')
    .replace(LONE_HIGH_SURROGATE, '')
    .replace(LONE_LOW_SURROGATE, '$1');
}

// EM-H-D1 routing for the Retention Specification element (DE-PAD-015).
function deriveEvidence(locatedState, contentObserved, detectorResult) {
  if (locatedState !== 'located') {
    return { evidence_state: null, retention_raw_value: null, retention_form: null };
  }
  // Located but nothing (or only whitespace) was retrieved: partial retrieval — absence
  // cannot be asserted, so resolve to indeterminate (EM-H-D1 safeguard).
  if (typeof contentObserved !== 'string' || contentObserved.trim() === '') {
    return { evidence_state: 'indeterminate', retention_raw_value: null, retention_form: null };
  }
  const r = detectorResult || { state: null, rawValue: null, form: null };
  return {
    evidence_state: r.state,
    retention_raw_value: r.rawValue != null ? r.rawValue : null,
    retention_form: r.form != null ? r.form : null,
  };
}

module.exports = { deriveEvidence, sha256, sanitizeForPg };
