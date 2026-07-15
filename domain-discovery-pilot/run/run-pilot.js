#!/usr/bin/env node
'use strict';

// run-pilot.js — CLI orchestrator for the HMRC AML Brave Domain-Discovery
// Pilot. Wires sampling -> prefilter -> (if SEARCHED) query -> Brave ->
// fetch -> extract -> score -> persistence for all sampled candidates,
// sequential, with a simple fixed-delay throttle. Enforces hard caps on
// Brave calls (200), verification fetches (300), and freshness fetches
// (100). Reads the Brave key via dotenv from the repo root .env, exactly as
// commercial-observatory/run/check-search-provider.js does.
//
// Usage:
//   node backend/domain-discovery-pilot/run/run-pilot.js
//
// Never applies the migration itself, never writes to Repository Authority,
// never touches server.js. Persistence is best-effort per-record — a single
// record's persistence failure is logged and does not abort the run.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs = require('fs');
const path = require('path');

const { sampleCandidates } = require('../sampling/sample-candidates');
const { runPrefilter } = require('../prefilter/run-prefilter');
const { buildQueries } = require('../query/query-templates');
const { runBraveQueries } = require('../search/run-brave-queries');
const { fetchCandidatePages } = require('../fetch/fetch-candidate-pages');
const { extractEvidence } = require('../extract/extract-evidence');
const { decide } = require('../match/score-and-decide');
const { categoryKeywords } = require('../sampling/classify-candidate');
const db = require('../persistence/db');

const CAPS = { maxBraveCalls: 200, maxVerificationFetches: 300, maxFreshnessFetches: 100 };
const THROTTLE_MS = Number(process.env.DDP_THROTTLE_MS || 200);

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function defaultOdsPath() {
  return path.join(__dirname, '..', '..', '..', 'datasets', 'hmrc-aml', 'Supervised_Business_Register.ods');
}

async function runPilot({
  odsPath = defaultOdsPath(),
  hmrcAdapter = require('../../pae/adapters/hmrc-aml'),
  client = null,
  throttleMs = THROTTLE_MS,
} = {}) {
  const rawOdsBuffer = fs.readFileSync(odsPath);
  const sampleResult = await sampleCandidates({ rawOdsBuffer, hmrcAdapter, context: { sourceDate: new Date().toISOString() } });

  const domainMemo = new Map(); // normalised domain -> { evidenceList, pages }
  let braveCallsMade = 0;
  let verificationFetchesMade = 0;
  let freshnessFetchesMade = 0;

  const bundle = { candidates: [], prefilterResults: [], braveQueries: [], decisions: [] };

  for (const candidate of sampleResult.candidates) {
    bundle.candidates.push(candidate);
    const candidateInsert = await db.insertCandidate(candidate, { client });
    const candidateId = candidateInsert.success ? candidateInsert.data.id : null;

    const freshnessBudgetRemaining = freshnessFetchesMade < CAPS.maxFreshnessFetches;
    const prefilterDeps = freshnessBudgetRemaining ? {} : { fetchUrl: async () => ({ success: false, errorType: 'budget_exhausted', error: 'freshness fetch cap reached' }) };
    const prefilterResult = await runPrefilter(
      { businessName: candidate.businessName, tradingName: candidate.tradingName, postcode: candidate.postcode },
      prefilterDeps,
    );
    if (prefilterResult.freshnessCheck) freshnessFetchesMade += 1;

    bundle.prefilterResults.push({ candidateId, ...prefilterResult });
    if (candidateId) await db.insertPrefilterResult(candidateId, candidate.hmrcRegistrationNumber, prefilterResult, { client });

    if (prefilterResult.finalBraveDecision === 'SKIPPED') {
      await delay(throttleMs);
      continue;
    }

    const evidenceList = [];
    const queries = buildQueries({ businessName: candidate.businessName, postcode: candidate.postcode });

    if (braveCallsMade + queries.length <= CAPS.maxBraveCalls) {
      const braveResults = await runBraveQueries(queries, {});
      braveCallsMade += queries.length;
      for (const q of braveResults) {
        bundle.braveQueries.push({ candidateId, ...q });
        if (candidateId) await db.insertQuery(candidateId, q, { client });

        for (const result of q.usableResults) {
          const domainKey = result.normalisedDomain;
          if (domainMemo.has(domainKey)) { evidenceList.push(domainMemo.get(domainKey)); continue; }
          if (verificationFetchesMade >= CAPS.maxVerificationFetches) continue;

          const pages = await fetchCandidatePages(domainKey, {});
          verificationFetchesMade += pages.length;
          const bestPage = pages.find((p) => p.extracted) || null;
          if (!bestPage) continue;

          const evidence = extractEvidence(bestPage.extracted, {
            businessName: candidate.businessName,
            categoryKeywords: categoryKeywords(candidate.derivedCategory),
          });
          const entry = { domain: domainKey, evidence, bestPage };
          domainMemo.set(domainKey, entry);
          evidenceList.push(entry);

          if (candidateId) {
            const pageFetchInsert = await db.insertPageFetch(candidateId, null, bestPage, { client });
            if (pageFetchInsert.success) await db.insertEvidence(candidateId, pageFetchInsert.data.id, evidence, { client });
          }
        }
      }
    }

    const decision = decide({ businessName: candidate.businessName, postcode: candidate.postcode }, evidenceList);
    bundle.decisions.push({ candidateId, ...decision });
    if (candidateId) await db.insertDecision(candidateId, decision, { client });

    await delay(throttleMs);
  }

  return { sampleMeta: sampleResult, bundle, usage: { braveCallsMade, verificationFetchesMade, freshnessFetchesMade } };
}

if (require.main === module) {
  runPilot()
    .then((result) => {
      process.stdout.write(`Domain Discovery Pilot run complete.\n`);
      process.stdout.write(`Candidates sampled: ${result.sampleMeta.sampleSize}\n`);
      process.stdout.write(`Brave calls made: ${result.usage.braveCallsMade}\n`);
      process.stdout.write(`Verification fetches: ${result.usage.verificationFetchesMade}\n`);
      process.stdout.write(`Freshness fetches: ${result.usage.freshnessFetchesMade}\n`);
      process.exitCode = 0;
    })
    .catch((err) => {
      process.stderr.write(`Domain Discovery Pilot run failed: ${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { runPilot, CAPS };
