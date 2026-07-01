'use strict';

// Organisation Provider — IF (Investment Firms) cohort
//
// Concrete Organisation Provider for the frozen IF-001 cohort. It returns the
// cohort by reading the manifest produced by select-cohort.js. Selected at
// runtime by organisation-provider.js (the provider factory). Behaviour is
// unchanged from the Step-1 inline implementation — same organisations, same
// metadata, same ordering.
//
// Provider contract — loadOrganisations() returns a Cohort:
//   {
//     cohort_id:     string,                                    // 'IF-001'
//     cohort_name:   string,
//     selection_id:  string,                                    // provenance id for this selection
//     n:             number,                                    // organisation count
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }
// Only `domain` is required by the scanners; the remaining fields are carried
// through unchanged for reporting and provenance.

const fs   = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');

function loadOrganisations() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    const err = new Error('cohort-manifest.json not found');
    err.code = 'COHORT_MANIFEST_NOT_FOUND';
    throw err;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  return {
    cohort_id:     manifest.cohort_id,
    cohort_name:   manifest.cohort_name,
    selection_id:  manifest.selection_id,
    n:             manifest.n,
    organisations: manifest.firms,
  };
}

module.exports = { loadOrganisations, MANIFEST_PATH };
