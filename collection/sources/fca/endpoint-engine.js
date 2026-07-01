'use strict';

// endpoint-engine.js — FCA endpoint execution engine (in-memory; no persistence).
//
// Reference Collector v0.1 — PHASE 3 (IMP-FCA-001 §3; CCS-FCA-001 §4, §5).
//
// Given an anchor (FRN/IRN/PRN) and a family, the engine consults the declarative
// catalogue (endpoint-map.js) and executes the endpoints in deterministic
// dependency order: parent first, then children, then within-entity grandchildren
// (one request per dependency id derived from the parent body). It follows
// pagination (`ResultInfo.Next`) to completion, and returns the RAW responses in
// memory, unchanged.
//
// It does NOT: preserve, extract structured evidence, classify outcomes, retry,
// resume, report, or write anything (later phases). It NEVER traverses
// cross-entity links — it only ever executes the catalogue endpoints for the one
// requested anchor [CR-FCA-13]. It NEVER assumes dynamic field names — dynamic
// structures (Permissions, CF) are returned exactly as received [CR-FCA-04/15];
// the only keys it reads are the documented envelope (`Data`/`ResultInfo`) and the
// catalogue's within-entity dependency selectors (CCS-FCA-001 §5.2).
//
// Authority: CCS-FCA-001 §4, §5; CCD-FCA-001 CR-FCA-02/04/12/13/15; ESD-FCA-001 §4.

const { getJson, buildUrl } = require('./fca-client');
const map = require('./endpoint-map');
const { withRetry } = require('./retry');

// Phase 7: a single attempt by default (Phase 3 semantics) unless a retry policy
// is supplied. `observeEndpoint` is exported so the resilience layer (resume.js)
// can reuse the exact same per-endpoint observation + pagination, including
// resuming a paginated endpoint from a saved `startUrl`.
const NO_RETRY = { maxAttempts: 1 };

/**
 * Execute the catalogue endpoints for one anchor. Returns raw responses in memory.
 *
 * @param {Object} opts
 * @param {string} [opts.family='firm']
 * @param {string} opts.anchor - FRN / IRN / PRN
 * @param {Object} opts.config - { baseUrl, email, apiKey }
 * @param {string[]} [opts.endpoints] - subset of endpoint ids (caller-declared scope); defaults to the full family
 * @param {function} [opts._fetch] - injectable transport (tests)
 * @param {number} [opts.maxPagesPerEndpoint=Infinity] - explicit page bound (honestly flagged if hit; never silent)
 * @returns {Promise<ExecutionResult>}
 */
async function executeAnchor(opts) {
  const { family = 'firm', anchor, config, endpoints, _fetch, maxPagesPerEndpoint = Infinity } = opts;
  if (!anchor) throw new Error('executeAnchor requires an anchor');
  if (!config || !config.baseUrl) throw new Error('executeAnchor requires config.baseUrl');

  const order = map.orderFor(family, endpoints);
  const parentBodies = {}; // endpointId -> first-page body, for within-entity dependency selectors
  const executions = [];

  for (const id of order) {
    const d = map.def(id);
    const dependsOn = map.dependencyParent(id);

    if (dependsOn) {
      // Within-entity grandchild: derive ids from the (already executed) parent body.
      const parentBody = parentBodies[dependsOn];
      if (parentBody === undefined) {
        // Parent not in scope/declined → cannot derive; record, do not guess.
        executions.push({ endpointId: id, dependsOn, status: 'dependency-unavailable', pages: [] });
        continue;
      }
      const ids = map.dependencyIds(id, parentBody);
      if (ids.length === 0) {
        executions.push({ endpointId: id, dependsOn, status: 'dependency-empty', pages: [] });
        continue;
      }
      for (const depId of ids) {
        const { pages, pageLimitReached } = await observeEndpoint(d, anchor, depId, config, { _fetch, maxPages: maxPagesPerEndpoint, retry: opts.retry });
        executions.push({ endpointId: id, dependsOn, dependencyId: depId, status: 'executed', pageLimitReached, pages });
      }
      continue;
    }

    // Parent or direct child: anchor is the only input.
    const { pages, pageLimitReached } = await observeEndpoint(d, anchor, null, config, { _fetch, maxPages: maxPagesPerEndpoint, retry: opts.retry });
    // Retain the first-page body ONLY so grandchildren can derive within-entity ids.
    parentBodies[id] = pages.length > 0 ? (pages[0].response.body ?? null) : null;
    executions.push({ endpointId: id, status: 'executed', pageLimitReached, pages });
  }

  return { family, anchor, order, executions };
}

/**
 * Observe one endpoint, following `ResultInfo.Next` pagination to completion.
 * Returns the raw responses (one per page), unchanged. Each page carries its
 * per-attempt retry log (Phase 7). Shared by executeAnchor and resume.js.
 *
 * @param {Object} opts
 * @param {function} [opts._fetch]
 * @param {Object}   [opts.retry]      - retry policy (default: single attempt)
 * @param {number}   [opts.maxPages=Infinity]
 * @param {string}   [opts.startUrl]   - resume pagination from this URL (resume.js)
 * @param {Object}   [opts._retryHelpers] - injectable {_sleep,_now} for tests
 */
async function observeEndpoint(d, anchor, dependencyId, config, opts = {}) {
  const { _fetch, retry, maxPages = Infinity, startUrl, _retryHelpers } = opts;
  const pages = [];
  let url = startUrl ?? buildUrl(config.baseUrl, d.path(anchor, dependencyId));
  let pageLimitReached = false;

  for (let p = 0; ; p++) {
    if (p >= maxPages) { pageLimitReached = true; break; }

    const { attempts, final } = await withRetry(
      () => getJson(url, { email: config.email, apiKey: config.apiKey, _fetch }),
      retry || NO_RETRY,
      _retryHelpers || {},
    );
    pages.push({ requestUri: final.requestUri, response: final, attempts });

    // Follow pagination only on a clean transport outcome with a Next link.
    const next = final.errorType === 'NONE' && final.body && final.body.ResultInfo
      ? final.body.ResultInfo.Next : null;
    if (!next) break;
    url = next; // Next is a fully-formed within-entity URL on the FS Register
  }

  return { pages, pageLimitReached };
}

module.exports = { executeAnchor, observeEndpoint };

/**
 * @typedef {Object} ExecutionResult
 * @property {string} family
 * @property {string} anchor
 * @property {string[]} order
 * @property {Array<{endpointId:string, status:string, dependsOn?:string, dependencyId?:string, pageLimitReached?:boolean, pages:Array<{requestUri:string, response:Object}>}>} executions
 */
