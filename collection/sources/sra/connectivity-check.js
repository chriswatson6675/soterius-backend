'use strict';

// connectivity-check.js — lightweight SRA Observe-layer connectivity probe.
//
// SRA Snapshot Collector v0.1 — Observe layer.
//
// Validates, with a SINGLE request, that the Observe layer can reach and read the
// SRA dataset BEFORE committing to a full collection:
//   - authentication   : the subscription key is accepted (not 401/403)
//   - endpointAccessible: the dataset endpoint is reachable (not a connection error / 404)
//   - shapeValid       : the response body parses and the declared records locator resolves
//
// Usable independently of a full collection. Never throws; preserves nothing;
// writes nothing; knows nothing about Collection Packages or Railway.
//
// Authority: SRA Snapshot Collector design §"connectivity-check (optional)".

const sraClient = require('./sra-client');
const { SRA_SNAPSHOT_SOURCE, locate } = require('./snapshot-source');

const AUTH_REJECT_STATUSES = new Set([401, 403]);

/**
 * Probe connectivity to the SRA dataset endpoint.
 *
 * @param {Object} opts
 * @param {Object}   opts.config   - { baseUrl, subscriptionKey }
 * @param {Object}   [opts.source] - snapshot-source definition
 * @param {function} [opts._fetch] - injectable transport (tests)
 * @param {Object}   [opts.client] - injectable client (tests)
 * @returns {Promise<Object>} { ok, checks, httpStatus, errorType, productionTimestamp, recordCountSeen, detail }
 */
async function checkConnectivity(opts = {}) {
  const { config, source = SRA_SNAPSHOT_SOURCE, _fetch, client = sraClient } = opts;

  // Config precondition — surface, do not throw.
  const v = client.validateConfig(config);
  if (!v.ok) {
    return {
      ok: false,
      checks: { configValid: false, authentication: false, endpointAccessible: false, shapeValid: false },
      httpStatus: null,
      errorType: null,
      productionTimestamp: null,
      recordCountSeen: null,
      detail: `configuration invalid: ${v.errors.join('; ')}`,
    };
  }

  const url = client.buildUrl(config.baseUrl, source.datasetPath);
  const res = await client.get(url, { subscriptionKey: config.subscriptionKey, _fetch });

  const reachable = res.errorType !== 'CONNECTION_ERROR';
  const authentication = reachable && !AUTH_REJECT_STATUSES.has(res.httpStatus);
  const endpointAccessible = reachable && res.httpStatus !== 404;

  // Shape check (minimal, read-only — a connectivity probe, not evidence extraction).
  let shapeValid = false;
  let productionTimestamp = null;
  let recordCountSeen = null;
  let shapeDetail = null;
  if (res.errorType === 'NONE' && res.rawBody != null) {
    let parsed;
    try { parsed = JSON.parse(res.rawBody); }
    catch { parsed = undefined; shapeDetail = 'response body is not valid JSON'; }
    if (parsed !== undefined) {
      const records = locate(parsed, source.recordsPath);
      const tsv = locate(parsed, source.productionTimestampPath);
      productionTimestamp = (typeof tsv === 'string' || typeof tsv === 'number') ? tsv : null;
      if (Array.isArray(records)) { shapeValid = true; recordCountSeen = records.length; }
      else { shapeDetail = `records not found at path [${(source.recordsPath || []).join('.')}]`; }
    }
  } else if (res.errorType !== 'NONE') {
    shapeDetail = `transport ${res.errorType}${res.httpStatus ? ` (HTTP ${res.httpStatus})` : ''}`;
  }

  const ok = authentication && endpointAccessible && shapeValid;
  return {
    ok,
    checks: { configValid: true, authentication, endpointAccessible, shapeValid },
    httpStatus: res.httpStatus,
    errorType: res.errorType,
    productionTimestamp,
    recordCountSeen,
    detail: ok ? 'ok' : (shapeDetail || res.errorMessage || 'connectivity check failed'),
  };
}

module.exports = { checkConnectivity };
