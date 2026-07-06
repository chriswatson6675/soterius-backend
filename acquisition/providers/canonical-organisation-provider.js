'use strict';

// Canonical Organisation Provider — the Observatory's single source of organisations.
//
// Reads the canonical Organisation Dataset (the Repository Authority,
// backend/authority/dataset/organisations.ndjson) and yields every organisation
// whose domain state is VERIFIED — and nothing else (spec: "Every organisation
// with a VERIFIED domain. Nothing else."). PENDING and NO_DOMAIN organisations
// are never scanned.
//
// This provider references NO legacy cohort registry. From here on the Observatory
// resolves organisations exclusively through the canonical dataset and their
// immutable Organisation IDs.
//
// Satisfies the standard provider contract:
//   loadOrganisations() → {
//     cohort_id, cohort_name, selection_id, n,
//     organisations: Array<{ id, firm_name, domain, last_scanned }>
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COHORT_ID = 'ORG-AUTHORITY-001';
const COHORT_NAME = 'Canonical Organisation Dataset (Repository Authority)';

const DATASET_PATH = process.env.ORG_DATASET_PATH
  || path.join(__dirname, '..', '..', 'authority', 'dataset', 'organisations.ndjson');

// Deterministic selection id bound to the exact dataset contents.
function selectionIdFor(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `org-authority-${hash}`;
}

function loadOrganisations() {
  if (!fs.existsSync(DATASET_PATH)) {
    const err = new Error(`Canonical Organisation Dataset not found (${DATASET_PATH}). Run: node backend/authority/build.js`);
    err.code = 'ORG_DATASET_NOT_FOUND';
    throw err;
  }

  const raw = fs.readFileSync(DATASET_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const verified = lines
    .map((l) => JSON.parse(l))
    .filter((o) => o.domainStatus === 'VERIFIED' && o.verifiedDomain)
    .map((o) => ({
      id: o.organisationId,            // immutable canonical Organisation ID
      firm_name: o.organisationName,
      domain: o.verifiedDomain,        // the authoritative verified domain
      last_scanned: null,
    }));

  // Optional commissioning sample: ORG_SAMPLE_N caps to a deterministic head
  // sample (ordering preserved) so the Observatory can be exercised end-to-end
  // without scanning the whole verified population. Default (unset/0) = full.
  const sampleN = Number.parseInt(process.env.ORG_SAMPLE_N ?? '', 10);
  const sampled = Number.isInteger(sampleN) && sampleN > 0 ? verified.slice(0, sampleN) : verified;
  const selectionId = sampled.length === verified.length
    ? selectionIdFor(raw)
    : `${selectionIdFor(raw)}-sample${sampled.length}`;

  return {
    cohort_id: COHORT_ID,
    cohort_name: COHORT_NAME,
    selection_id: selectionId,
    n: sampled.length,
    organisations: sampled,
  };
}

module.exports = { loadOrganisations, COHORT_ID, COHORT_NAME, DATASET_PATH };
