'use strict';

// Shared DNS collection layer for the legacy scanner (SPF / DKIM / DMARC).
//
// Sprint 3 correctness fix (ADR-SYS-009 implementation programme, SLG-141
// finding). The prior primitive — `try { resolveTxt() } catch { return [] }` —
// collapsed four constitutionally-distinct outcomes into one empty array: a
// genuine absence, a transient timeout, a resolver failure, and an unexpected
// exception all looked identical, and all read downstream as "record absent."
//
// OBS-CONST-001 P-5 / OC-4 (Unknown ≠ Absent) forbids that collapse the moment
// this evidence is persisted as an immutable Observation (P-3): a resolver
// timeout stored as a confirmed absence can never afterwards be corrected
// without leaving the wrong record standing forever. This module makes the
// distinction at the point of collection instead.
//
// This layer OBSERVES; it does not score and does not interpret (P-2). It has no
// knowledge of SPF/DKIM/DMARC semantics — the caller supplies a match predicate.
// It performs exactly the resolution the old primitive performed (same
// dns.promises.resolveTxt, no new timeout mechanism, no new query types); ONLY
// the error handling changes, so no lookup behaviour and no score is altered.

const dnsPromises = require('dns').promises;

// The four canonical collection outcomes an Observation must be able to carry.
// Named to match the Observatory's existing vocabulary (signal_facts_* collection
// status enums) so future Observation persistence consumes them without a second
// translation step.
const OUTCOME = Object.freeze({
  OBSERVED_PRESENT: 'OBSERVED_PRESENT', // we looked, and a matching record exists
  OBSERVED_ABSENT:  'OBSERVED_ABSENT',  // we looked, and no matching record exists
  NOT_OBSERVED:     'NOT_OBSERVED',     // we could not determine (transient/timeout)
  COLLECTION_ERROR: 'COLLECTION_ERROR', // resolver failure or unexpected exception
});

// Query-level outcomes, before any record-matching judgement is applied.
const QUERY = Object.freeze({
  RESOLVED:         'RESOLVED',         // an answer with one or more records
  NO_RECORDS:       'NO_RECORDS',       // authoritative "no such name / no data"
  NOT_OBSERVED:     'NOT_OBSERVED',
  COLLECTION_ERROR: 'COLLECTION_ERROR',
});

// Node/c-ares resolver error codes classified conservatively. Only an
// authoritative "this name/record does not exist" is allowed to mean ABSENT;
// anything transient or resolver-side is NEVER silently treated as absence.
//
//   ENOTFOUND / ENODATA           → the name resolved but carries no such record
//                                    (or the name does not exist) — a real answer
//   ETIMEOUT / ETIMEDOUT / ECANCELLED
//                                 → we did not get an answer in time; the record
//                                    may or may not exist — genuinely unknown
//   everything else (ESERVFAIL, EREFUSED, ECONNREFUSED, EBADRESP, EBADNAME, …)
//                                 → the resolver failed in a way that tells us
//                                    nothing about the record's existence
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NOTFOUND', 'NODATA']);
const NOT_OBSERVED_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECANCELLED']);

// queryTxt(name, resolver?) — perform one TXT lookup and classify the outcome.
// `resolver` is injectable (defaults to dns.promises.resolveTxt) purely so this
// layer is unit-testable without real network; production callers pass nothing
// and get identical resolution behaviour to the old primitive.
//
// → { outcome: QUERY.*, records: string[], errorCode: string|null }
//   records are the joined multi-chunk TXT strings, exactly as the old
//   `.map(r => r.join(''))` produced them — backwards-compatible shape.
async function queryTxt(name, resolver = dnsPromises.resolveTxt) {
  try {
    const raw = await resolver(name);
    const records = (raw || []).map(chunks =>
      Array.isArray(chunks) ? chunks.join('') : String(chunks));
    if (records.length === 0) {
      // A successful query that returned zero records is an authoritative
      // "no TXT here" — an answer, not a failure.
      return { outcome: QUERY.NO_RECORDS, records: [], errorCode: null };
    }
    return { outcome: QUERY.RESOLVED, records, errorCode: null };
  } catch (err) {
    const code = (err && err.code) ? err.code : 'UNKNOWN';
    if (ABSENT_CODES.has(code)) {
      return { outcome: QUERY.NO_RECORDS, records: [], errorCode: code };
    }
    if (NOT_OBSERVED_CODES.has(code)) {
      return { outcome: QUERY.NOT_OBSERVED, records: [], errorCode: code };
    }
    return { outcome: QUERY.COLLECTION_ERROR, records: [], errorCode: code };
  }
}

// presence(queryResult, matchFn) — apply a caller-supplied record-matching
// predicate to a query result and resolve one of the four canonical OUTCOMEs.
// A RESOLVED/NO_RECORDS query means we successfully looked, so the answer is
// PRESENT or ABSENT by whether anything matched; NOT_OBSERVED / COLLECTION_ERROR
// propagate unchanged (we cannot claim absence from a lookup that did not
// complete — the whole point of this module).
//
// → { outcome: OUTCOME.*, matched: string[], records: string[], errorCode }
function presence(queryResult, matchFn) {
  const { outcome, records, errorCode } = queryResult;

  if (outcome === QUERY.NOT_OBSERVED) {
    return { outcome: OUTCOME.NOT_OBSERVED, matched: [], records, errorCode };
  }
  if (outcome === QUERY.COLLECTION_ERROR) {
    return { outcome: OUTCOME.COLLECTION_ERROR, matched: [], records, errorCode };
  }

  // RESOLVED or NO_RECORDS — a completed observation.
  const matched = records.filter(matchFn);
  return {
    outcome: matched.length > 0 ? OUTCOME.OBSERVED_PRESENT : OUTCOME.OBSERVED_ABSENT,
    matched,
    records,
    errorCode,
  };
}

// aggregatePresence(results) — combine several per-probe presence() results
// into one outcome for a signal collected across multiple lookups (DKIM's
// selector probe set). Precedence, worst-truthfulness first:
//   any PRESENT           → OBSERVED_PRESENT (a key was found; absence is moot)
//   else any NOT_OBSERVED  → NOT_OBSERVED    (a probe failed; cannot claim absence)
//   else any ERROR         → COLLECTION_ERROR
//   else                   → OBSERVED_ABSENT (every probe completed and found none —
//                                             a probe-set-bounded absence)
function aggregatePresence(results) {
  if (results.some(r => r.outcome === OUTCOME.OBSERVED_PRESENT)) return OUTCOME.OBSERVED_PRESENT;
  if (results.some(r => r.outcome === OUTCOME.NOT_OBSERVED)) return OUTCOME.NOT_OBSERVED;
  if (results.some(r => r.outcome === OUTCOME.COLLECTION_ERROR)) return OUTCOME.COLLECTION_ERROR;
  return OUTCOME.OBSERVED_ABSENT;
}

module.exports = {
  queryTxt,
  presence,
  aggregatePresence,
  OUTCOME,
  QUERY,
  ABSENT_CODES,
  NOT_OBSERVED_CODES,
};
