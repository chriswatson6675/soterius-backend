'use strict';

// fca-report-profile.js — FCA-specific reporting metrics (the ONLY source-specific
// reporting code). Plugs into the generic report/coverage/health core.
//
// Reference Collector v0.1 — PHASE 8 (IMP-FCA-001 §8 "Additional Requirement":
// keep reporting generic; isolate source metrics). A future source (Companies
// House, ICO, …) supplies its own profile of the same shape.
//
// Authority: CCS-FCA-001 §14; IMP-FCA-001 §8.

// FSR-API status codes the FCA is known to emit (prefix families observed during
// ESD/EOI discovery). An unrecognised code is flagged as an operational anomaly
// for engineering review — NOT auto-amended into governance.
const KNOWN_FSR_PREFIX = /^FSR-API-\d{2}-\d{2}-\d{2}$/;

const FCA_PROFILE = {
  sourceId: 'fca',

  // The platform collection schema is uniform, so the generic classification holds.
  classify(summary) { return summary.outcome; },

  // FCA-specific operational anomalies on a preserved line summary.
  anomalies(summary) {
    const out = [];
    if (summary.fcaStatus && !KNOWN_FSR_PREFIX.test(summary.fcaStatus)) {
      out.push({ code: 'unexpected-fsr-status', detail: `FSR status '${summary.fcaStatus}' does not match the FSR-API-XX-XX-XX shape`, review: 'review EOI-FCA-001 §8 status codes' });
    }
    return out;
  },
};

module.exports = { FCA_PROFILE };
