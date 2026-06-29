'use strict';

// sra-report-profile.js — SRA-specific report metadata (the ONLY source-specific
// reporting code). Plugs into the generic report/coverage core; it adds NO generic
// reporting behaviour.
//
// SRA Snapshot Collector v0.1 — Reporting layer.

const { SOURCE_AUTHORITY } = require('./snapshot-source');

const SRA_REPORT_PROFILE = {
  sourceId: 'sra',
  sourceAuthority: SOURCE_AUTHORITY,
  serviceLabel: 'SRA Firm Data Web Service',
  // Mandatory attribution for re-used SRA data (terms of use).
  attribution: 'Includes data supplied by the Solicitors Regulation Authority.',
  // The organisational object types the SRA collector is expected to emit.
  expectedObjectTypes: ['sra.firm', 'sra.firm.field', 'sra.firm.office', 'sra.firm.office.field'],

  /** SRA-specific operational anomalies derived from the run model (metadata only; no scoring). */
  anomalies(model) {
    const out = [];
    const m = model.manifest || {};
    if (m && model.artefacts.manifest && m.snapshotProductionTimestamp == null) {
      out.push({ code: 'missing-production-timestamp', detail: 'snapshot production timestamp absent from manifest' });
    }
    return out;
  },
};

module.exports = { SRA_REPORT_PROFILE };
