'use strict';

// preserve.js — the Preserve sink for FCA observed evidence (raw, immutable).
//
// Reference Collector v0.1 — PHASE 4 (IMP-FCA-001 §4; CCS-FCA-001 §6; CCD-FCA-001 §4).
//
// The engine (Phase 3) returns raw endpoint responses IN MEMORY; this module
// performs Preserve: it writes each observed page to a permanent, append-only,
// run-stamped store EXACTLY as observed. It does NOT extract, transform,
// normalise, interpret, classify, derive, or use a database (later phases / never).
//
// Storage choice. The constitution mandates the PROPERTIES of preservation
// (immutable / byte-faithful / provenanced) not a technology (CCS-FCA-001 §0.2).
// The FCA corpus is heterogeneous multi-endpoint JSON; the minimal honest sink is
// an append-only directory of NDJSON, one file per logical endpoint, one line per
// observed page. Append-only is enforced by append writes; a line is never
// rewritten [CR-FCA-03/09].
//
// What each preserved line carries (CCS-FCA-001 §6; the Phase 4 field set):
//   runId, family, anchor (parent entity id), endpointId, dependencyId,
//   pageSequence, fcaPage, requestUri, collectionTimestamp, transport (errorType),
//   httpStatus, responseHeaders, fcaEnvelope (Status/Message/ResultInfo), rawBody.
// `rawBody` is the response body string EXACTLY as received — the byte-faithful
// artefact. No field is altered, no key normalised, no value reformatted, no date
// converted; unknown fields and dynamic structures survive intact because the raw
// body is stored verbatim [CR-FCA-04/06/15].
//
// NOTE (deferred, documented): a Waiver's *binary document* (EO-FCA-0151, behind
// `Waivers_Discretions_URL`) is NOT fetched/preserved here — that needs a binary
// GET (not built) and engine support; the `firm.waivers` JSON listing IS preserved.
// See the Phase 4 report's New Observations / Founder questions.
//
// Authority: CCS-FCA-001 §6; CCD-FCA-001 CR-FCA-03/04/05/06/09; IMP-FCA-001 §4.

const fs = require('node:fs');
const path = require('node:path');
const { rawDir, rawFileFor } = require('./evidence-path');

/**
 * Open an append-only Preserve sink rooted at `dir`. Creates the tree if absent;
 * re-opening an existing dir appends (resume-safe storage; resume LOGIC is Phase 7).
 *
 * @param {string} dir - the run directory
 * @param {Object} [opts]
 * @param {string} [opts.runId]
 * @param {function} [opts.now] - injectable clock returning an ISO string (tests)
 * @returns {Preserver}
 */
function createPreserver(dir, opts = {}) {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = opts.runId ?? null;

  fs.mkdirSync(rawDir(dir), { recursive: true });

  const tally = {
    endpointsAttempted: 0,
    endpointsPreserved: 0,
    pagesPreserved: 0,
    transportErrors: 0,
    attemptsRecorded: 0, // Phase 7: total retry attempts logged across pages
    artefacts: new Set(),
  };

  function appendLine(file, obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n'); // append-only; never rewrite [CR-FCA-03]
  }

  return {
    dir,

    /**
     * Preserve every page of every execution from one engine result.
     * @param {Object} executionResult - the in-memory output of endpoint-engine.executeAnchor
     * @returns {Object} tally
     */
    preserveExecution(executionResult) {
      const { anchor, family } = executionResult;
      for (const ex of executionResult.executions) {
        tally.endpointsAttempted++;

        // No pages = a dependency-empty / dependency-unavailable execution: there
        // is nothing OBSERVED to preserve. We record neither evidence nor a guess
        // (observed-absence vs non-observation classification is Phase 7).
        if (!ex.pages || ex.pages.length === 0) continue;

        const file = rawFileFor(dir, ex.endpointId);
        let seq = 0;
        for (const page of ex.pages) {
          seq++;
          const r = page.response;
          if (r.errorType !== 'NONE') tally.transportErrors++;
          appendLine(file, {
            runId,
            family,
            anchor,
            endpointId: ex.endpointId,
            dependencyId: ex.dependencyId ?? null,
            pageSequence: seq,
            fcaPage: r.body && r.body.ResultInfo ? (r.body.ResultInfo.page ?? null) : null,
            requestUri: r.requestUri,
            collectionTimestamp: now(),
            transport: r.errorType,
            httpStatus: r.httpStatus,
            responseHeaders: r.headers ?? null,   // RESPONSE headers only (no request → no credential)
            fcaEnvelope: r.envelope ?? null,
            rawBody: r.rawBody ?? null,            // byte-faithful artefact [CR-FCA-03]
            attempts: page.attempts ?? null,       // Phase 7: per-page retry attempt log (additive)
          });
          if (Array.isArray(page.attempts)) tally.attemptsRecorded += page.attempts.length;
          tally.pagesPreserved++;
          tally.artefacts.add(path.basename(file));
        }
        tally.endpointsPreserved++;
      }
      return this.tally();
    },

    tally() { return { ...tally, artefacts: [...tally.artefacts] }; },
  };
}

module.exports = { createPreserver };

/**
 * @typedef {Object} Preserver
 * @property {string} dir
 * @property {function(Object): Object} preserveExecution
 * @property {function(): Object} tally
 */
