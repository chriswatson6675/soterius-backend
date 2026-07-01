'use strict';

// fca-adapters.js — concrete implementations of the Candidate Processor's injected
// FCA dependencies. INFRASTRUCTURE ONLY: no matching, no filtering, no eligibility,
// no lifecycle, no category derivation. Each adapter reuses existing FCA Observatory
// components rather than duplicating them, and PROPAGATES errors (throws) so the
// processor's failure handling — not the adapter — decides what to do.
//
// Reused, unchanged:
//   fca-client       — transport (getJson), config, url building
//   endpoint-map     — the FCA endpoint path builders (pathFor)
//   collection-profiles — the 'registry' profile (firm + firm.address + firm.permissions)

const fs = require('node:fs');
const path = require('node:path');

const fcaClient = require('../../collection/sources/fca/fca-client');
const { pathFor } = require('../../collection/sources/fca/endpoint-map');
const { endpointsFor } = require('../../collection/sources/fca/collection-profiles');

function _cfg(config) { return config || fcaClient.loadConfig(); }

// ── FCA Search Adapter ───────────────────────────────────────────────────────────
/**
 * Build the `fcaSearch` dependency: GET the FCA Register firm search and return the
 * raw hits in the processor's interface shape `[{ frn, name, status }]`. No matching,
 * no filtering. Throws on any transport/HTTP error (propagation).
 * @param {{ config?:Object, _fetch?:Function }} [opts]
 */
function createFcaSearch(opts = {}) {
  const config = _cfg(opts.config);
  return async function fcaSearch(name) {
    const url = fcaClient.buildUrl(config.baseUrl, '/Search?q=' + encodeURIComponent(String(name ?? '')) + '&type=firm');
    const r = await fcaClient.getJson(url, { email: config.email, apiKey: config.apiKey, _fetch: opts._fetch });
    if (r.errorType !== 'NONE') throw new Error(`FCA search failed: ${r.errorType} ${r.httpStatus ?? ''}`.trim());
    const data = r.body && Array.isArray(r.body.Data) ? r.body.Data : []; // null Data = "no results" (a success)
    return data.map((h) => ({ frn: h['Reference Number'], name: h.Name, status: h.Status }));
  };
}

// ── FCA Enrichment Adapter ───────────────────────────────────────────────────────
/**
 * Build the `fcaEnrich` dependency: GET the 'registry' profile endpoints (firm +
 * firm.address + firm.permissions) for an FRN and return the raw FCA `Data` for each,
 * UNCHANGED and uninterpreted. Throws on any endpoint transport/HTTP error.
 * @param {{ config?:Object, _fetch?:Function }} [opts]
 */
function createFcaEnrich(opts = {}) {
  const config = _cfg(opts.config);
  const scope = endpointsFor('registry'); // ['firm', 'firm.address', 'firm.permissions']
  return async function fcaEnrich(frn) {
    const out = { frn: String(frn) };
    for (const id of scope) {
      const url = fcaClient.buildUrl(config.baseUrl, pathFor(id, frn));
      const r = await fcaClient.getJson(url, { email: config.email, apiKey: config.apiKey, _fetch: opts._fetch });
      if (r.errorType !== 'NONE') throw new Error(`FCA enrich ${id} failed: ${r.errorType} ${r.httpStatus ?? ''}`.trim());
      out[id] = r.body ? (r.body.Data ?? null) : null; // raw Data, unwrapped from the envelope; not interpreted
    }
    return out;
  };
}

// ── Organisation Registry Adapter ────────────────────────────────────────────────
/**
 * Build the `persist` dependency: append an acquired organisation to the registry
 * store (append-only NDJSON). No lifecycle logic. Returns the persistence result.
 * Write failures propagate (no try/catch).
 * @param {{ path:string, now?:()=>Date }} opts
 */
function createRegistryPersist(opts = {}) {
  const file = opts.path;
  if (!file) throw new Error('createRegistryPersist requires a path');
  const now = opts.now;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return async function persist(record) {
    const entry = { ...record, persistedAt: (now ? now() : new Date()).toISOString() };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n'); // throws on failure → propagated to the processor
    return { persisted: true, companyNumber: record && record.companyNumber, frn: record && record.frn };
  };
}

module.exports = { createFcaSearch, createFcaEnrich, createRegistryPersist };
