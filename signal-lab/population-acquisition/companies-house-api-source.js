'use strict';

// companies-house-api-source.js — stream CH candidates by querying advanced-search
// per approved SIC code (no whole-register download).
//
// Population Acquisition Layer. Fetches ONLY SIC-matched companies directly from the
// Companies House advanced-search API, one approved SIC code at a time. Infrastructure
// only — reuses:
//   ch-client            — transport (getJson, HTTP Basic auth)
//   candidate-sic        — the frozen approved SIC code set (the codes to query)
//   companies-house-source — the candidate filter/projection (re-applied for consistency)
//
// Honest limit: advanced-search returns at most ~10,000 results per query, so a SIC
// code with more than that many active companies has its tail dropped — this is
// LOGGED (no silent cap), and is the only case where the bulk product would be needed.

const chClient = require('../sources/companies-house/ch-client');
const { APPROVED } = require('../sources/companies-house/candidate-sic');
const { companiesHouseCandidateSource } = require('./companies-house-source');

const ADVANCED_SEARCH = 'https://api.company-information.service.gov.uk/advanced-search/companies';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream raw CH company records by paging advanced-search for each SIC code.
 * Yields { companyNumber, companyName, status, sicCodes }. Throws on transport error.
 * @param {Object} opts - { apiKey, sicCodes?, pageSize?, maxPerSic?, pace?, log?, _getJson? }
 */
async function* streamAdvancedSearchBySic(opts = {}) {
  const apiKey = opts.apiKey;
  const sicCodes = opts.sicCodes || [...APPROVED];
  const size = opts.pageSize || 100;
  const cap = opts.maxPerSic || 10000;                       // CH advanced-search result cap per query
  const getJson = opts._getJson || chClient.getJson;
  const pace = opts.pace ?? 120;                             // politeness delay between pages (ms)
  const retryAttempts = opts.retryAttempts ?? 5;            // resilience for an unattended multi-hour run
  const retryDelay = opts.retryDelay ?? 2000;
  const log = opts.log || (() => {});

  // Retry TRANSIENT failures (connection blips, rate limits, 5xx) before giving up, so a
  // single network hiccup does not kill a multi-hour run. Non-transient errors throw at
  // once; a persistent failure still throws (the run is resumable via the ledger).
  async function fetchPage(url, code) {
    let last = null;
    for (let a = 0; a < retryAttempts; a++) {
      const r = await getJson(url, { apiKey });
      if (r.errorType === 'NONE' && r.body) return r;
      last = r;
      const transient = r.errorType === 'CONNECTION_ERROR' || r.errorType === 'RATE_LIMITED' || (r.httpStatus && r.httpStatus >= 500);
      if (!transient) break;
      if (a < retryAttempts - 1) { log(`CH ${code} ${r.errorType} — retry ${a + 1}/${retryAttempts - 1}`); await sleep(retryDelay * (a + 1)); }
    }
    throw new Error(`CH advanced-search ${code} failed: ${last.errorType} ${last.httpStatus ?? ''}`.trim());
  }

  for (const code of sicCodes) {
    let start = 0;
    let total = null;
    for (;;) {
      const url = `${ADVANCED_SEARCH}?sic_codes=${encodeURIComponent(code)}&company_status=active&size=${size}&start_index=${start}`;
      const r = await fetchPage(url, code);
      if (total == null) total = r.body.hits ?? r.body.total_results ?? null;
      const items = Array.isArray(r.body.items) ? r.body.items : [];
      for (const it of items) yield { companyNumber: it.company_number, companyName: it.company_name, status: it.company_status, sicCodes: it.sic_codes || [] };

      start += size;
      if (items.length < size) break;                        // last page for this code
      if (start >= cap) {                                     // hit the advanced-search cap — surface the dropped tail
        if (total != null && total > cap) log(`SIC ${code}: ${total} active companies exceed the ~${cap} advanced-search cap — ${total - cap} not retrieved`);
        break;
      }
      if (pace) await sleep(pace);
    }
  }
}

/** A CH candidate source backed by advanced-search-by-SIC (re-filtered by candidate-sic). */
function companiesHouseApiCandidateSource(opts = {}) {
  return companiesHouseCandidateSource({ records: streamAdvancedSearchBySic(opts), activeOnly: opts.activeOnly });
}

module.exports = { streamAdvancedSearchBySic, companiesHouseApiCandidateSource };
