'use strict';

// cohort-exclusion-filter.js — skip candidates already in authoritative cohorts.
//
// Population Acquisition Layer. A thin PRE-PROCESSOR filter: given a Companies House
// candidate, decide whether it should enter the acquisition pipeline or be skipped
// because it already exists in an authoritative cohort (Investment Firms or PRA).
//
// Identifier: exclusion runs BEFORE FCA search, so the candidate carries only its CH
// company number and name; the cohort files carry FRN/LEI/name but no CH number — so
// the only shared deterministic link at this stage is the firm NAME. Matching reuses
// the frozen fca-match.normaliseName (exact normalised equality, no fuzzy matching) —
// the same name space the FCA matcher uses — rather than duplicating any logic.
//
// It performs no FCA calls, no lifecycle, and no persistence. A skipped candidate
// never reaches the Candidate Processor, the FCA adapters, the ledger, or the registry.

const fs = require('node:fs');
const { normaliseName } = require('./fca-match');                 // frozen deterministic normaliser (reused)
const { parseCsvLine } = require('./companies-house-source');     // reused CSV line parser

const DECISION = Object.freeze({ PROCESS: 'process', SKIP: 'skip' });
const REASON = Object.freeze({ IF: 'if_cohort', PRA: 'pra_cohort' });

/**
 * Build the exclusion index: sets of normalised cohort firm names.
 * @param {Object} opts - { ifPath?: string, praPaths?: string[] }
 * @returns {{ ifNames: Set<string>, praNames: Set<string> }}
 */
function loadCohortIndex(opts = {}) {
  const ifNames = new Set();
  const praNames = new Set();

  // Investment Firms cohort: a flat CSV with an "Organisation Name" column.
  if (opts.ifPath && fs.existsSync(opts.ifPath)) {
    const lines = fs.readFileSync(opts.ifPath, 'utf8').split(/\r?\n/);
    const header = parseCsvLine(lines[0] || '').map((h) => h.replace(/^﻿/, '').trim());
    const nameIdx = header.indexOf('Organisation Name');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCsvLine(lines[i]);
      const n = normaliseName(nameIdx >= 0 ? cols[nameIdx] : cols[1]);
      if (n) ifNames.add(n);
    }
  }

  // PRA cohort: BoE CSVs with disclaimer/section rows; data rows carry an FRN token
  // and the firm name in the first text column.
  for (const p of (opts.praPaths || [])) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line).map((c) => c.replace(/^﻿/, '').trim());
      if (!cols.some((c) => /^\d{6,7}$/.test(c))) continue;       // no FRN ⇒ disclaimer/header row
      const name = cols.find((c) => c && !/^\d{6,7}$/.test(c) && /[A-Za-z]/.test(c));
      const n = normaliseName(name);
      if (n) praNames.add(n);
    }
  }

  return { ifNames, praNames };
}

/**
 * Create the exclusion filter over a prebuilt index.
 * @param {{ ifNames?: Set<string>, praNames?: Set<string> }} index
 * @returns {(candidate: {companyName:string}) => { decision:string, reason:(string|null) }}
 */
function createCohortExclusionFilter(index = {}) {
  const ifNames = index.ifNames || new Set();
  const praNames = index.praNames || new Set();
  return function filter(candidate) {
    const n = normaliseName(candidate && candidate.companyName);
    if (n && ifNames.has(n)) return { decision: DECISION.SKIP, reason: REASON.IF };
    if (n && praNames.has(n)) return { decision: DECISION.SKIP, reason: REASON.PRA };
    return { decision: DECISION.PROCESS, reason: null };
  };
}

/**
 * Wrap a candidate processor so excluded candidates skip it entirely — never calling
 * FCA search/enrichment, the ledger, or the registry. Skipped candidates return a
 * structured 'skipped_if' / 'skipped_pra' outcome so the runner tallies them.
 * @param {Function} filter - from createCohortExclusionFilter
 * @param {Function} process - the real processCandidate
 */
function withCohortExclusion(filter, process) {
  return async function filteredProcess(candidate, deps) {
    const f = filter(candidate);
    if (f.decision === DECISION.SKIP) {
      return { companyNumber: String(candidate && candidate.companyNumber), outcome: f.reason === REASON.IF ? 'skipped_if' : 'skipped_pra', skipped: true, reason: f.reason };
    }
    return process(candidate, deps);
  };
}

module.exports = { loadCohortIndex, createCohortExclusionFilter, withCohortExclusion, DECISION, REASON };
