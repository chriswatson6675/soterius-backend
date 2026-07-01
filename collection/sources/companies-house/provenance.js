'use strict';

// provenance.js — observation identity, content hashing, and the provenance
// envelope (CCS-COMPHOUSE-001 §5.2–§5.3; EOI-COMPHOUSE-001 §3.1).
//
// Pure functions. The provenance envelope is what makes a preserved observation
// reproducible (CCS §8.2) and honest about where/when/what/how (CCS §6.1).
//
// Authority: CCS-COMPHOUSE-001 §5; EOI-COMPHOUSE-001 §3.1; ARCHITECTURE.md §4.

const crypto = require('node:crypto');

const SOURCE = 'companies-house';
const COLLECTOR_VERSION = '1.0.0';

// Required envelope elements (CCS §5.3). A missing element is a defect the
// validation suite rejects (CCS §8.3).
const REQUIRED_PROVENANCE_KEYS = Object.freeze([
  'observationTimestamp',
  'sourceSurface',
  'endpoint',
  'requestUris',
  'observedObjectId',
  'contentHash',
]);

/**
 * Deterministic content hash of the EXACT observed representation.
 * - JSON objects are canonicalised (recursive key sort) so that re-observation
 *   of an unchanged representation yields an identical hash regardless of key
 *   ordering or insignificant whitespace (CCS §7.3, §8.2).
 * - Buffers (EO-06 binary) are hashed byte-for-byte (CCS §5.1, R5).
 *
 * @param {Object|Buffer|string} representation
 * @returns {string} sha256 hex, prefixed 'sha256:'
 */
function contentHash(representation) {
  let input;
  if (Buffer.isBuffer(representation)) {
    input = representation;
  } else if (typeof representation === 'string') {
    input = Buffer.from(representation, 'utf8');
  } else {
    input = Buffer.from(_canonicalJson(representation), 'utf8');
  }
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Observation identity (CCS §5.2): object identity + observation moment +
 * content hash. Distinguishes one snapshot within the append-only sequence.
 *
 * @param {Object} objectIdentity - corpus-level identity (§5.2)
 * @param {string} timestamp - ISO observation moment
 * @param {string} hash - contentHash()
 * @returns {Object}
 */
function observationIdentity(objectIdentity, timestamp, hash) {
  return { objectIdentity, observationTimestamp: timestamp, contentHash: hash };
}

/**
 * Build the provenance envelope (CCS §5.3). Throws if a required element is
 * missing — provenance incompleteness is a collector defect, not a recordable
 * state.
 *
 * @param {Object} p
 * @returns {Object} frozen envelope
 */
function buildProvenance(p) {
  const env = {
    observationTimestamp: p.observationTimestamp,
    sourceSurface:        p.sourceSurface,        // 'PDA' | 'DOC' | 'STREAM' | 'BULK'
    endpoint:             p.endpoint,             // e.g. 'GET /company/{company_number}'
    requestUris:          p.requestUris,          // exact URIs (plural for multi-resource)
    observedObjectId:     p.observedObjectId,     // company_number + object id (§5.2)
    contentHash:          p.contentHash,
    etag:                 p.etag ?? null,         // REST change marker
    timepoint:            p.timepoint ?? null,    // Streaming order/resume (null for REST)
    sourceVersion:        p.sourceVersion ?? null,// bulk snapshot date / reference version
    representationObserved: p.representationObserved ?? null, // EO-06 content-type
    source:               SOURCE,
    collectorVersion:     COLLECTOR_VERSION,
  };
  const missing = REQUIRED_PROVENANCE_KEYS.filter((k) => env[k] == null ||
    (Array.isArray(env[k]) && env[k].length === 0));
  if (missing.length) {
    throw new Error(`provenance envelope missing required element(s): ${missing.join(', ')}`);
  }
  return Object.freeze(env);
}

/** Attempt provenance for a recorded NON-OBSERVATION (CCS §6 — failure table). */
function attemptProvenance(p) {
  return {
    observationTimestamp: p.observationTimestamp,
    sourceSurface:        p.sourceSurface,
    endpoint:             p.endpoint,
    requestUris:          p.requestUris ?? (p.requestUri ? [p.requestUri] : []),
    httpStatus:           p.httpStatus ?? null,
    source:               SOURCE,
    collectorVersion:     COLLECTOR_VERSION,
  };
}

function isCompleteProvenance(env) {
  if (!env || typeof env !== 'object') return false;
  return REQUIRED_PROVENANCE_KEYS.every((k) => env[k] != null &&
    !(Array.isArray(env[k]) && env[k].length === 0));
}

function _canonicalJson(value) {
  return JSON.stringify(_sortKeys(value));
}

function _sortKeys(v) {
  if (Array.isArray(v)) return v.map(_sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = _sortKeys(v[k]); return acc; }, {});
  }
  return v;
}

module.exports = {
  contentHash,
  observationIdentity,
  buildProvenance,
  attemptProvenance,
  isCompleteProvenance,
  REQUIRED_PROVENANCE_KEYS,
  SOURCE,
  COLLECTOR_VERSION,
  _canonicalJson,
};
