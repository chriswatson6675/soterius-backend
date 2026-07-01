'use strict';

// acquire-snapshot.js — acquire the complete SRA dataset (Observe; in-memory only).
//
// SRA Snapshot Collector v0.1 — Observe layer.
//
// Given a validated config and a snapshot-source definition, this module acquires
// the WHOLE dataset and returns the RAW snapshot EXACTLY as received, in memory. It
// supports segmented acquisition (cursor mode) and reuses the shared retry policy
// for transient transport failures. It does NOT preserve, parse into structured
// evidence, write anything, or know about Collection Packages or Railway.
//
// The ONLY interpretation it performs is operational: a guarded, read-only peek at
// the dataset production timestamp (via the source's declared locator). The raw
// bodies are returned untouched.
//
// Result shape (ready to hand to preserve-snapshot.preserveSegment, segment by
// segment — but acquire itself preserves nothing):
//   { ok, segments: [{ name, body, requestUri, httpStatus, attempts }],
//     productionTimestamp, segmentCount, pageLimitReached, error }
//
// Authority: SRA Snapshot Collector design §"New SRA-specific modules: acquire-snapshot".

const sraClient = require('./sra-client');
const { SRA_SNAPSHOT_SOURCE, locate } = require('./snapshot-source');
const { withRetry } = require('./retry');

/** Read the production timestamp from a raw body, guarded. Operational metadata only. */
function readProductionTimestamp(rawBody, source) {
  if (rawBody == null) return null;
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return null; } // raw body is returned untouched regardless
  const v = locate(parsed, source.productionTimestampPath);
  return (typeof v === 'string' || typeof v === 'number') ? v : null;
}

/** Resolve the next-page URL for cursor mode from a raw body, guarded. */
function readNextUrl(rawBody, source) {
  if (rawBody == null) return null;
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return null; }
  const v = locate(parsed, source.segmentation.nextPath);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function segmentName(source, index) {
  const seg = source.segmentation;
  if (seg.mode === 'single') return seg.singleSegmentName || 'snapshot.json';
  return `${seg.segmentPrefix || 'segment-'}${String(index + 1).padStart(4, '0')}.json`;
}

/**
 * Acquire the complete snapshot. Never rejects on transport failure (returns a
 * structured result with ok=false); throws only on programmer error (missing
 * config.baseUrl / source).
 *
 * @param {Object} opts
 * @param {Object}   opts.config      - { baseUrl, subscriptionKey }
 * @param {Object}   [opts.source]    - snapshot-source definition (defaults to SRA_SNAPSHOT_SOURCE)
 * @param {Object}   [opts.retry]     - retry policy (passed to withRetry)
 * @param {function} [opts._fetch]    - injectable transport (tests)
 * @param {Object}   [opts._retryHelpers] - injectable { _sleep, _now } (tests)
 * @param {Object}   [opts.client]    - injectable client (tests; defaults to sra-client)
 * @returns {Promise<Object>}
 */
async function acquireSnapshot(opts = {}) {
  const { config, source = SRA_SNAPSHOT_SOURCE, retry, _fetch, _retryHelpers, client = sraClient } = opts;
  if (!config || !config.baseUrl) throw new Error('acquireSnapshot requires config.baseUrl');
  if (!source || !source.segmentation) throw new Error('acquireSnapshot requires a snapshot source definition');

  const mode = source.segmentation.mode;
  const maxSegments = source.segmentation.maxSegments ?? 10000;

  const segments = [];
  let productionTimestamp = null;
  let pageLimitReached = false;

  let url = client.buildUrl(config.baseUrl, source.datasetPath);

  for (let i = 0; ; i++) {
    if (i >= maxSegments) { pageLimitReached = true; break; }

    const { attempts, final } = await withRetry(
      () => client.get(url, { subscriptionKey: config.subscriptionKey, _fetch }),
      retry || {},
      _retryHelpers || {},
    );

    if (!final || final.errorType !== 'NONE') {
      // Transport failure: surface it with whatever was already acquired; never throw.
      return {
        ok: false,
        segments,
        productionTimestamp,
        segmentCount: segments.length,
        pageLimitReached,
        error: final
          ? { errorType: final.errorType, httpStatus: final.httpStatus, errorMessage: final.errorMessage, requestUri: final.requestUri }
          : { errorType: 'CONNECTION_ERROR', httpStatus: null, errorMessage: 'no response', requestUri: url },
      };
    }

    segments.push({
      name: segmentName(source, i),
      body: final.rawBody,            // RAW, exactly as received — untouched
      requestUri: final.requestUri,
      httpStatus: final.httpStatus,
      attempts,
    });

    // Operational metadata, read from the FIRST successful segment (guarded).
    if (productionTimestamp == null) productionTimestamp = readProductionTimestamp(final.rawBody, source);

    if (mode !== 'cursor') break;     // 'single' (or any non-cursor) → one segment
    const next = readNextUrl(final.rawBody, source);
    if (!next) break;                 // no further pages
    url = next;
  }

  return {
    ok: true,
    segments,
    productionTimestamp,
    segmentCount: segments.length,
    pageLimitReached,
    error: null,
  };
}

module.exports = { acquireSnapshot, readProductionTimestamp, readNextUrl, segmentName };
