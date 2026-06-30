'use strict';

// candidate-source-runner.js — sequentially process candidates from an injected source.
//
// Population Acquisition Layer. ORCHESTRATION ONLY: it pulls candidates from a source
// it knows nothing about, delegates EACH to the existing Candidate Processor, collects
// the structured outcomes, and returns a run summary. It contains no matching,
// eligibility, lifecycle, or persistence logic. Strictly SEQUENTIAL — exactly one
// candidate at a time. No acquisition, cursors, workers, scheduling, continuous
// execution, batching, concurrency, retry, or rate limiting.
//
// Source contract: any iterable or async-iterable that yields candidate objects
//   { companyNumber, companyName }. The runner is agnostic to the source's origin
//   (Companies House acquisition, replay of historical candidates, manual imports,
//   research datasets, …). `for await … of` consumes both sync and async sources.
//
// Continue vs stop:
//   - processCandidate RETURNS a structured outcome (acquired / no_match / ambiguous /
//     discarded / research / already_claimed / failed) → recorded; the run CONTINUES.
//     ('failed' is the ledger's recoverable failure state — retried by a later layer.)
//   - processCandidate THROWS (an unrecoverable / lifecycle error) → the run STOPS,
//     recording the error and the offending candidate (never swallowed into a count).

const { processCandidate } = require('./candidate-processor');

/**
 * Run a candidate source sequentially through the Candidate Processor.
 * @param {Iterable|AsyncIterable} source - yields { companyNumber, companyName }
 * @param {Object} deps - the Candidate Processor dependencies (ledger, fcaSearch, fcaEnrich, persist, config)
 * @param {{ process?: Function }} [opts] - inject the processor (defaults to the real one) for testing
 * @returns {Promise<{ processed:number, counts:Object, results:Array, stopped:boolean, error:(string|null), stoppedCandidate:(Object|null) }>}
 */
async function runCandidateSource(source, deps, opts = {}) {
  if (!source || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
    throw new Error('runCandidateSource requires an iterable or async-iterable source');
  }
  const process = opts.process || processCandidate;

  const results = [];
  const counts = {};
  let processed = 0;
  let stopped = false;
  let error = null;
  let stoppedCandidate = null;

  for await (const candidate of source) {
    let outcome;
    try {
      outcome = await process(candidate, deps);          // exactly one call per yielded candidate; sequential (awaited)
    } catch (e) {
      stopped = true;                                     // unrecoverable error → stop the run
      error = e && e.message ? e.message : String(e);
      stoppedCandidate = candidate;
      break;
    }
    processed++;
    results.push(outcome);
    const key = outcome && outcome.outcome ? outcome.outcome : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }

  return { processed, counts, results, stopped, error, stoppedCandidate };
}

module.exports = { runCandidateSource };
