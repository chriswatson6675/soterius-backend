'use strict';

// fixture-batch-adapter.js — a minimal, in-memory reference implementation of
// the Batch Adapter Contract, used ONLY by batch-adapter-contract.test.js to
// prove the contract's orchestration (stage order, error propagation) without
// depending on any real source. NOT a real adapter — do not reuse for HMRC
// AML or any other concrete source (that is WP-2+, a separate package).
//
// Source rows: [{ id, orgName, website }]. A row missing `id` or `orgName`
// is a structural failure. `website` may be absent (no domain asserted).

function createFixtureBatchAdapter(overrides = {}) {
  return {
    sourceId: 'fixture-source',

    parse(rawInput) {
      if (!Array.isArray(rawInput)) throw new Error('fixture source expects an array of rows');
      return rawInput;
    },

    validateStructure(rows) {
      const valid = [];
      const rejected = [];
      rows.forEach((row, index) => {
        if (!row || !row.id) {
          rejected.push({ index, row, reason: 'missing required field "id"' });
        } else if (!row.orgName) {
          rejected.push({ index, row, reason: 'missing required field "orgName"' });
        } else {
          valid.push(row);
        }
      });
      return { valid, rejected };
    },

    normalise(validRows) {
      return validRows.map((row) => ({
        source: 'fixture-source',
        regulator: null,
        name: row.orgName,
        namePriority: 9,
        frn: null,
        sraNumber: null,
        ukprn: null,
        companyNumber: null,
        lei: null,
        ifUuid: null,
        frcAudit: null,
        hmrcAml: null,
        pbsFirm: null,
        domainRaw: row.website || null,
        domainSource: row.website ? 'fixture-website' : null,
        domainPriority: null,
        noDomainAsserted: !row.website,
        sourceDate: '2026-07-13',
        provenance: { file: 'fixture', key: `ID:${row.id}` },
      }));
    },

    ...overrides,
  };
}

module.exports = { createFixtureBatchAdapter };
