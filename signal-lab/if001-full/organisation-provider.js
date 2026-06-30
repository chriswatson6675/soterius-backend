'use strict';

// Organisation Provider — factory / selection point
//
// The Observatory (run-all.js) obtains the organisations it scans through an
// Organisation Provider. This module is the single place that decides WHICH
// concrete provider supplies them; the scanning pipeline simply calls
// loadOrganisations() and never knows or cares where organisations originate.
//
// Selection is by configuration (the ORG_PROVIDER environment variable), so no
// IF/FCA branching leaks into the Observatory:
//
//   ORG_PROVIDER unset | 'if' | 'if-001'   → IF (Investment Firms) cohort   [default]
//   ORG_PROVIDER       = 'fca'             → FCA Organisation Registry
//
// Adding a future population (e.g. SRA Organisation Registry) means adding one
// concrete provider module and one case below — the scanning pipeline is untouched.
//
// Every concrete provider satisfies the same contract:
//   loadOrganisations() → {
//     cohort_id, cohort_name, selection_id, n,
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }

const ifProvider  = require('./if-organisation-provider');
const fcaProvider = require('../population-acquisition/fca-organisation-provider');

const PROVIDERS = {
  if:       ifProvider,
  'if-001': ifProvider,
  fca:      fcaProvider,
};

function getProvider() {
  const key = String(process.env.ORG_PROVIDER || 'if').toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown ORG_PROVIDER '${key}' — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

function loadOrganisations() {
  return getProvider().loadOrganisations();
}

module.exports = { loadOrganisations, getProvider };
