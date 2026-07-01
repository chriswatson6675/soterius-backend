'use strict';

// preserve-snapshot.js — the Preserve sink for an SRA raw snapshot (byte-faithful, immutable).
//
// SRA Snapshot Collector v0.1 — Collection Package foundation.
//
// Acquisition (a later stage) returns the raw snapshot payload(s) IN MEMORY; this
// module performs Preserve: it writes each raw segment to a permanent, run-stamped
// store EXACTLY as received, and records an append-only index line per segment to
// SUPPORT FUTURE INTEGRITY VERIFICATION (content hash + byte count + provenance
// pointers). It does NOT parse, transform, normalise, extract, interpret, or use a
// database. (Mirrors the FCA/Companies House Preserve sinks; storage is a property,
// not a technology.)
//
// Immutability rules:
//   - byte-for-byte : the payload is written verbatim (Buffer/string unchanged).
//   - capture-once  : a raw segment file is NEVER overwritten; re-preserving the
//                     same name throws — an immutability violation is a bug and is
//                     surfaced, not swallowed.
//   - append-only   : the raw index gains one line per preserved segment; a line is
//                     never rewritten.
//
// Per-segment index record (the basis for later integrity verification):
//   { runId, segment, file, byteLength, sha256, requestUri, productionTimestamp, preservedAt }
//
// Authority: SRA Snapshot Collector design §"Preserve immutable raw snapshot".

const fs = require('node:fs');
const crypto = require('node:crypto');
const { rawDir, rawSegmentPath, rawIndexPath, safeName, DEFAULT_SNAPSHOT_FILE } = require('./evidence-path');

/** SHA-256 hex digest of a Buffer (the integrity anchor for a preserved segment). */
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * Open an immutable Preserve sink rooted at a package `dir`. Creates raw/ if absent;
 * re-opening an existing package appends (resume-safe storage).
 *
 * @param {string} dir - the collection package directory
 * @param {Object} [opts]
 * @param {string}   [opts.runId]
 * @param {function} [opts.now] - injectable clock returning an ISO string (tests)
 * @returns {Preserver}
 */
function createPreserver(dir, opts = {}) {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = opts.runId ?? null;

  fs.mkdirSync(rawDir(dir), { recursive: true });

  const segments = [];
  const tally = { segmentCount: 0, totalBytes: 0, segments };

  return {
    dir,

    /**
     * Preserve one raw snapshot segment byte-for-byte. Capture-once: throws if the
     * segment file already exists. Appends one line to the raw index.
     *
     * @param {Buffer|string} payload - raw bytes EXACTLY as received
     * @param {Object} [meta] - { name, segment, requestUri, productionTimestamp }
     * @returns {Object} the index record written
     */
    preserveSegment(payload, meta = {}) {
      if (payload == null) throw new Error('preserveSegment: payload is required');
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      const name = safeName(meta.name ?? DEFAULT_SNAPSHOT_FILE);
      const file = rawSegmentPath(dir, name);
      if (fs.existsSync(file)) throw new Error(`raw segment already preserved (immutable): ${name}`);

      fs.writeFileSync(file, buf); // byte-for-byte; capture-once [immutable]

      const record = {
        runId,
        segment: meta.segment ?? tally.segmentCount,
        file: name,
        byteLength: buf.length,
        sha256: sha256(buf),
        requestUri: meta.requestUri ?? null,
        productionTimestamp: meta.productionTimestamp ?? null,
        preservedAt: now(),
      };
      fs.appendFileSync(rawIndexPath(dir), JSON.stringify(record) + '\n'); // append-only; never rewrite

      segments.push({ file: name, byteLength: buf.length, sha256: record.sha256 });
      tally.segmentCount++;
      tally.totalBytes += buf.length;
      return record;
    },

    /** A copy of the running preservation tally (for the manifest). */
    tally() {
      return { segmentCount: tally.segmentCount, totalBytes: tally.totalBytes, segments: segments.map((s) => ({ ...s })) };
    },
  };
}

module.exports = { createPreserver, sha256 };

/**
 * @typedef {Object} Preserver
 * @property {string} dir
 * @property {function(Buffer|string, Object=): Object} preserveSegment
 * @property {function(): {segmentCount:number, totalBytes:number, segments:Object[]}} tally
 */
