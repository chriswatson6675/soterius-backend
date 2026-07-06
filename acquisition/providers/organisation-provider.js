'use strict';

// Organisation Provider — factory / selection point
//
// The Observatory (run-all.js) obtains the organisations it scans through an
// Organisation Provider. This module is the single place that decides WHICH
// concrete provider supplies them; the scanning pipeline simply calls
// loadOrganisations() and never knows or cares where organisations originate.
//
// The Observatory now resolves organisations EXCLUSIVELY through the canonical
// Organisation Dataset (the Repository Authority), selecting every organisation
// whose domain state is VERIFIED. It references NO legacy cohort registry
// (IF / FCA / SRA providers). Those legacy providers have been superseded and
// archived; the Observatory execution path no longer depends on them.
//
// Every concrete provider satisfies the same contract:
//   loadOrganisations() → {
//     cohort_id, cohort_name, selection_id, n,
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }

const canonicalProvider = require('./canonical-organisation-provider');

// Legacy cohort providers (if / fca / sra) — retained only for historical
// provenance and rejected from the operational path. Any attempt to select one
// fails loudly so no Observatory run can silently fall back to a legacy registry.
const RETIRED_LEGACY_KEYS = new Set(['if', 'if-001', 'fca', 'sra']);

function getProvider() {
  const key = String(process.env.ORG_PROVIDER || 'canonical').toLowerCase();
  if (key === 'canonical' || key === 'authority' || key === 'org-authority') {
    return canonicalProvider;
  }
  if (RETIRED_LEGACY_KEYS.has(key)) {
    throw new Error(
      `ORG_PROVIDER='${key}' is a retired legacy cohort registry. The Observatory now ` +
      `sources organisations only from the canonical Organisation Dataset ` +
      `(VERIFIED domains). Unset ORG_PROVIDER or set it to 'canonical'.`,
    );
  }
  throw new Error(`Unknown ORG_PROVIDER '${key}' — the only supported value is 'canonical'.`);
}

function loadOrganisations() {
  return getProvider().loadOrganisations();
}

module.exports = { loadOrganisations, getProvider };
