'use strict';
// observation-writer.js — SOT-TRANSFERSAFEGUARD-001 (H-SIG-003) evidence construction.
// Mirrors the H-SIG-001/002 writers. EM-H-D1: non-located => NULL evidence (DB-enforced);
// located + empty/partial content => indeterminate; located + content => detector fact.
// Reuses sanitizeForPg + sha256 from the retention writer (shared persistence layer).

const { sanitizeForPg, sha256 } = require('../retentiontransparency/observation-writer');

function deriveEvidence(locatedState, contentObserved, detectorResult) {
  if (locatedState !== 'located') {
    return { evidence_state: null, transfer_raw_value: null, transfer_form: null };
  }
  if (typeof contentObserved !== 'string' || contentObserved.trim() === '') {
    return { evidence_state: 'indeterminate', transfer_raw_value: null, transfer_form: null };
  }
  const r = detectorResult || { state: null, rawValue: null, form: null };
  return {
    evidence_state: r.state,
    transfer_raw_value: r.rawValue != null ? r.rawValue : null,
    transfer_form: r.form != null ? r.form : null,
  };
}

module.exports = { deriveEvidence, sanitizeForPg, sha256 };
