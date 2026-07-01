'use strict';

// resolve-ambiguous.js — Phase 2: postcode tie-breaker resolution of ambiguous companies.
//
// Population Acquisition Layer. Reads every company in the 'ambiguous' terminal state
// from the processing ledger, fetches its CH registered-office postcode (via one CH
// API call per company), and re-runs the candidate through the existing pipeline with
// a postcode-narrowed FCA search:
//
//   postcode-narrowed search: base FCA search by name → for each candidate FRN,
//   fetch firm.address from FCA → keep only candidates whose postcode matches CH.
//   Returns 0, 1, or N hits in the same shape as the base search.
//
//   0 hits  → candidate-processor → no_match  (state: ambiguous → claimed → no_match)
//   1 hit   → candidate-processor → complete  (state: ambiguous → claimed → ... → complete)
//   2+ hits → candidate-processor → ambiguous (state: ambiguous → claimed → ambiguous)
//
// Reuses the entire candidate-processor pipeline unchanged — the only difference is
// the injected fcaSearch function. The processing-state AMBIGUOUS → CLAIMED transition
// (opened in Phase 2) makes the ledger.claim() call succeed for ambiguous companies.
//
// Pacing: 500ms sleep between companies keeps FCA calls well under the 50 req/10s limit
// when combined with the sequential CH call (~520ms floor from CH rate manager) and the
// 150ms inter-candidate address-lookup sleep.
//
// Usage:
//   node resolve-ambiguous.js [--ledger <path>] [--registry <path>] [--limit N]

const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const { openLedger } = require('./processing-ledger');
const { createFcaSearch, createFcaEnrich, createRegistryPersist } = require('./fca-adapters');
const { processCandidate, PROCESS_OUTCOME } = require('./candidate-processor');
const { getChProfile } = require('./ch-address-lookup');
const { STATES } = require('./processing-state');
const fcaClient = require('../collection/sources/fca/fca-client');
const { pathFor } = require('../collection/sources/fca/endpoint-map');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const print = (s) => fs.writeSync(1, s);  // unbuffered write — avoids stdout-to-file buffering on Windows

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

function normalisePostcode(p) {
  return String(p || '').replace(/\s+/g, '').toUpperCase();
}

const MAX_CANDIDATES = 10;    // skip address lookups when FCA returns >10 hits (unresolvable in practice)
const ADDR_TIMEOUT_MS = 3000; // per-candidate firm.address timeout — fail fast on slow FCA responses

/** Fetch all FCA postcodes for an FRN via the firm.address endpoint. */
async function getFcaPostcodes(frn, config) {
  const url = fcaClient.buildUrl(config.baseUrl, pathFor('firm.address', frn));
  const r = await fcaClient.getJson(url, { email: config.email, apiKey: config.apiKey, connectTimeoutMs: 5000, requestTimeoutMs: ADDR_TIMEOUT_MS });
  if (r.errorType !== 'NONE') return [];
  const data = r.body && Array.isArray(r.body.Data) ? r.body.Data : [];
  return data.map((a) => normalisePostcode(a.PostCode || a.Postcode || a.postCode || a.postcode || '')).filter(Boolean);
}

/**
 * Build an FCA search function that narrows multi-candidate results by CH postcode.
 * Short-circuits when >MAX_CANDIDATES hits (unresolvable) or no CH postcode available.
 */
function createPostcodeNarrowedSearch(config, chPostcode) {
  const normCh = normalisePostcode(chPostcode);
  const baseSearch = createFcaSearch({ config });
  return async function fcaSearchNarrowed(name) {
    const candidates = await baseSearch(name);
    if (!normCh || candidates.length <= 1) return candidates;
    if (candidates.length > MAX_CANDIDATES) return candidates; // too many — stays ambiguous, no address calls
    const filtered = [];
    for (const c of candidates) {
      await sleep(150);
      const fcaPostcodes = await getFcaPostcodes(c.frn, config);
      if (fcaPostcodes.some((p) => p === normCh)) filtered.push(c);
    }
    return filtered;
  };
}

async function main() {
  const runDir = path.join(__dirname, 'runs', 'fca');
  const ledgerPath = arg('--ledger', path.join(runDir, 'ledger.ndjson'));
  const registryPath = arg('--registry', path.join(runDir, 'registry.ndjson'));
  const limit = arg('--limit') ? parseInt(arg('--limit'), 10) : null;

  const config = fcaClient.loadConfig();
  const { ok, errors } = fcaClient.validateConfig(config);
  if (!ok) { console.error('FCA config invalid:', errors.join('; ')); process.exit(2); }

  const chApiKey = process.env.CH_API_KEY || process.env.COMPANIES_HOUSE_API_KEY;
  if (!chApiKey) { console.error('CH_API_KEY or COMPANIES_HOUSE_API_KEY required for postcode lookup'); process.exit(2); }

  const ledger = openLedger({ path: ledgerPath });
  const fcaEnrich = createFcaEnrich({ config });
  const persist = createRegistryPersist({ path: registryPath });

  // Recover claims orphaned by an interrupted Phase 2 run: a company whose current
  // state is 'claimed' with 'ambiguous' as the immediately preceding state was
  // re-claimed for resolution but never reached a terminal outcome. Revert it to
  // 'ambiguous' (a legal claimed → ambiguous transition) so it re-enters this run.
  let recovered = 0;
  for (const cn of ledger.companyNumbers()) {
    if (ledger.getState(cn) !== STATES.CLAIMED) continue;
    const events = ledger.history(cn);
    const prev = events[events.length - 2];
    if (prev && prev.state === STATES.AMBIGUOUS) {
      ledger.update(cn, STATES.AMBIGUOUS);
      recovered++;
    }
  }
  if (recovered) print(`recovered ${recovered} claim(s) orphaned by a prior interrupted run\n`);

  // Enumerate all ambiguous companies
  let ambiguous = ledger.companyNumbers().filter((cn) => ledger.getState(cn) === STATES.AMBIGUOUS);
  if (limit) ambiguous = ambiguous.slice(0, limit);

  print(`Phase 2 — Ambiguous Resolution\n  total ambiguous : ${ambiguous.length}${limit ? ` (limit ${limit})` : ''}\n\n`);

  const counts = { resolved: 0, still_ambiguous: 0, no_match: 0, discarded: 0, failed: 0, ch_failed: 0, skipped: 0 };
  const t0 = Date.now();

  for (let i = 0; i < ambiguous.length; i++) {
    const cn = ambiguous[i];

    if ((i + 1) % 100 === 0) {
      const pct = (((i + 1) / ambiguous.length) * 100).toFixed(0);
      print(
        `[${i + 1}/${ambiguous.length} ${pct}%] resolved:${counts.resolved} still_ambiguous:${counts.still_ambiguous} no_match:${counts.no_match} failed:${counts.failed}\n`,
      );
    }

    // 1. Fetch CH company profile (name + postcode) — one CH call per company.
    let profile;
    try {
      profile = await getChProfile(cn, { apiKey: chApiKey });
    } catch (e) {
      counts.ch_failed++;
      continue; // CH failed — leave as ambiguous, no ledger change
    }
    if (!profile.companyName) { counts.skipped++; continue; }

    // 2. Re-run through the pipeline with a postcode-narrowed FCA search.
    const narrowedSearch = createPostcodeNarrowedSearch(config, profile.postcode);
    const deps = { ledger, fcaSearch: narrowedSearch, fcaEnrich, persist };
    const result = await processCandidate({ companyNumber: cn, companyName: profile.companyName }, deps);

    if (result.outcome === PROCESS_OUTCOME.ACQUIRED)       counts.resolved++;
    else if (result.outcome === PROCESS_OUTCOME.AMBIGUOUS) counts.still_ambiguous++;
    else if (result.outcome === PROCESS_OUTCOME.NO_MATCH)  counts.no_match++;
    else if (result.outcome === PROCESS_OUTCOME.DISCARDED) counts.discarded++;
    else if (result.outcome === PROCESS_OUTCOME.FAILED)    counts.failed++;
    else counts.skipped++;

    await sleep(500); // pace between companies (FCA 50 req/10s budget)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  print(
    [
      '',
      'Phase 2 Resolution Summary',
      `  total ambiguous    : ${ambiguous.length}`,
      `  resolved (acquired): ${counts.resolved}`,
      `  still ambiguous    : ${counts.still_ambiguous}`,
      `  no match           : ${counts.no_match}`,
      `  discarded          : ${counts.discarded}`,
      `  failed             : ${counts.failed}`,
      `  CH profile failed  : ${counts.ch_failed}`,
      `  skipped            : ${counts.skipped}`,
      `  elapsed            : ${elapsed}s`,
      `  ledger             : ${ledgerPath}`,
      `  registry           : ${registryPath}`,
      '',
    ].join('\n') + '\n',
  );
}

main().catch((e) => { console.error('resolve-ambiguous failed:', e.message); process.exit(1); });
