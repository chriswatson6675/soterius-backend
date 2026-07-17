'use strict';

// Evidence — the provenance ledger entry every Claim / Relationship
// Observation cites by reference (execution architecture design, §D
// "evidence references"). Append-only once persisted; a claim or
// relationship observation never duplicates the source content, only
// points at an evidence id here.

const crypto = require('node:crypto');
const { EVIDENCE_CLASSES } = require('./constants');
const { normaliseDomain } = require('../../authority/lib/normalise');

/**
 * Deterministic content hash of retrieved source material — a small,
 * standalone re-implementation of the same canonicalised-JSON / raw-bytes
 * sha256 pattern used by collection/sources/companies-house/provenance.js.
 * Duplicated deliberately rather than imported: the prior architecture
 * review (Reusable Foundations §C) recommended pattern-reuse, not a live
 * import, so the Commercial Observatory's evidence ledger is not coupled to
 * a Signal-Lab-scoped collector module.
 */
function contentHash(representation) {
  let input;
  if (Buffer.isBuffer(representation)) {
    input = representation;
  } else if (typeof representation === 'string') {
    input = Buffer.from(representation, 'utf8');
  } else {
    input = Buffer.from(JSON.stringify(_sortKeys(representation)), 'utf8');
  }
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

function _sortKeys(v) {
  if (Array.isArray(v)) return v.map(_sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = _sortKeys(v[k]); return acc; }, {});
  }
  return v;
}

/**
 * Normalises a source URL for de-duplication: lowercases and normalises the
 * host via the existing canonical Organisation-Dataset domain normaliser
 * (authority/lib/normalise.js), strips a trailing slash and any fragment,
 * leaves the path/query case as-is (paths can be case-sensitive).
 */
function normaliseSourceUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = normaliseDomain(url.host);
  if (!host) return null;
  let path = url.pathname.replace(/\/$/, '');
  return `${host}${path}${url.search || ''}`;
}

function validateEvidenceInput({ investigationId, sourceUrl, retrievedAt, evidenceClass, contextExcerpt } = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!sourceUrl || typeof sourceUrl !== 'string') errors.push('sourceUrl must be a non-empty string.');
  if (!retrievedAt) errors.push('retrievedAt is required.');
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) {
    errors.push(`evidenceClass must be one of ${EVIDENCE_CLASSES.join(', ')}.`);
  }
  if (contextExcerpt !== undefined && contextExcerpt !== null && typeof contextExcerpt !== 'string') {
    errors.push('contextExcerpt must be a string when supplied.');
  }
  return { valid: errors.length === 0, errors };
}

function buildEvidenceRecord({ investigationId, sourceUrl, retrievedAt, evidenceClass, contextExcerpt = null, sourceTitle = null, rawContent = null }) {
  const { valid, errors } = validateEvidenceInput({ investigationId, sourceUrl, retrievedAt, evidenceClass, contextExcerpt });
  if (!valid) throw new Error(`Invalid evidence: ${errors.join('; ')}`);
  return {
    investigationId,
    sourceUrl,
    sourceUrlNormalised: normaliseSourceUrl(sourceUrl),
    retrievedAt,
    contentHash: rawContent !== null ? contentHash(rawContent) : null,
    evidenceClass,
    contextExcerpt,
    sourceTitle,
  };
}

module.exports = { contentHash, normaliseSourceUrl, validateEvidenceInput, buildEvidenceRecord };
