'use strict';

// ch-address-lookup.js — fetch a Companies House company's name and registered-office
// postcode by company number. Used by Phase 2 (ambiguous resolution) to get the
// postcode tie-breaker without re-streaming the bulk CSV.
//
// One CH API call per company: GET /company/{number} returns both company_name and
// registered_office_address.postal_code. Propagates errors (callers decide policy).

const chClient = require('../../collection/sources/companies-house/ch-client');

const CH_PDA = 'https://api.company-information.service.gov.uk';

/**
 * Fetch the Companies House company profile: name + registered-office postcode.
 * @param {string} companyNumber
 * @param {{ apiKey: string }} opts
 * @returns {Promise<{ companyName: string|null, postcode: string|null }>}
 */
async function getChProfile(companyNumber, opts = {}) {
  const url = `${CH_PDA}/company/${encodeURIComponent(String(companyNumber))}`;
  const r = await chClient.getJson(url, { apiKey: opts.apiKey });
  if (r.errorType !== 'NONE') {
    throw new Error(`CH profile ${companyNumber}: ${r.errorType} ${r.httpStatus ?? ''}`.trim());
  }
  const body = r.body || {};
  const addr = body.registered_office_address || {};
  return {
    companyName: body.company_name || null,
    postcode: addr.postal_code || null,
  };
}

module.exports = { getChProfile };
